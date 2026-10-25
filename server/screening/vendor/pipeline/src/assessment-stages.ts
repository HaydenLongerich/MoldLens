import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import { getTextModel, getVisionModel, ModelError, VISION_PROMPT_VERSION, type SummaryInput, type TextModel, type VisionModel } from "@mb/ai";
import {
  answers,
  assessmentRuns,
  assessments,
  audit,
  concerns,
  customerProfiles,
  enqueue,
  findings,
  mediaAssets,
  mediaFrames,
  observations,
  outbox,
  pendingQuestions,
  properties,
  reportVersions,
  uploadSessions,
  type Db,
} from "@mb/db";
import {
  assertAssessmentTransition,
  POLICY_VERSION,
  QUESTION_BANK,
  QUESTION_BANK_VERSION,
  sanitizeRegion,
  selectFollowups,
  type AreaId,
  type AssessmentStatus,
  type ConcernId,
  type ObservationCategory,
} from "@mb/domain";
import { visionImage } from "@mb/media";
import { currentTrace, log } from "@mb/observability";
import { RULE_VERSION, sanitizeSnapshot, synthesizeReport, validateReport, type ReportContent, type ReportInputSnapshot } from "@mb/reporting";
import type { ObjectStore } from "@mb/storage";
import type { PipelineConfig } from "./config";

export class ConcurrencyConflict extends Error {}
export class DeferError extends Error {
  constructor(
    readonly delayMs: number,
    reason: string,
  ) {
    super(reason);
  }
}

/** Compare-and-set status transition guarded by the domain state machine. */
export async function transitionAssessment(db: Db, id: string, from: AssessmentStatus, to: AssessmentStatus, extra: Partial<typeof assessments.$inferInsert> = {}) {
  assertAssessmentTransition(from, to);
  const rows = await db
    .update(assessments)
    .set({ ...extra, status: to, updatedAt: new Date(), version: sql`${assessments.version} + 1` })
    .where(and(eq(assessments.id, id), eq(assessments.status, from)))
    .returning({ id: assessments.id });
  if (rows.length !== 1) throw new ConcurrencyConflict(`assessment ${id} not in status ${from}`);
}

const PENDING_MEDIA = ["uploading", "quarantined", "validated", "processing"];

function frameLabel(kind: string, index: number) {
  return kind === "video" ? `Video ${index}` : `Photo ${index}`;
}

async function assetLabels(db: Db, assessmentId: string) {
  const assets = await db.select().from(mediaAssets).where(eq(mediaAssets.assessmentId, assessmentId)).orderBy(asc(mediaAssets.createdAt));
  const counters: Record<string, number> = {};
  const labels = new Map<string, string>();
  for (const a of assets) {
    counters[a.kind] = (counters[a.kind] ?? 0) + 1;
    labels.set(a.id, frameLabel(a.kind, counters[a.kind]!));
  }
  return { assets, labels };
}

type FrameRow = typeof mediaFrames.$inferSelect;

/** Bounded, deterministic frame choice across ready assets (round-robin by sharpness). */
async function chooseFrames(db: Db, cfg: PipelineConfig, assets: (typeof mediaAssets.$inferSelect)[], labels: Map<string, string>): Promise<FrameRow[]> {
  const readyIds = assets.filter((x) => x.status === "ready").map((x) => x.id);
  const frames = readyIds.length
    ? await db
        .select()
        .from(mediaFrames)
        .where(and(inArray(mediaFrames.assetId, readyIds), eq(mediaFrames.selected, true)))
        .orderBy(desc(mediaFrames.sharpness))
    : [];
  const perAsset = new Map<string, FrameRow[]>();
  for (const f of frames) if (!f.qualityFlags.includes("privacy_review")) perAsset.set(f.assetId, [...(perAsset.get(f.assetId) ?? []), f]);
  const chosen: FrameRow[] = [];
  while (chosen.length < cfg.maxFramesPerRun && [...perAsset.values()].some((l) => l.length)) {
    for (const list of perAsset.values()) {
      const f = list.shift();
      if (f && chosen.length < cfg.maxFramesPerRun) chosen.push(f);
    }
  }
  chosen.sort((x, y) => (labels.get(x.assetId) ?? "").localeCompare(labels.get(y.assetId) ?? "") || (x.timestampMs ?? 0) - (y.timestampMs ?? 0));
  return chosen;
}

