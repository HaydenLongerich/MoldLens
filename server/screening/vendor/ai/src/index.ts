import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { AREAS, CONCERNS, labelFor, VisionResultSchema, type AreaId, type ConcernId, type VisionResult } from "@mb/domain";
import { log } from "@mb/observability";
import { checkOpenAI, OPENAI_DEFAULT_MODEL, OpenAITextModel, OpenAIVisionModel } from "./openai";
import { SUMMARY_SYSTEM, VISION_SYSTEM, visionIntro } from "./prompts";

/**
 * Provider-agnostic model interfaces (PLAN §7.3). The pipeline depends only on these
 * interfaces. Models get images, approved enums and approved question texts only:
 * never free-text customer statements, DB access, or side-effecting tools.
 */

export interface VisionFrameInput {
  frameId: string;
  image: Buffer; // JPEG, already downscaled
  /** Human-readable source position, e.g. "Video 1 at 0:42" or "Photo 2". */
  sourceLabel: string;
}

export interface CandidateQuestion {
  id: string;
  text: string;
}

export interface VisionRequest {
  frames: VisionFrameInput[];
  areas: AreaId[];
  concerns: ConcernId[];
  budgetUsd: number;
  /** Approved follow-up questions the rules consider eligible; the model may only rank these. */
  candidateQuestions?: CandidateQuestion[];
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  images: number;
  costUsd: number;
}

export interface VisionResponse {
  result: VisionResult;
  usage: ModelUsage;
  provider: string;
  model: string;
  promptVersion: string;
  /** True when output came from a non-AI placeholder; reports must say so. */
  isMock: boolean;
}

export interface VisionModel {
  readonly provider: string;
  readonly model: string;
  observe(req: VisionRequest): Promise<VisionResponse>;
}

/** Facts the summary writer may use. All of it is already validated, rule-produced content. */
export interface SummaryInput {
  outcome: string;
  priority: string;
  findings: { area: string; statement: string; strength: string | null }[];
  reportedConcerns: string[];
  answers: { question: string; answer: string }[];
  unknowns: string[];
}

export const SummarySchema = z.object({
  headline: z.string().max(160).describe("One plain-language sentence summarising what the media and answers show"),
  points: z.array(z.string().max(220)).min(2).max(4).describe("2 to 4 short plain-language points"),
});
export type Summary = z.infer<typeof SummarySchema>;

export interface SummaryResponse {
  summary: Summary;
  usage: ModelUsage;
  provider: string;
  model: string;
  promptVersion: string;
}

export interface TextModel {
  readonly provider: string;
  readonly model: string;
  summarize(input: SummaryInput): Promise<SummaryResponse>;
}

