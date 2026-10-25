import type OpenAI from "openai";
import { z } from "zod/v4";
import { VisionResultSchema, type VisionResult } from "@mb/domain";
import { log } from "@mb/observability";
import {
  ModelError,
  SummarySchema,
  type ModelUsage,
  type SummaryInput,
  type SummaryResponse,
  type TextModel,
  type VisionModel,
  type VisionRequest,
  type VisionResponse,
} from "./index";
import { SUMMARY_SYSTEM, VISION_SYSTEM, visionIntro } from "./prompts";

/**
 * OpenAI adapter (Chat Completions + strict JSON-schema structured outputs).
 * Same prompts, schemas and safety handling as the Claude adapter.
 */

export const OPENAI_DEFAULT_MODEL = "gpt-4.1";

// USD per million tokens. Defaults are gpt-4.1 list prices as last known; override in .env and verify.
function pricing(env: Record<string, string | undefined>) {
  const price = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return value !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    input: price(env.OPENAI_PRICE_INPUT_PER_MTOK, 2),
    output: price(env.OPENAI_PRICE_OUTPUT_PER_MTOK, 8),
  };
}

type Json = Record<string, unknown>;

/** Strict mode wants every property required and no unsupported keywords; we enforce limits after parsing. */
function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== "object") return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (["$schema", "maxLength", "minLength", "maxItems", "minItems", "format", "pattern"].includes(k)) continue;
    out[k] = strictSchema(v);
  }
  if (out.type === "object" && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as Json);
  }
  return out;
}

/** Trim over-long strings and arrays to the original schema limits so validation doesn't fail on verbosity. */
function clamp(value: unknown, schema: Json | undefined): unknown {
  if (!schema) return value;
  if (Array.isArray(schema.anyOf)) {
    const branch = (schema.anyOf as Json[]).find((b) => (value === null ? b.type === "null" : b.type !== "null"));
    return clamp(value, branch);
  }
  if (typeof value === "string" && typeof schema.maxLength === "number") return value.slice(0, schema.maxLength);
  if (Array.isArray(value)) {
    const items = value.map((v) => clamp(v, schema.items as Json | undefined));
    return typeof schema.maxItems === "number" ? items.slice(0, schema.maxItems) : items;
  }
  if (value && typeof value === "object" && schema.properties) {
    const props = schema.properties as Record<string, Json>;
    return Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, clamp(v, props[k])]));
  }
  return value;
}

function classify(e: unknown): ModelError {
  if (e instanceof ModelError) return e;
  const error = e as { status?: number; name?: string } | null;
  if ([401, 403, 404].includes(error?.status ?? 0)) return new ModelError("not_configured", "AI model not configured: OpenAI credentials or model access was rejected.", false);
  if (error?.status === 429 || (error?.status ?? 0) >= 500 || /Connection|Timeout|Abort/.test(error?.name ?? "")) return new ModelError("provider_error", "The AI provider is temporarily unavailable. Please try again.", true);
  if (typeof error?.status === "number") return new ModelError("provider_error", "The AI provider rejected the screening request.", false);
  return new ModelError("invalid_output", e instanceof Error ? e.message : String(e), false);
}

async function createClient(env: Record<string, string | undefined>): Promise<OpenAI> {
  try {
    const { default: OpenAIClient } = await import("openai");
    return new OpenAIClient({ apiKey: env.OPENAI_API_KEY, maxRetries: 2, timeout: 120_000 });
  } catch {
    throw new ModelError("not_configured", "AI model not configured: install the OpenAI screening dependency and set OPENAI_API_KEY.", false);
  }
}

async function callStructured<T>(
  client: OpenAI,
  args: { model: string; maxTokens: number; system: string; user: OpenAI.Chat.ChatCompletionContentPart[] | string; name: string; images: number },
  schema: z.ZodType<T>,
  env: Record<string, string | undefined>,
): Promise<{ data: T; model: string; usage: ModelUsage }> {
  const jsonSchema = z.toJSONSchema(schema) as Json;
  let completion: OpenAI.Chat.ChatCompletion;
  try {
    completion = await client.chat.completions.create({
      model: args.model,
      max_completion_tokens: args.maxTokens,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      response_format: { type: "json_schema", json_schema: { name: args.name, strict: true, schema: strictSchema(jsonSchema) as Json } },
    }, { signal: AbortSignal.timeout(args.images ? 180_000 : 90_000) });
  } catch (e) {
    throw classify(e);
  }
  const choice = completion.choices[0];
  if (!choice) throw new ModelError("invalid_output", "No completion returned", true);
  if (choice.message.refusal) throw new ModelError("refusal", "Model declined the request", false);
  if (choice.finish_reason === "length") throw new ModelError("truncated", "Model output truncated", true);
  if (choice.finish_reason === "content_filter") throw new ModelError("refusal", "Output blocked by content filter", false);
  let json: unknown;
  try {
    json = JSON.parse(choice.message.content ?? "");
  } catch {
    throw new ModelError("invalid_output", "Model output was not valid JSON", true);
  }
  const parsed = schema.safeParse(clamp(json, jsonSchema));
  if (!parsed.success) throw new ModelError("invalid_output", `Model output failed schema: ${parsed.error.issues[0]?.message ?? "unknown"}`, true);
  const p = pricing(env);
  const inTok = completion.usage?.prompt_tokens ?? 0;
  const outTok = completion.usage?.completion_tokens ?? 0;
  return {
    data: parsed.data,
    model: completion.model ?? args.model,
    usage: { inputTokens: inTok, outputTokens: outTok, images: args.images, costUsd: (inTok * p.input + outTok * p.output) / 1_000_000 },
  };
}