/** Identifies the exact frame set a vision run looked at, so a run can be reused safely. */
function frameSignature(frames: FrameRow[]): string {
  return createHash("sha256").update(frames.map((f) => f.id).sort().join(",")).digest("hex").slice(0, 24);
}

type RunConfig = { model?: string; requestedModel?: string; requestPromptVersion?: string; isMock?: boolean; early?: boolean; frameSignature?: string; questionPriority?: string[] };
type AssessmentSerializer = <T>(id: string, work: () => Promise<T>) => Promise<T>;

/** One vision call + persistence of observations. Returns the model's question ranking (real models only). */
async function runVision(
  db: Db,
  store: ObjectStore,
  cfg: PipelineConfig,
  a: typeof assessments.$inferSelect,
  model: VisionModel,
  chosen: FrameRow[],
  labels: Map<string, string>,
  ctx: { areas: AreaId[]; concerns: ConcernId[]; candidateQuestions: { id: string; text: string }[]; early: boolean; serialize?: AssessmentSerializer },
): Promise<{ ranking: string[] | undefined; categories: ObservationCategory[]; discarded?: boolean }> {
  const mutate = <T>(work: () => Promise<T>) => ctx.serialize ? ctx.serialize(a.id, work) : work();
  const signature = frameSignature(chosen);
  const requestedModel = model.model;
  async function inputsStillCurrent(runId?: string) {
    if (!ctx.early) return true;
    const [current] = await db.select().from(assessments).where(eq(assessments.id, a.id));
    // Submission can finish while the early call runs; the queued job may reuse
    // its frame-only result. Once another review starts, this result is stale.
    if (!current || !["draft", "uploading", "queued"].includes(current.status)) return false;
    const open = await db.select({ id: uploadSessions.id }).from(uploadSessions).where(and(eq(uploadSessions.assessmentId, a.id), eq(uploadSessions.status, "open")));
    const currentMedia = await assetLabels(db, a.id);
    if (open.length || currentMedia.assets.some(x => PENDING_MEDIA.includes(x.status))) return false;
    const currentFrames = await chooseFrames(db, cfg, currentMedia.assets, currentMedia.labels);
    if (signature !== frameSignature(currentFrames)) return false;
    if (runId) {
      const [latest] = await db.select({ id: assessmentRuns.id }).from(assessmentRuns)
        .where(and(eq(assessmentRuns.assessmentId, a.id), eq(assessmentRuns.stage, "observe"))).orderBy(desc(assessmentRuns.version)).limit(1);
      if (latest?.id !== runId) return false;
    }
    return true;
  }
  const prepared = await mutate(async () => {
    if (!await inputsStillCurrent()) return null;
    const inputs: { frameId: string; image: Buffer; sourceLabel: string }[] = [];
    for (const f of chosen) {
      const ts = f.timestampMs != null ? ` at ${Math.floor(f.timestampMs / 60000)}:${String(Math.floor((f.timestampMs % 60000) / 1000)).padStart(2, "0")}` : "";
      inputs.push({ frameId: f.id, image: await visionImage(await store.readBuffer(f.objectKey)), sourceLabel: `${labels.get(f.assetId)}${ts}` });
    }
    const [{ v } = { v: 0 }] = await db.select({ v: max(assessmentRuns.version) }).from(assessmentRuns).where(eq(assessmentRuns.assessmentId, a.id));
    const [run] = await db
      .insert(assessmentRuns)
      .values({
        assessmentId: a.id,
        version: (v ?? 0) + 1,
        stage: "observe",
        state: "running",
        modelProvider: model.provider,
        modelConfig: { model: requestedModel, frames: chosen.length, early: ctx.early, frameSignature: signature },
        ruleVersion: RULE_VERSION,
        traceId: currentTrace()?.traceId ?? null,
      })
      .returning();
    return { run: run!, inputs };
  });
  if (!prepared) return { ranking: undefined, categories: [], discarded: true };
  const { run, inputs } = prepared;
  const started = Date.now();
  try {
    // Network/model work runs outside the mutation lock so customers can keep
    // saving details, uploading or submitting while an early review is in flight.
    const res = await model.observe({ frames: inputs, areas: ctx.areas, concerns: ctx.concerns, budgetUsd: cfg.budgetUsdPerRun, candidateQuestions: ctx.candidateQuestions });
    return await mutate(async () => {
      if (!await inputsStillCurrent(run.id)) {
        await db.update(assessmentRuns).set({ state: "superseded", errorCode: "inputs_changed", finishedAt: new Date(), durationMs: Date.now() - started }).where(eq(assessmentRuns.id, run.id));
        return { ranking: undefined, categories: [], discarded: true };
      }
      // Privacy guard: frames the model flags (faces, documents, screens) are tagged for staff
      // review and contribute no observations to the customer report.
      const privacyFrames = new Set(res.result.frames.filter((f) => f.privacyConcern).map((f) => f.frameId));
      for (const fid of privacyFrames) {
        const f = chosen.find((c) => c.id === fid);
        if (f && !f.qualityFlags.includes("privacy_review")) await db.update(mediaFrames).set({ qualityFlags: [...f.qualityFlags, "privacy_review"] }).where(eq(mediaFrames.id, fid));
      }
      const unusableFrames = new Set(res.result.frames.filter(f => !f.usable).map(f => f.frameId));
      const usableFrames = new Set(res.result.frames.filter(f => f.usable && !privacyFrames.has(f.frameId) && !unusableFrames.has(f.frameId)).map(f => f.frameId));
      for (const f of chosen) {
        const flags = [...f.qualityFlags.filter(flag => flag !== "model_unusable"),
          ...(!usableFrames.has(f.id) ? ["model_unusable"] : []), ...(privacyFrames.has(f.id) ? ["privacy_review"] : [])];
        if (JSON.stringify(f.qualityFlags) !== JSON.stringify([...new Set(flags)])) await db.update(mediaFrames).set({ qualityFlags: [...new Set(flags)] }).where(eq(mediaFrames.id, f.id));
      }
      const frameById = new Map(chosen.filter((f) => usableFrames.has(f.id)).map((f) => [f.id, f]));
      await db.update(observations).set({ status: "superseded" }).where(and(eq(observations.assessmentId, a.id), eq(observations.status, "active")));
      const rows = res.result.observations
        .filter((o) => frameById.has(o.frameId))
        .map((o) => ({
          assessmentId: a.id,
          runId: run!.id,
          frameId: o.frameId,
          category: o.category,
          location: o.location,
          neutralDescription: o.neutralDescription,
          visibility: o.visibility,
          strength: o.strength,
          alternativeExplanations: o.alternativeExplanations,
          limitations: o.limitations,
          region: sanitizeRegion(o.region),
          modelVersion: `${res.provider}:${res.model}`,
        }));
      if (rows.length) await db.insert(observations).values(rows);
      await db
        .update(assessmentRuns)
        .set({
          state: "succeeded",
          promptVersion: res.promptVersion,
          modelConfig: {
            model: res.model,
            requestedModel,
            requestPromptVersion: VISION_PROMPT_VERSION,
            frames: chosen.length,
            early: ctx.early,
            frameSignature: signature,
            isMock: res.isMock,
            frameAssessments: res.result.frames,
            overallLimitations: res.result.overallLimitations,
            questionPriority: res.result.questionPriority,
          },
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          imageCount: res.usage.images,
          costUsd: res.usage.costUsd.toFixed(4),
          durationMs: Date.now() - started,
          finishedAt: new Date(),
        })
        .where(eq(assessmentRuns.id, run!.id));
      return { ranking: res.isMock ? undefined : res.result.questionPriority, categories: [...new Set(rows.map((r) => r.category as ObservationCategory))] };
    });
  } catch (e) {
    const code = e instanceof ModelError ? e.code : "internal";
    await db.update(assessmentRuns).set({ state: "failed", errorCode: code, durationMs: Date.now() - started, finishedAt: new Date() }).where(and(eq(assessmentRuns.id, run!.id), eq(assessmentRuns.state, "running")));
    throw e;
  }
}