export class ModelError extends Error {
  constructor(
    readonly code: "refusal" | "truncated" | "invalid_output" | "budget_exceeded" | "provider_error" | "not_configured",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export const VISION_PROMPT_VERSION = "vision-v2";
export const SUMMARY_PROMPT_VERSION = "summary-v1";

// Price per million tokens (USD). Source: Anthropic pricing as cached 2026-10-06. Verify before relying on it.
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? PRICING["claude-opus-5-5"]!;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

function classify(e: unknown): ModelError {
  if (e instanceof ModelError) return e;
  const error = e as { status?: number; name?: string } | null;
  if ([401, 403, 404].includes(error?.status ?? 0)) return new ModelError("not_configured", "AI model not configured: Anthropic credentials or model access was rejected.", false);
  if (error?.status === 429 || (error?.status ?? 0) >= 500 || /Connection|Timeout|Abort/.test(error?.name ?? "")) return new ModelError("provider_error", "The AI provider is temporarily unavailable. Please try again.", true);
  if (typeof error?.status === "number") return new ModelError("provider_error", "The AI provider rejected the screening request.", false);
  return new ModelError("invalid_output", e instanceof Error ? e.message : String(e), false);
}

function usageOf(model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }, images: number): ModelUsage {
  return {
    inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens,
    images,
    costUsd: estimateCost(model, u.input_tokens, u.output_tokens),
  };
}


/**
 * One structured call: Claude with a JSON-schema output format, then our own checks.
 * Stop reason is checked BEFORE parsing so refusals and truncation are reported accurately,
 * and the JSON is validated again with Zod (never trust unvalidated model output).
 */
async function callStructured<T>(
  client: Anthropic,
  params: { model: string; max_tokens: number; system: string; effort: "low" | "medium" | "high"; messages: Anthropic.Beta.BetaMessageParam[] },
  schema: z.ZodType<T>,
): Promise<{ data: T; model: string; usage: Anthropic.Beta.BetaUsage }> {
  let response: Anthropic.Beta.BetaMessage;
  try {
    const { betaZodOutputFormat } = await import("@anthropic-ai/sdk/helpers/beta/zod");
    response = (await client.beta.messages.create({
      model: params.model,
      max_tokens: params.max_tokens,
      system: params.system,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: params.effort, format: betaZodOutputFormat(schema) },
      messages: params.messages,
    }, { signal: AbortSignal.timeout(180_000) })) as Anthropic.Beta.BetaMessage;
  } catch (e) {
    throw classify(e);
  }
  if (response.stop_reason === "refusal") throw new ModelError("refusal", "Model declined the request", false);
  if (response.stop_reason === "max_tokens") throw new ModelError("truncated", "Model output truncated", true);
  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ModelError("invalid_output", "Model output was not valid JSON", true);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ModelError("invalid_output", `Model output failed schema: ${parsed.error.issues[0]?.message ?? "unknown"}`, true);
  return { data: parsed.data, model: response.model ?? params.model, usage: response.usage };
}

async function defaultClient(env: Record<string, string | undefined> = process.env): Promise<Anthropic> {
  try {
    const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
    return new AnthropicClient({ apiKey: env.ANTHROPIC_API_KEY, authToken: env.ANTHROPIC_AUTH_TOKEN, maxRetries: 2, timeout: 120_000 });
  } catch {
    throw new ModelError("not_configured", "AI model not configured: install the Anthropic screening dependency and set ANTHROPIC_API_KEY.", false);
  }
}

/** Claude vision adapter: structured outputs + server-side refusal fallback. */
export class AnthropicVisionModel implements VisionModel {
  readonly provider = "anthropic";
  private client?: Anthropic;

  constructor(
    readonly model: string = process.env.AI_VISION_MODEL || "claude-opus-5-5",
    client?: Anthropic,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.client = client;
  }

  async observe(req: VisionRequest): Promise<VisionResponse> {
    if (!req.frames.length || req.frames.length > 24 || req.frames.some(frame => frame.image.length > 2 * 1024 * 1024)) {
      throw new ModelError("budget_exceeded", "The screening exceeds the image processing limits.", false);
    }
    // Short aliases (F1..Fn) keep IDs out of the model's hands; we map back and drop unknowns.
    const aliasToId = new Map<string, string>();
    const candidates = req.candidateQuestions ?? [];
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      {
        type: "text",
        text: visionIntro(req),
      },
    ];
    req.frames.forEach((f, i) => {
      const alias = `F${i + 1}`;
      aliasToId.set(alias, f.frameId);
      content.push({ type: "text", text: `Frame ${alias} (${f.sourceLabel}):` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.image.toString("base64") } });
    });

    const { data: parsed, model: served, usage: rawUsage } = await callStructured(
      this.client ??= await defaultClient(this.env),
      { model: this.model, max_tokens: 16000, system: VISION_SYSTEM, effort: "medium", messages: [{ role: "user", content }] },
      VisionResultSchema,
    );

    const candidateIds = new Set(candidates.map((q) => q.id));
    const result: VisionResult = {
      observations: parsed.observations.filter((o) => aliasToId.has(o.frameId)).map((o) => ({ ...o, frameId: aliasToId.get(o.frameId)! })),
      frames: parsed.frames.filter((f) => aliasToId.has(f.frameId)).map((f) => ({ ...f, frameId: aliasToId.get(f.frameId)! })),
      overallLimitations: parsed.overallLimitations,
      // The model may only rank approved candidates; anything else is discarded.
      questionPriority: parsed.questionPriority.filter((id) => candidateIds.has(id)).slice(0, 3),
    };
    const dropped = parsed.observations.length - result.observations.length;
    if (dropped > 0) log.warn("vision.dropped_unknown_frame_refs", { dropped });
    const usage = usageOf(served, rawUsage, req.frames.length);
    if (usage.costUsd > req.budgetUsd) log.warn("vision.over_budget", { costUsd: usage.costUsd, budgetUsd: req.budgetUsd });
    return { result, usage, provider: this.provider, model: served, promptVersion: VISION_PROMPT_VERSION, isMock: false };
  }
}