export const OPENAI_VISION_PROMPT_VERSION = "vision-v2-openai";
export const OPENAI_SUMMARY_PROMPT_VERSION = "summary-v1-openai";

export class OpenAIVisionModel implements VisionModel {
  readonly provider = "openai";
  private client?: OpenAI;
  constructor(
    readonly model: string = OPENAI_DEFAULT_MODEL,
    client?: OpenAI,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.client = client;
  }

  async observe(req: VisionRequest): Promise<VisionResponse> {
    if (!req.frames.length || req.frames.length > 24 || req.frames.some(frame => frame.image.length > 2 * 1024 * 1024)) {
      throw new ModelError("budget_exceeded", "The screening exceeds the image processing limits.", false);
    }
    const aliasToId = new Map<string, string>();
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: "text", text: visionIntro(req) }];
    req.frames.forEach((f, i) => {
      const alias = `F${i + 1}`;
      aliasToId.set(alias, f.frameId);
      content.push({ type: "text", text: `Frame ${alias} (${f.sourceLabel}):` });
      content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${f.image.toString("base64")}`, detail: "high" } });
    });
    const { data: parsed, model, usage } = await callStructured(
      this.client ??= await createClient(this.env),
      { model: this.model, maxTokens: 8000, system: VISION_SYSTEM, user: content, name: "vision_result", images: req.frames.length },
      VisionResultSchema,
      this.env,
    );
    const candidateIds = new Set((req.candidateQuestions ?? []).map((q) => q.id));
    const result: VisionResult = {
      observations: parsed.observations.filter((o) => aliasToId.has(o.frameId)).map((o) => ({ ...o, frameId: aliasToId.get(o.frameId)! })),
      frames: parsed.frames.filter((f) => aliasToId.has(f.frameId)).map((f) => ({ ...f, frameId: aliasToId.get(f.frameId)! })),
      overallLimitations: parsed.overallLimitations,
      questionPriority: parsed.questionPriority.filter((id) => candidateIds.has(id)).slice(0, 3),
    };
    const dropped = parsed.observations.length - result.observations.length;
    if (dropped > 0) log.warn("vision.dropped_unknown_frame_refs", { dropped });
    if (usage.costUsd > req.budgetUsd) log.warn("vision.over_budget", { costUsd: usage.costUsd, budgetUsd: req.budgetUsd });
    return { result, usage, provider: this.provider, model, promptVersion: OPENAI_VISION_PROMPT_VERSION, isMock: false };
  }
}

export class OpenAITextModel implements TextModel {
  readonly provider = "openai";
  private client?: OpenAI;
  constructor(
    readonly model: string = OPENAI_DEFAULT_MODEL,
    client?: OpenAI,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.client = client;
  }

  async summarize(input: SummaryInput): Promise<SummaryResponse> {
    const { data, model, usage } = await callStructured(
      this.client ??= await createClient(this.env),
      { model: this.model, maxTokens: 1500, system: SUMMARY_SYSTEM, user: `Facts (JSON):\n${JSON.stringify(input, null, 2)}`, name: "summary", images: 0 },
      SummarySchema,
      this.env,
    );
    return { summary: data, usage, provider: this.provider, model, promptVersion: OPENAI_SUMMARY_PROMPT_VERSION };
  }
}

/** One tiny live request, used only when explicitly requested by an operator. */
export async function checkOpenAI(model: string, env: Record<string, string | undefined> = process.env): Promise<{ ok: boolean; detail: string }> {
  try {
    const client = await createClient(env);
    const r = await client.chat.completions.create({ model, max_completion_tokens: 16, messages: [{ role: "user", content: "Reply with the single word: ready" }] });
    return { ok: true, detail: `${r.model} replied "${(r.choices[0]?.message.content ?? "").trim()}" (${r.usage?.prompt_tokens ?? 0} in / ${r.usage?.completion_tokens ?? 0} out tokens)` };
  } catch (e) {
    const err = classify(e);
    return { ok: false, detail: err.message };
  }
}