/** Latest successful vision run, if it looked at exactly these frames. */
async function reusableRun(db: Db, assessmentId: string, chosen: FrameRow[], model: VisionModel) {
  const [last] = await db
    .select()
    .from(assessmentRuns)
    .where(and(eq(assessmentRuns.assessmentId, assessmentId), eq(assessmentRuns.stage, "observe")))
    .orderBy(desc(assessmentRuns.version))
    .limit(1);
  const cfg = (last?.modelConfig ?? {}) as RunConfig;
  return last && last.state === "succeeded" && last.modelProvider === model.provider && cfg.requestedModel === model.model
    && cfg.requestPromptVersion === VISION_PROMPT_VERSION && last.ruleVersion === RULE_VERSION
    && cfg.frameSignature === frameSignature(chosen) ? { run: last, cfg } : null;
}

/**
 * Early vision pass while the customer is still filling in the form (status draft/uploading).
 * Never changes the assessment status. Failures are recorded and left for the normal observe
 * stage to retry after submission, so the customer never sees an error from this step.
 */
export async function preObserveAssessment(db: Db, store: ObjectStore, cfg: PipelineConfig, assessmentId: string, model: VisionModel = getVisionModel(), serialize?: AssessmentSerializer): Promise<string> {
  const [a] = await db.select().from(assessments).where(eq(assessments.id, assessmentId));
  if (!a) return "skipped:missing";
  if (a.status !== "draft" && a.status !== "uploading") return `skipped:${a.status}`; // already submitted: observe handles it
  const open = await db.select({ id: uploadSessions.id }).from(uploadSessions).where(and(eq(uploadSessions.assessmentId, a.id), eq(uploadSessions.status, "open")));
  const { assets, labels } = await assetLabels(db, a.id);
  if (open.length || assets.some((x) => PENDING_MEDIA.includes(x.status))) throw new DeferError(4000, "waiting_for_more_media");
  const chosen = await chooseFrames(db, cfg, assets, labels);
  if (!chosen.length) return "skipped:no_frames";
  if (await reusableRun(db, a.id, chosen, model)) return "skipped:already_reviewed";
  try {
    const result = await runVision(db, store, cfg, a, model, chosen, labels, {
      areas: [],
      concerns: [],
      // Areas aren't known yet, so the model may rank any approved question; eligibility is applied at submit.
      candidateQuestions: QUESTION_BANK.map((q) => ({ id: q.id, text: q.text })),
      early: true,
      serialize,
    });
    return result.discarded ? "discarded:inputs_changed" : "reviewed_early";
  } catch (e) {
    if (e instanceof ModelError && e.retryable) throw e;
    log.warn("preobserve.failed_will_retry_at_submit", { assessmentId: a.id, code: e instanceof ModelError ? e.code : "internal" });
    return "early_failed";
  }
}