/** Claude summary writer. Output still passes the deterministic claims gate before use. */
export class AnthropicTextModel implements TextModel {
  readonly provider = "anthropic";
  private client?: Anthropic;

  constructor(
    readonly model: string = process.env.AI_TEXT_MODEL || "claude-opus-5-5",
    client?: Anthropic,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.client = client;
  }

  async summarize(input: SummaryInput): Promise<SummaryResponse> {
    const { data, model: served, usage } = await callStructured(
      this.client ??= await defaultClient(this.env),
      { model: this.model, max_tokens: 4000, system: SUMMARY_SYSTEM, effort: "low", messages: [{ role: "user", content: `Facts (JSON):
${JSON.stringify(input, null, 2)}` }] },
      SummarySchema,
    );
    return { summary: data, usage: usageOf(served, usage, 0), provider: this.provider, model: served, promptVersion: SUMMARY_PROMPT_VERSION };
  }
}

/**
 * Offline placeholder. NOT AI. Only used when AI_PROVIDER=mock is set explicitly
 * (tests, offline demos). Flags darker regions on lighter surfaces; labelled as such.
 */
export class MockVisionModel implements VisionModel {
  readonly provider = "mock";
  readonly model = "pixel-heuristic-v1";

  async observe(req: VisionRequest): Promise<VisionResponse> {
    let sharp;
    try { sharp = (await import("sharp")).default; }
    catch { throw new ModelError("not_configured", "AI model not configured: mock screening requires the sharp media dependency.", false); }
    const observations: VisionResult["observations"] = [];
    const frames: VisionResult["frames"] = [];
    for (const f of req.frames) {
      const { data, info } = await sharp(f.image).greyscale().resize(64, 64, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
      const n = info.width * info.height;
      const mean = data.reduce((s, v) => s + v, 0) / n;
      if (mean < 45) {
        frames.push({ frameId: f.frameId, usable: false, issue: "Frame too dark for the heuristic", privacyConcern: false });
        continue;
      }
      frames.push({ frameId: f.frameId, usable: true, issue: null, privacyConcern: false }); // heuristic cannot detect people
      let dark = 0;
      let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
      for (let i = 0; i < n; i++) {
        if (data[i]! < mean - 55) {
          dark++;
          const x = i % info.width, y = Math.floor(i / info.width);
          minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
      }
      const region = maxX >= 0 ? { x: minX / info.width, y: minY / info.height, width: (maxX - minX + 1) / info.width, height: (maxY - minY + 1) / info.height } : null;
      const frac = dark / n;
      if (mean > 110 && frac > 0.01 && frac < 0.3) {
        observations.push({
          frameId: f.frameId,
          category: "discoloration",
          location: "region of frame (automated heuristic)",
          neutralDescription: "[Demo heuristic, not AI] Darker irregular areas stand out against a lighter surface in this frame.",
          visibility: "limited",
          strength: "weak",
          alternativeExplanations: ["Shadows or lighting", "Dust, soot or dirt", "Surface texture or pattern"],
          limitations: ["Pixel heuristic only. It has no understanding of materials or components."],
          region,
        });
      }
    }
    return {
      result: {
        observations,
        frames,
        overallLimitations: ["Demo mode: no AI vision model was used. Observations come from a simple pixel heuristic."],
        questionPriority: [],
      },
      usage: { inputTokens: 0, outputTokens: 0, images: req.frames.length, costUsd: 0 },
      provider: this.provider,
      model: this.model,
      promptVersion: "mock-v1",
      isMock: true,
    };
  }
}

/** Fails every call with a clear, non-retryable error. Used when the real model isn't configured. */
class UnconfiguredModel implements VisionModel, TextModel {
  readonly model = "not-configured";
  constructor(
    readonly provider: string,
    private readonly keyVar: string,
  ) {}
  private fail(): never {
    throw new ModelError("not_configured", `AI model not configured: set ${this.keyVar} in .env (or AI_PROVIDER=mock for offline demos)`, false);
  }
  async observe(): Promise<VisionResponse> {
    this.fail();
  }
  async summarize(): Promise<SummaryResponse> {
    this.fail();
  }
}

export type ProviderId = "openai" | "anthropic" | "mock";

export interface AiStatus {
  provider: ProviderId;
  configured: boolean;
  keyVar: string;
  visionModel: string;
  textModel: string;
}

/** Provider is chosen by AI_PROVIDER (openai | anthropic | mock). Default: openai. */
export function aiStatus(env: Record<string, string | undefined> = process.env): AiStatus {
  const raw = (env.AI_PROVIDER || "openai").toLowerCase();
  if (!["openai", "anthropic", "mock"].includes(raw)) {
    return { provider: "openai", configured: false, keyVar: "AI_PROVIDER", visionModel: "unsupported-provider", textModel: "unsupported-provider" };
  }
  const provider: ProviderId = raw === "anthropic" || raw === "mock" ? raw : "openai";
  if (provider === "mock") return { provider, configured: true, keyVar: "-", visionModel: "pixel-heuristic-v1", textModel: "none" };
  if (provider === "anthropic") {
    return {
      provider,
      configured: !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
      keyVar: "ANTHROPIC_API_KEY",
      visionModel: env.AI_VISION_MODEL || "claude-opus-5-5",
      textModel: env.AI_TEXT_MODEL || "claude-opus-5-5",
    };
  }
  return {
    provider,
    configured: !!env.OPENAI_API_KEY,
    keyVar: "OPENAI_API_KEY",
    visionModel: env.OPENAI_VISION_MODEL || OPENAI_DEFAULT_MODEL,
    textModel: env.OPENAI_TEXT_MODEL || OPENAI_DEFAULT_MODEL,
  };
}

export function getVisionModel(env: Record<string, string | undefined> = process.env): VisionModel {
  const s = aiStatus(env);
  if (s.provider === "mock") return new MockVisionModel();
  if (!s.configured) return new UnconfiguredModel(s.provider, s.keyVar);
  return s.provider === "openai" ? new OpenAIVisionModel(s.visionModel, undefined, env) : new AnthropicVisionModel(s.visionModel, undefined, env);
}

/** Returns null in mock mode (the deterministic summary is used). */
export function getTextModel(env: Record<string, string | undefined> = process.env): TextModel | null {
  const s = aiStatus(env);
  if (s.provider === "mock") return null;
  if (!s.configured) return new UnconfiguredModel(s.provider, s.keyVar);
  return s.provider === "openai" ? new OpenAITextModel(s.textModel, undefined, env) : new AnthropicTextModel(s.textModel, undefined, env);
}

/** Minimal live call used by `pnpm ai:check`. */
export async function checkConnection(env: Record<string, string | undefined> = process.env) {
  const s = aiStatus(env);
  if (s.provider === "mock") return { ok: true, detail: "AI_PROVIDER=mock (no live model)" };
  if (!s.configured) return { ok: false, detail: `${s.keyVar} is not set` };
  if (s.provider === "openai") return checkOpenAI(s.visionModel, env);
  try {
    const r = await (await defaultClient(env)).messages.create({ model: s.visionModel, max_tokens: 64, messages: [{ role: "user", content: "Reply with the single word: ready" }] });
    const text = r.content.find((b) => b.type === "text");
    return { ok: true, detail: `${r.model} replied "${text && "text" in text ? text.text.trim() : ""}" (${r.usage.input_tokens} in / ${r.usage.output_tokens} out tokens)` };
  } catch (e) {
    return { ok: false, detail: classify(e).message };
  }
}

export { OPENAI_DEFAULT_MODEL, OpenAIVisionModel, OpenAITextModel } from "./openai";
