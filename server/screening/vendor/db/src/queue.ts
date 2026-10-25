import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "./client";
import { jobs } from "./schema";

export type JobRow = typeof jobs.$inferSelect;

export interface EnqueueInput {
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  orgId?: string | null;
  runAt?: Date;
  maxAttempts?: number;
  traceId?: string | null;
}

/** Idempotent enqueue: a second call with the same key is a no-op. */
export async function enqueue(db: Db, j: EnqueueInput): Promise<void> {
  await db
    .insert(jobs)
    .values({
      type: j.type,
      payload: j.payload,
      idempotencyKey: j.idempotencyKey,
      orgId: j.orgId ?? null,
      runAt: j.runAt ?? new Date(),
      maxAttempts: j.maxAttempts ?? 5,
      traceId: j.traceId ?? null,
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey });
}

/** Claim one due job with SKIP LOCKED so many workers can run safely. */
export async function claimJob(db: Db, workerId: string, types?: readonly string[]): Promise<JobRow | null> {
  const typeFilter = types && types.length ? sql`AND type IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const res = await db.execute(sql`
    UPDATE jobs SET status = 'running', locked_at = now(), locked_by = ${workerId},
      attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_at <= now() ${typeFilter}
      ORDER BY run_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`);
  const row = (res as unknown as { rows: { id: string }[] }).rows[0];
  if (!row) return null;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, row.id));
  return job ?? null;
}

export async function completeJob(db: Db, id: string): Promise<void> {
  await db.update(jobs).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date(), lockedAt: null, lockedBy: null }).where(eq(jobs.id, id));
}

/** Exponential backoff (5s, 20s, 80s, ...) capped at 15 min; dead-letter after max attempts. */
export function backoffMs(attempt: number): number {
  return Math.min(5_000 * 4 ** Math.max(0, attempt - 1), 15 * 60_000);
}

export async function failJob(db: Db, job: JobRow, error: string, opts: { retryable: boolean }): Promise<"retry" | "dead"> {
  const dead = !opts.retryable || job.attempts >= job.maxAttempts;
  await db
    .update(jobs)
    .set({
      status: dead ? "dead" : "queued",
      lastError: error.slice(0, 2000),
      runAt: dead ? job.runAt : new Date(Date.now() + backoffMs(job.attempts)),
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
      finishedAt: dead ? new Date() : null,
    })
    .where(eq(jobs.id, job.id));
  return dead ? "dead" : "retry";
}

/** Requeue jobs whose worker died mid-run (lock older than timeout). */
export async function recoverStaleJobs(db: Db, lockTimeoutMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - lockTimeoutMs);
  const res = await db
    .update(jobs)
    .set({ status: "queued", lockedAt: null, lockedBy: null, updatedAt: new Date(), lastError: "stale_lock_recovered" })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, cutoff)))
    .returning({ id: jobs.id });
  return res.length;
}

/** Re-run later without consuming an attempt (e.g. waiting for media to finish). */
export async function deferJob(db: Db, job: JobRow, delayMs: number, reason: string): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: "queued",
      attempts: Math.max(0, job.attempts - 1),
      runAt: new Date(Date.now() + delayMs),
      lockedAt: null,
      lockedBy: null,
      lastError: reason,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));
}