/** ObserveVisuals + ReconcileSources + SelectFollowups. Reuses the early pass when the frames are unchanged. */
export async function observeAssessment(db: Db, store: ObjectStore, cfg: PipelineConfig, assessmentId: string, model: VisionModel = getVisionModel()): Promise<string> {
  const [a] = await db.select().from(assessments).where(eq(assessments.id, assessmentId));
  if (!a) throw new Error("assessment not found");
  if (a.status !== "queued" && a.status !== "processing") return `skipped:${a.status}`;

  const { assets, labels } = await assetLabels(db, assessmentId);
  if (assets.some((x) => PENDING_MEDIA.includes(x.status))) throw new DeferError(3000, "waiting_for_media");

  if (a.status === "queued") await transitionAssessment(db, a.id, "queued", "processing");

  const concernRows = await db.select().from(concerns).where(eq(concerns.assessmentId, a.id));
  const areas = [...new Set(concernRows.map((c) => c.area))] as AreaId[];
  const concernIds = [...new Set(concernRows.flatMap((c) => c.issueTypes))] as ConcernId[];
  const chosen = await chooseFrames(db, cfg, assets, labels);

  let categories: ObservationCategory[] = [];
  let ranking: string[] | undefined;
  const answeredBefore = (await db.select({ q: answers.questionId }).from(answers).where(eq(answers.assessmentId, a.id))).map((r) => r.q);
  // Every approved question the rules consider eligible; the model may only rank these.
  const candidateQuestions = selectFollowups({ areas, concerns: concernIds, observationCategories: ["discoloration", "staining", "moisture_indicator", "ventilation_component"], answeredQuestionIds: answeredBefore, capOverride: { cap: 20, justification: "candidate list for model ranking" } }).map((s) => ({ id: s.question.id, text: s.question.text }));
  if (chosen.length) {
    const reuse = await reusableRun(db, a.id, chosen, model);
    if (reuse) {
      // The early pass already reviewed exactly these frames: no second model call.
      const active = await db.select({ c: observations.category }).from(observations).where(and(eq(observations.assessmentId, a.id), eq(observations.status, "active")));
      categories = [...new Set(active.map((r) => r.c as ObservationCategory))];
      const eligible = new Set(candidateQuestions.map((q) => q.id));
      ranking = reuse.cfg.isMock ? undefined : (reuse.cfg.questionPriority ?? []).filter((id) => eligible.has(id));
      log.info("observe.reused_early_review", { assessmentId: a.id, runId: reuse.run.id });
    } else {
      try {
        ({ ranking, categories } = await runVision(db, store, cfg, a, model, chosen, labels, { areas, concerns: concernIds, candidateQuestions, early: false }));
      } catch (e) {
        if (e instanceof ModelError && e.code === "not_configured") throw e; // fail the case visibly; never pretend
        if (e instanceof ModelError && !e.retryable) {
          log.warn("observe.model_failed_nonretryable", { assessmentId: a.id, code: e.code });
          // Fall through: synthesis sees no completed visual review -> honest inconclusive result.
        } else throw e;
      }
    }
  }

  // ---- SelectFollowups (deterministic, approved bank) ----------------------------------
  const answered = await db.select({ q: answers.questionId }).from(answers).where(eq(answers.assessmentId, a.id));
  const selected = selectFollowups({ areas, concerns: concernIds, observationCategories: categories, answeredQuestionIds: answered.map((r) => r.q), ranking });
  const existing = await db.select().from(pendingQuestions).where(eq(pendingQuestions.assessmentId, a.id));
  const round = existing.reduce((m, q) => Math.max(m, q.round), 0) + 1;
  if (selected.length) {
    await db
      .insert(pendingQuestions)
      .values(selected.map((s, i) => ({ assessmentId: a.id, questionId: s.question.id, questionBankVersion: QUESTION_BANK_VERSION, position: i, score: s.score, reasons: s.reasons, round })))
      .onConflictDoNothing();
  }
  const answeredSet = new Set(answered.map((r) => r.q));
  const unanswered = selected.filter((s) => !answeredSet.has(s.question.id));
  if (unanswered.length) {
    await transitionAssessment(db, a.id, "processing", "needs_answers");
    await audit(db, { orgId: a.orgId, actorType: "system", action: "assessment.questions_selected", resourceType: "assessment", resourceId: a.id, metadata: { count: unanswered.length, round } });
    return "needs_answers";
  }
  await enqueue(db, { type: "assessment.synthesize", payload: { assessmentId: a.id }, idempotencyKey: `synth:${a.id}:${a.version}:${Date.now()}`, orgId: a.orgId });
  return "synthesize_enqueued";
}

