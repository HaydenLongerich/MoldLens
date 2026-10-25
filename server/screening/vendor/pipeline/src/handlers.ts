import { and, eq, inArray } from "drizzle-orm";
import { assessments, claimJob, completeJob, deferJob, enqueue, failJob, mediaAssets, type Db, type JobRow } from "@mb/db";
import { ModelError, type VisionModel, type TextModel } from "@mb/ai";
import { log, withTrace } from "@mb/observability";
import type { ObjectStore } from "@mb/storage";
import { ConcurrencyConflict, DeferError, observeAssessment, preObserveAssessment, synthesizeAssessment, transitionAssessment } from "./assessment-stages";
import type { PipelineConfig } from "./config";
import { processMediaAsset } from "./media-stage";

export const JOB_TYPES = {
  mediaProcess: "media.process",
  preObserve: "assessment.preobserve",
  observe: "assessment.observe",
  synthesize: "assessment.synthesize",
} as const;

export const MEDIA_JOB_TYPES = [JOB_TYPES.mediaProcess];
export const MODEL_JOB_TYPES = [JOB_TYPES.preObserve, JOB_TYPES.observe, JOB_TYPES.synthesize];

export interface PipelineDeps {
  db: Db;
  store: ObjectStore;
  cfg: PipelineConfig;
  visionModel?: VisionModel;
  textModel?: TextModel | null;
  serialize?: <T>(id: string, work: () => Promise<T>) => Promise<T>;
}

async function handle(deps: PipelineDeps, job: JobRow): Promise<string> {
  const p = job.payload as Record<string, string>;
  switch (job.type) {
    case JOB_TYPES.mediaProcess:
      return processMediaAsset(deps.db, deps.store, deps.cfg, p.assetId!, deps.serialize);
    case JOB_TYPES.preObserve:
      return preObserveAssessment(deps.db, deps.store, deps.cfg, p.assessmentId!, deps.visionModel, deps.serialize);
    case JOB_TYPES.observe:
      return observeAssessment(deps.db, deps.store, deps.cfg, p.assessmentId!, deps.visionModel);
    case JOB_TYPES.synthesize:
      return synthesizeAssessment(deps.db, deps.cfg, p.assessmentId!, deps.textModel);
    default:
      throw new Error(`unknown job type ${job.type}`);
  }
}

/** Mark the assessment failed (customer sees an honest failure + retry path) when a job dead-letters. */
async function onDead(deps: PipelineDeps, job: JobRow, err: string) {
  const p = job.payload as Record<string, string>;
  let assessmentId = p.assessmentId;
  if (!assessmentId && p.assetId) {
    const [a] = await deps.db.select({ id: mediaAssets.assessmentId }).from(mediaAssets).where(eq(mediaAssets.id, p.assetId));
    if (a) {
      assessmentId = a.id;
      await deps.db.update(mediaAssets).set({ status: "failed", rejectionReason: err.includes("media_not_configured")
        ? "Photo or video processing is not configured. Remove this file or contact the team for help."
        : "This file could not be processed. Remove it and try again." }).where(and(eq(mediaAssets.id, p.assetId), inArray(mediaAssets.status, ["quarantined", "validated", "processing"])));
    }
  }
  if (!assessmentId) return;
  const [a] = await deps.db.select().from(assessments).where(eq(assessments.id, assessmentId));
  if (a && (a.status === "queued" || a.status === "processing")) {
    const code = err.startsWith("AI model not configured") ? "ai_not_configured" : err.includes("media_not_configured") ? "media_not_configured" : `${job.type}:processing_failed`;
    await transitionAssessment(deps.db, a.id, a.status, "failed", { lastErrorCode: code }).catch(() => {});
  }
}

/** Claim and run a single job. Returns false when nothing was due. */
export async function runOnce(deps: PipelineDeps, workerId: string, types?: readonly string[]): Promise<boolean> {
  const job = await claimJob(deps.db, workerId, types);
  if (!job) return false;
  await withTrace({ traceId: job.traceId ?? undefined }, async () => {
    const started = Date.now();
    try {
      const result = await handle(deps, job);
      await completeJob(deps.db, job.id);
      log.info("job.succeeded", { jobId: job.id, type: job.type, result, attempt: job.attempts, durationMs: Date.now() - started });
    } catch (e) {
      if (e instanceof DeferError) {
        if (Date.now() - job.createdAt.getTime() > 60 * 60_000) {
          await failJob(deps.db, job, "deferred_too_long", { retryable: false });
          await onDead(deps, job, "deferred_too_long");
        } else await deferJob(deps.db, job, e.delayMs, e.message);
        return;
      }
      const msg = (e as { code?: string })?.code === "media_not_configured" ? "media_not_configured"
        : e instanceof ModelError && e.code === "not_configured" ? "AI model not configured"
        : e instanceof Error ? e.message : String(e);
      const retryable = e instanceof ModelError ? e.retryable : (e as { retryable?: boolean })?.retryable === false ? false : !(e instanceof ConcurrencyConflict);
      const outcome = await failJob(deps.db, job, msg, { retryable });
      log.error("job.failed", { jobId: job.id, type: job.type, attempt: job.attempts, outcome, error: e });
      if (outcome === "dead") await onDead(deps, job, msg);
    }
  });
  return true;
}

/** Drain all due jobs (tests / demo scripts). */
export async function drain(deps: PipelineDeps, maxJobs = 200): Promise<number> {
  let n = 0;
  while (n < maxJobs && (await runOnce(deps, "drain"))) n++;
  return n;
}

export { enqueue };