/** Build the evidence snapshot handed to synthesis. Nothing outside this object reaches the report. */
export async function buildSnapshot(db: Db, assessmentId: string): Promise<ReportInputSnapshot> {
  const [a] = await db.select().from(assessments).where(eq(assessments.id, assessmentId));
  if (!a) throw new Error("assessment not found");
  const [prop] = a.propertyId ? await db.select().from(properties).where(eq(properties.id, a.propertyId)) : [];
  const concernRows = await db.select().from(concerns).where(eq(concerns.assessmentId, a.id));
  const { assets, labels } = await assetLabels(db, a.id);
  const obsRows = await db
    .select({ o: observations, f: mediaFrames })
    .from(observations)
    .leftJoin(mediaFrames, eq(observations.frameId, mediaFrames.id))
    .where(and(eq(observations.assessmentId, a.id), eq(observations.status, "active")))
    .orderBy(asc(mediaFrames.timestampMs));
  const answerRows = await db.select().from(answers).where(eq(answers.assessmentId, a.id));
  // Staff corrections override customer answers for the same question.
  const byQ = new Map<string, (typeof answerRows)[number]>();
  for (const r of answerRows) if (!byQ.has(r.questionId) || r.source === "staff_correction") byQ.set(r.questionId, r);
  const allFrames = assets.length ? await db.select().from(mediaFrames).where(inArray(mediaFrames.assetId, assets.map((x) => x.id))) : [];
  const [lastRun] = await db.select().from(assessmentRuns).where(and(eq(assessmentRuns.assessmentId, a.id), eq(assessmentRuns.stage, "observe"))).orderBy(desc(assessmentRuns.version)).limit(1);
  const runCfg = (lastRun?.modelConfig ?? {}) as { model?: string; isMock?: boolean; overallLimitations?: string[] };
  const ready = assets.filter((x) => x.status === "ready");
  const assetById = new Map(assets.map((x) => [x.id, x]));
  const reviewOk = lastRun?.state === "succeeded";

  return {
    assessment: {
      id: a.id,
      reference: a.reference,
      region: prop?.approximateRegion ?? "unknown",
      propertyType: prop?.propertyType ?? "other",
      areas: [...new Set(concernRows.map((c) => c.area))],
      concerns: [...new Set(concernRows.flatMap((c) => c.issueTypes))],
      createdAt: a.createdAt.toISOString(),
    },
    concerns: concernRows.map((c) => ({ id: c.id, area: c.area, issueTypes: c.issueTypes, statement: c.statement })),
    observations: (reviewOk ? obsRows : []).map(({ o, f }) => ({
      id: o.id,
      frameId: o.frameId,
      assetId: f?.assetId ?? null,
      area: (f && assetById.get(f.assetId)?.area) || null,
      timestampMs: f?.timestampMs ?? null,
      sourceLabel: f ? (labels.get(f.assetId) ?? "Media") : "Media",
      category: o.category as ObservationCategory,
      location: o.location,
      neutralDescription: o.neutralDescription,
      visibility: o.visibility as "good" | "limited" | "poor",
      strength: o.strength as "weak" | "moderate" | "clear",
      alternativeExplanations: o.alternativeExplanations,
      limitations: o.limitations,
      region: o.region ?? null,
    })),
    answers: [...byQ.values()].map((r) => ({ id: r.id, questionId: r.questionId, value: r.value })),
    media: {
      videos: ready.filter((x) => x.kind === "video").length,
      images: ready.filter((x) => x.kind === "image").length,
      framesTotal: allFrames.length,
      framesUsable: allFrames.filter((f) => !f.qualityFlags.some((q) => ["too_dark", "overexposed", "privacy_review", "model_unusable"].includes(q))).length,
      framesAnalyzed: ready.length ? lastRun?.imageCount ?? 0 : 0,
    },
    model: {
      provider: ready.length ? lastRun?.modelProvider ?? "none" : "none",
      model: ready.length ? runCfg.model ?? "none" : "none",
      promptVersion: ready.length ? lastRun?.promptVersion ?? "none" : "none",
      isMock: ready.length ? runCfg.isMock ?? false : false,
      overallLimitations: ready.length ? runCfg.overallLimitations ?? [] : [],
      visualReviewCompleted: ready.length === 0 || reviewOk,
    },
  };
}

/** SynthesizeFindings + ValidateReport + publish decision + Notify (outbox). */
/** Only rule-produced, approved-vocabulary facts. Customer free text is excluded (injection surface). */
export function summaryInputFrom(content: ReportContent): SummaryInput {
  return {
    outcome: content.outcome,
    priority: content.priority,
    findings: content.areas.flatMap((a) => a.findings.map((f) => ({ area: a.label, statement: f.statement, strength: f.strength }))),
    reportedConcerns: content.customerContext.filter((c) => c.label.endsWith("concerns")).map((c) => `${c.label.replace(/ concerns$/, "")}: ${c.value}`),
    answers: content.customerContext.filter((c) => c.evidenceRef.label === "Your answer").map((c) => ({ question: c.label, answer: c.value })),
    unknowns: content.unknowns,
  };
}

const EM_DASH = new RegExp(`\\s*${String.fromCharCode(0x2014)}\\s*`, "g");
const EN_DASH = new RegExp(String.fromCharCode(0x2013), "g");
const noEmDash = (s: string) => s.replace(EM_DASH, ", ").replace(EN_DASH, "-");

export async function synthesizeAssessment(db: Db, cfg: PipelineConfig, assessmentId: string, textModel: TextModel | null = getTextModel()): Promise<string> {
  const [a] = await db.select().from(assessments).where(eq(assessments.id, assessmentId));
  if (!a) throw new Error("assessment not found");
  if (a.status !== "processing") return `skipped:${a.status}`;

  const raw = await buildSnapshot(db, a.id);
  const { snapshot, removed } = sanitizeSnapshot(raw);
  let content = synthesizeReport(snapshot);
  let validation = validateReport(content, snapshot);
  let fallbackUsed = false;
  if (!validation.passed) {
    // Fail closed: drop all model-derived evidence and publish an honest inconclusive result.
    log.warn("report.validation_failed", { assessmentId: a.id, issues: validation.issues.map((i) => i.code) });
    const bare = { ...snapshot, observations: [], model: { ...snapshot.model, visualReviewCompleted: false } };
    content = synthesizeReport(bare);
    content.outcome = "inconclusive";
    content.outcomeReasons = ["Automated checks could not verify the generated findings, so detailed findings are withheld."];
    const second = validateReport(content, bare);
    validation = { ...second, issues: [...validation.issues, ...second.issues] };
    fallbackUsed = true;
    if (!second.passed) throw new Error("fallback report failed validation");
  }

  // Plain-language summary from the text model. It must pass the same gate, or the rule summary stays.
  if (textModel && !fallbackUsed && (snapshot.media.videos > 0 || snapshot.media.images > 0)) {
    const [{ rv: runV } = { rv: 0 }] = await db.select({ rv: max(assessmentRuns.version) }).from(assessmentRuns).where(eq(assessmentRuns.assessmentId, a.id));
    const started = Date.now();
    const [run] = await db
      .insert(assessmentRuns)
      .values({ assessmentId: a.id, version: (runV ?? 0) + 1, stage: "summarize", state: "running", modelProvider: textModel.provider, modelConfig: { model: textModel.model }, ruleVersion: RULE_VERSION, traceId: currentTrace()?.traceId ?? null })
      .returning();
    try {
      const res = await textModel.summarize(summaryInputFrom(content));
      const candidate: ReportContent = {
        ...content,
        summary: { headline: noEmDash(res.summary.headline), points: res.summary.points.map(noEmDash) },
        provenance: { ...content.provenance, summaryModel: `${res.provider}:${res.model}` },
      };
      const check = validateReport(candidate, snapshot);
      if (check.passed) {
        content = candidate;
        validation = check;
      } else log.warn("summary.gate_rejected", { assessmentId: a.id, issues: check.issues.map((i) => i.code) });
      await db
        .update(assessmentRuns)
        .set({
          state: check.passed ? "succeeded" : "failed",
          errorCode: check.passed ? null : "gate_rejected",
          promptVersion: res.promptVersion,
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          costUsd: res.usage.costUsd.toFixed(4),
          durationMs: Date.now() - started,
          finishedAt: new Date(),
        })
        .where(eq(assessmentRuns.id, run!.id));
    } catch (e) {
      const code = e instanceof ModelError ? e.code : "internal";
      await db.update(assessmentRuns).set({ state: "failed", errorCode: code, durationMs: Date.now() - started, finishedAt: new Date() }).where(eq(assessmentRuns.id, run!.id));
      if (e instanceof ModelError && (e.retryable || (e.code === "not_configured" && (snapshot.media.videos > 0 || snapshot.media.images > 0)))) throw e;
      log.warn("summary.failed_using_rule_summary", { assessmentId: a.id, code });
    }
  }

  const [{ v } = { v: 0 }] = await db.select({ v: max(reportVersions.version) }).from(reportVersions).where(eq(reportVersions.assessmentId, a.id));
  // MoldLens publishes every validated screening for its owner, without billing.
  // The upstream deployment flag is intentionally not part of this integration.
  const publish = true;
  await db.update(reportVersions).set({ status: "superseded" }).where(and(eq(reportVersions.assessmentId, a.id), eq(reportVersions.status, "published")));
  const [rv] = await db
    .insert(reportVersions)
    .values({
      assessmentId: a.id,
      version: (v ?? 0) + 1,
      kind: "full",
      status: publish ? "published" : "validated",
      outcome: content.outcome,
      content,
      validation: { ...validation, removedObservations: removed, fallbackUsed },
      inputSnapshotHash: content.provenance.inputSnapshotHash,
      disclosure: content.disclosure,
      policyVersion: POLICY_VERSION,
    })
    .returning();
  const allFindings = content.areas.flatMap((ar) => ar.findings.map((f) => ({ ar, f })));
  if (allFindings.length) {
    await db.insert(findings).values(
      allFindings.map(({ ar, f }) => ({
        assessmentId: a.id,
        reportVersionId: rv!.id,
        kind: f.kind,
        assertion: f.statement,
        evidenceRefs: f.evidenceRefs,
        uncertainty: f.strength ?? "n/a",
        policyRuleRefs: [POLICY_VERSION],
        recommendationRefs: content.recommendations.map((r) => r.id).concat(`area:${ar.area}`),
      })),
    );
  }
  const to: AssessmentStatus = content.outcome === "inconclusive" ? "inconclusive" : "ready_preview";
  await transitionAssessment(db, a.id, "processing", to, { priority: content.priority, completedAt: new Date() });
  await audit(db, {
    orgId: a.orgId,
    actorType: "system",
    action: "report.generated",
    resourceType: "report_version",
    resourceId: rv!.id,
    metadata: { outcome: content.outcome, published: publish, fallbackUsed, removedObservations: removed.length, issues: validation.issues.length },
  });

  // Notify via transactional outbox; only to a verified address; never marketing.
  const [cust] = await db.select().from(customerProfiles).where(eq(customerProfiles.id, a.customerId));
  if (publish && cust?.email && cust.emailVerifiedAt) {
    await db
      .insert(outbox)
      .values({
        orgId: a.orgId,
        kind: "email",
        recipient: cust.email,
        subject: `Your screening results are ready (${a.reference})`,
        body: `Your preliminary screening results are ready. View them securely: ${cfg.appUrl}/assess/${a.id}/results\n\nThis is a preliminary remote screening, not a certified inspection.`,
        idempotencyKey: `results-ready:${rv!.id}`,
      })
      .onConflictDoNothing();
  }
  return to;
}
