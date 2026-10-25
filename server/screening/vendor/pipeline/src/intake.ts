import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  accessGrants,
  answers,
  assessments,
  audit,
  concerns,
  consents,
  customerProfiles,
  enqueue,
  entitlements,
  mediaAssets,
  mediaFrames,
  observations,
  organizations,
  pendingQuestions,
  properties,
  uploadSessions,
  type Db,
} from "@mb/db";
import {
  AREA_IDS,
  assertAuthorized,
  CONCERN_IDS,
  getQuestion,
  newCaseReference,
  normalizeAnswer,
  POLICY_VERSION,
  PROPERTY_TYPE_IDS,
  QUESTION_BANK_VERSION,
  REGION_IDS,
  type Principal,
  type ResourceContext,
} from "@mb/domain";
import { ALLOWED_DECLARED_MIME } from "@mb/media";
import type { ObjectStore } from "@mb/storage";
import { transitionAssessment } from "./assessment-stages";
import type { PipelineConfig } from "./config";
import { JOB_TYPES } from "./handlers";

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}
export class NotFoundError extends Error {}

export const DEFAULT_ORG_SLUG = "mold-busters";
export const CONSENT_TEXT_VERSION = "consent-2026.10-draft1";

export async function getDefaultOrg(db: Db) {
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, DEFAULT_ORG_SLUG));
  if (!org) throw new Error("Default organization missing, run `pnpm db:seed`");
  return org;
}

/** Load the facts `authorize` needs for an assessment. Unknown IDs and other orgs look identical (404). */
export async function assessmentResource(db: Db, principal: Principal, assessmentId: string): Promise<{ a: typeof assessments.$inferSelect; res: ResourceContext }> {
  const parsed = z.uuid().safeParse(assessmentId);
  if (!parsed.success) throw new NotFoundError("not found");
  const [a] = await db.select().from(assessments).where(eq(assessments.id, assessmentId));
  if (!a) throw new NotFoundError("not found");
  const res: ResourceContext = { orgId: a.orgId, ownerCustomerId: a.customerId, assignedStaffId: a.assignedStaffId, status: a.status };
  if (principal.kind === "staff") {
    const grants = await db
      .select({ u: accessGrants.staffUserId, exp: accessGrants.expiresAt })
      .from(accessGrants)
      .where(and(eq(accessGrants.assessmentId, a.id), eq(accessGrants.status, "approved")));
    res.activeGrantUserIds = grants.filter((g) => g.exp && g.exp > new Date()).map((g) => g.u);
  }
  if (principal.kind === "customer") {
    const ent = await db
      .select({ id: entitlements.id })
      .from(entitlements)
      .where(and(eq(entitlements.assessmentId, a.id), eq(entitlements.customerId, principal.customerId), eq(entitlements.state, "active")));
    res.entitled = ent.length > 0;
  }
  return { a, res };
}

// ---------------------------------------------------------------------------------------

export const NewAssessmentInput = z.object({
  propertyType: z.enum(PROPERTY_TYPE_IDS),
  region: z.enum(REGION_IDS),
  areas: z.array(z.enum(AREA_IDS)).min(1).max(6),
  concerns: z.array(z.enum(CONCERN_IDS)).min(1).max(8),
  statement: z.string().trim().max(1500).optional(),
  consentAiProcessing: z.literal(true, { error: "Consent to automated processing is required" }),
  consentMediaStorage: z.literal(true, { error: "Consent to store your media is required" }),
});
export type NewAssessmentInput = z.infer<typeof NewAssessmentInput>;

/** Creates (or reuses) a customer profile for anonymous visitors, minimal data, no contact info yet. */
export async function createAssessment(db: Db, principal: Principal, input: unknown) {
  assertAuthorized(principal, "assessment.create");
  const parsed = NewAssessmentInput.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input", parsed.error.issues[0]?.path.join("."));
  const v = parsed.data;
  const org = await getDefaultOrg(db);
  let customerId: string;
  if (principal.kind === "customer") {
    if (principal.orgId !== org.id) throw new ValidationError("org mismatch");
    customerId = principal.customerId;
  } else {
    const [c] = await db.insert(customerProfiles).values({ orgId: org.id }).returning();
    customerId = c!.id;
  }
  const [prop] = await db.insert(properties).values({ orgId: org.id, customerId, propertyType: v.propertyType, approximateRegion: v.region }).returning();
  const [a] = await db
    .insert(assessments)
    .values({ orgId: org.id, reference: newCaseReference(), customerId, propertyId: prop!.id, status: "draft", modality: "form_only", policyVersion: POLICY_VERSION })
    .returning();
  // One concern row per area; the customer's statement is attached to the first area.
  await db.insert(concerns).values(v.areas.map((area, i) => ({ assessmentId: a!.id, area, issueTypes: v.concerns, statement: i === 0 ? (v.statement ?? null) : null })));
  await db.insert(consents).values([
    { orgId: org.id, customerId, assessmentId: a!.id, kind: "ai_processing", granted: true, textVersion: CONSENT_TEXT_VERSION },
    { orgId: org.id, customerId, assessmentId: a!.id, kind: "media_storage", granted: true, textVersion: CONSENT_TEXT_VERSION },
    { orgId: org.id, customerId, assessmentId: a!.id, kind: "transcription", granted: false, textVersion: CONSENT_TEXT_VERSION },
  ]);
  await audit(db, { orgId: org.id, actorType: "customer", actorId: customerId, action: "assessment.created", resourceType: "assessment", resourceId: a!.id, metadata: { areas: v.areas, concerns: v.concerns } });
  return { assessment: a!, customerId, orgId: org.id };
}

const DraftInput = z.object({
  consentAiProcessing: z.literal(true, { error: "Consent to automated processing is required" }),
  consentMediaStorage: z.literal(true, { error: "Consent to store your media is required" }),
});

/**
 * Media-first intake: create an empty draft with consent only, so uploads (and the early AI
 * review) can start while the customer fills in the details.
 */
export async function createDraft(db: Db, principal: Principal, input: unknown) {
  assertAuthorized(principal, "assessment.create");
  const parsed = DraftInput.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Consent required");
  const org = await getDefaultOrg(db);
  let customerId: string;
  if (principal.kind === "customer") {
    if (principal.orgId !== org.id) throw new ValidationError("org mismatch");
    customerId = principal.customerId;
  } else {
    const [c] = await db.insert(customerProfiles).values({ orgId: org.id }).returning();
    customerId = c!.id;
  }
  const [a] = await db
    .insert(assessments)
    .values({ orgId: org.id, reference: newCaseReference(), customerId, status: "draft", modality: "form_only", policyVersion: POLICY_VERSION })
    .returning();
  await db.insert(consents).values([
    { orgId: org.id, customerId, assessmentId: a!.id, kind: "ai_processing", granted: true, textVersion: CONSENT_TEXT_VERSION },
    { orgId: org.id, customerId, assessmentId: a!.id, kind: "media_storage", granted: true, textVersion: CONSENT_TEXT_VERSION },
    { orgId: org.id, customerId, assessmentId: a!.id, kind: "transcription", granted: false, textVersion: CONSENT_TEXT_VERSION },
  ]);
  await audit(db, { orgId: org.id, actorType: "customer", actorId: customerId, action: "assessment.draft_created", resourceType: "assessment", resourceId: a!.id });
  return { assessment: a!, customerId, orgId: org.id };
}

export const DetailsInput = NewAssessmentInput.omit({ consentAiProcessing: true, consentMediaStorage: true });

/** Set or replace the details of a draft (areas, concerns, statement, property). */
export async function updateDraftDetails(db: Db, principal: Principal, assessmentId: string, input: unknown) {
  const { a, res } = await assessmentResource(db, principal, assessmentId);
  assertAuthorized(principal, "assessment.edit_draft", res);
  const parsed = DetailsInput.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input", parsed.error.issues[0]?.path.join("."));
  const v = parsed.data;
  if (a.propertyId) {
    await db.update(properties).set({ propertyType: v.propertyType, approximateRegion: v.region }).where(eq(properties.id, a.propertyId));
  } else {
    const [prop] = await db.insert(properties).values({ orgId: a.orgId, customerId: a.customerId, propertyType: v.propertyType, approximateRegion: v.region }).returning();
    await db.update(assessments).set({ propertyId: prop!.id, updatedAt: new Date() }).where(eq(assessments.id, a.id));
  }
  await db.delete(concerns).where(eq(concerns.assessmentId, a.id));
  await db.insert(concerns).values(v.areas.map((area, i) => ({ assessmentId: a.id, area, issueTypes: v.concerns, statement: i === 0 ? (v.statement ?? null) : null })));
  await audit(db, { orgId: a.orgId, actorType: "customer", actorId: a.customerId, action: "assessment.details_updated", resourceType: "assessment", resourceId: a.id, metadata: { areas: v.areas, concerns: v.concerns } });
}

// ---- Resumable uploads ---------------------------------------------------------------

export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_ASSETS_PER_ASSESSMENT = 12;

const UploadInit = z.object({
  fingerprint: z.string().min(8).max(200),
  mime: z.string().regex(ALLOWED_DECLARED_MIME, "Unsupported file type"),
  size: z.number().int().positive(),
  area: z.enum(AREA_IDS).optional(),
});

async function createUploadSessionLocked(db: Db, principal: Principal, cfg: PipelineConfig, assessmentId: string, input: unknown) {
  const { a, res } = await assessmentResource(db, principal, assessmentId);
  assertAuthorized(principal, "assessment.upload_media", res);
  if (!["draft", "uploading"].includes(a.status)) throw new ValidationError("This assessment is no longer accepting uploads");
  const parsed = UploadInit.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid upload");
  const v = parsed.data;
  if (v.size > cfg.maxUploadBytes) throw new ValidationError(`Files can be up to ${Math.round(cfg.maxUploadBytes / 1024 / 1024)} MB`);
  // Resume: same browser fingerprint on an open session → continue from its offset.
  const [existing] = await db
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.assessmentId, a.id), eq(uploadSessions.clientFingerprint, v.fingerprint), inArray(uploadSessions.status, ["open", "completed"])));
  if (existing && (existing.status === "completed" || existing.expiresAt > new Date())) {
    if (existing.declaredSize !== v.size || existing.declaredMime !== v.mime) throw new ValidationError("The selected file does not match this upload.");
    return existing;
  }
  await db.update(uploadSessions).set({ status: "aborted" }).where(and(eq(uploadSessions.assessmentId, a.id), eq(uploadSessions.status, "open"), sql`${uploadSessions.expiresAt} <= now()`));
  const count = (await db.select({ id: mediaAssets.id }).from(mediaAssets).where(eq(mediaAssets.assessmentId, a.id))).length;
  const openCount = (await db.select({ id: uploadSessions.id }).from(uploadSessions).where(and(eq(uploadSessions.assessmentId, a.id), eq(uploadSessions.status, "open")))).length;
  if (count + openCount >= MAX_ASSETS_PER_ASSESSMENT) throw new ValidationError(`Up to ${MAX_ASSETS_PER_ASSESSMENT} files per assessment`);
  const id = crypto.randomUUID();
  const [s] = await db
    .insert(uploadSessions)
    .values({
      id,
      orgId: a.orgId,
      assessmentId: a.id,
      customerId: a.customerId,
      clientFingerprint: v.fingerprint,
      declaredMime: v.mime,
      area: v.area ?? null,
      declaredSize: v.size,
      objectKey: `assessments/${a.id}/quarantine/${id}`,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    })
    .returning();
  if (a.status === "draft") await transitionAssessment(db, a.id, "draft", "uploading");
  return s!;
}

async function loadSession(db: Db, principal: Principal, sessionId: string) {
  if (!z.uuid().safeParse(sessionId).success) throw new NotFoundError("not found");
  const [s] = await db.select().from(uploadSessions).where(eq(uploadSessions.id, sessionId));
  if (!s) throw new NotFoundError("not found");
  const { res } = await assessmentResource(db, principal, s.assessmentId);
  assertAuthorized(principal, "assessment.upload_media", res);
  return s;
}

export async function getUploadSession(db: Db, principal: Principal, sessionId: string) {
  return loadSession(db, principal, sessionId);
}

async function appendUploadChunkLocked(db: Db, store: ObjectStore, principal: Principal, sessionId: string, offset: number, chunk: Buffer) {
  const s = await loadSession(db, principal, sessionId);
  const { a } = await assessmentResource(db, principal, s.assessmentId);
  if (!["draft", "uploading"].includes(a.status)) throw new ValidationError("This screening no longer accepts uploads.");
  if (s.status !== "open") throw new ValidationError("Upload is not open");
  if (s.expiresAt < new Date()) throw new ValidationError("Upload expired; please start again");
  if (chunk.length === 0 || chunk.length > MAX_CHUNK_BYTES) throw new ValidationError("Invalid chunk size");
  if (offset !== s.receivedBytes) return { receivedBytes: s.receivedBytes, conflict: true as const };
  if (offset + chunk.length > s.declaredSize) throw new ValidationError("Chunk exceeds declared size");
  const received = await store.writeAt(s.objectKey, offset, chunk);
  await db
    .update(uploadSessions)
    .set({ receivedBytes: received, updatedAt: new Date() })
    .where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.receivedBytes, offset)));
  return { receivedBytes: received, conflict: false as const };
}

async function completeUploadLocked(db: Db, store: ObjectStore, principal: Principal, sessionId: string) {
  const s = await loadSession(db, principal, sessionId);
  if (s.status === "completed" && s.assetId) return { assetId: s.assetId };
  const { a } = await assessmentResource(db, principal, s.assessmentId);
  if (!["draft", "uploading"].includes(a.status)) throw new ValidationError("This screening no longer accepts uploads.");
  if (s.expiresAt < new Date()) throw new ValidationError("Upload expired; please start again");
  if (s.status !== "open") throw new ValidationError("Upload is not open");
  const onDisk = await store.size(s.objectKey);
  if (s.receivedBytes !== s.declaredSize || onDisk !== s.declaredSize) throw new ValidationError("Upload incomplete");
  const [asset] = await db
    .insert(mediaAssets)
    .values({
      orgId: s.orgId,
      assessmentId: s.assessmentId,
      kind: s.declaredMime.startsWith("video/") ? "video" : "image",
      area: s.area,
      status: "quarantined",
      originalObjectKey: s.objectKey,
      sizeBytes: s.declaredSize,
      retentionUntil: new Date(Date.now() + 365 * 24 * 3600_000), // placeholder retention, PLAN §15.5
    })
    .returning();
  await db.update(uploadSessions).set({ status: "completed", assetId: asset!.id, updatedAt: new Date() }).where(eq(uploadSessions.id, s.id));
  await enqueue(db, { type: JOB_TYPES.mediaProcess, payload: { assetId: asset!.id }, idempotencyKey: `media:${asset!.id}`, orgId: s.orgId });
  await enqueue(db, { type: JOB_TYPES.preObserve, payload: { assessmentId: s.assessmentId }, idempotencyKey: `preobserve:${asset!.id}`, orgId: s.orgId, runAt: new Date(Date.now() + 6000) });
  await audit(db, { orgId: s.orgId, actorType: principal.kind === "customer" ? "customer" : "system", actorId: principal.kind === "customer" ? principal.customerId : null, action: "media.uploaded", resourceType: "media_asset", resourceId: asset!.id, metadata: { kind: asset!.kind, sizeBytes: asset!.sizeBytes } });
  return { assetId: asset!.id };
}

export async function removeMediaAsset(db: Db, store: ObjectStore, principal: Principal, assetId: string) {
  if (!z.uuid().safeParse(assetId).success) throw new NotFoundError("not found");
  const [m] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  if (!m) throw new NotFoundError("not found");
  const { a, res } = await assessmentResource(db, principal, m.assessmentId);
  assertAuthorized(principal, "assessment.edit_draft", res);
  if (!["draft", "uploading"].includes(a.status)) throw new ValidationError("Media can no longer be removed");
  // Early vision may already reference these frames. Preserve the observation
  // history without retaining a dangling frame reference or publishing removed media.
  const frames = await db.select({ id: mediaFrames.id, objectKey: mediaFrames.objectKey }).from(mediaFrames).where(eq(mediaFrames.assetId, m.id));
  if (frames.length) await db.update(observations).set({ frameId: null, status: "superseded" }).where(inArray(observations.frameId, frames.map(f => f.id)));
  await db.delete(mediaAssets).where(eq(mediaAssets.id, m.id));
  const keys = [m.originalObjectKey, m.proxyObjectKey, m.posterObjectKey, ...frames.map(f => f.objectKey)];
  for (const key of new Set(keys)) if (key) await store.delete(key);
}

// ---- Submission & answers --------------------------------------------------------------

export async function submitAssessment(db: Db, principal: Principal, assessmentId: string) {
  const { a, res } = await assessmentResource(db, principal, assessmentId);
  assertAuthorized(principal, "assessment.edit_draft", res);
  const hasDetails = (await db.select({ id: concerns.id }).from(concerns).where(eq(concerns.assessmentId, a.id))).length > 0;
  if (!hasDetails || !a.propertyId) throw new ValidationError("Please tell us what's going on and about the property first");
  // Abandon unfinished uploads; they never become assets.
  await db.update(uploadSessions).set({ status: "aborted" }).where(and(eq(uploadSessions.assessmentId, a.id), eq(uploadSessions.status, "open")));
  const assets = await db.select().from(mediaAssets).where(eq(mediaAssets.assessmentId, a.id));
  const kinds = new Set(assets.map((x) => x.kind));
  const modality = kinds.size === 0 ? "form_only" : kinds.size === 2 ? "mixed" : kinds.has("video") ? "video" : "images";
  await transitionAssessment(db, a.id, a.status as "draft" | "uploading", "queued", { modality, submittedAt: new Date() });
  await enqueue(db, { type: JOB_TYPES.observe, payload: { assessmentId: a.id }, idempotencyKey: `observe:${a.id}:${a.version + 1}`, orgId: a.orgId });
  await audit(db, { orgId: a.orgId, actorType: "customer", actorId: a.customerId, action: "assessment.submitted", resourceType: "assessment", resourceId: a.id, metadata: { modality, assets: assets.length } });
}

/** Questions currently awaiting answers (approved bank only), plus how many remain. */
export async function getOpenQuestions(db: Db, principal: Principal, assessmentId: string) {
  const { a, res } = await assessmentResource(db, principal, assessmentId);
  assertAuthorized(principal, "assessment.read", res);
  const pending = await db.select().from(pendingQuestions).where(eq(pendingQuestions.assessmentId, a.id));
  const answered = new Set((await db.select({ q: answers.questionId }).from(answers).where(eq(answers.assessmentId, a.id))).map((r) => r.q));
  const open = pending
    .filter((p) => !answered.has(p.questionId))
    .sort((x, y) => x.round - y.round || x.position - y.position)
    .map((p) => getQuestion(p.questionId))
    .filter((q): q is NonNullable<typeof q> => !!q);
  return { status: a.status, open, total: pending.length, answered: pending.filter((p) => answered.has(p.questionId)).length };
}

const AnswerInput = z.object({
  answers: z.array(z.object({ questionId: z.string().max(64), value: z.union([z.string().max(64), z.array(z.string().max(64)).max(10)]) })).max(10),
  finish: z.boolean().optional(),
});

export async function submitAnswers(db: Db, principal: Principal, assessmentId: string, input: unknown) {
  const { a, res } = await assessmentResource(db, principal, assessmentId);
  assertAuthorized(principal, "assessment.answer", res);
  if (a.status !== "needs_answers") throw new ValidationError("This assessment isn't waiting for answers");
  const parsed = AnswerInput.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid answers");
  const pending = await db.select().from(pendingQuestions).where(eq(pendingQuestions.assessmentId, a.id));
  const allowed = new Set(pending.map((p) => p.questionId));
  const rows = [];
  for (const ans of parsed.data.answers) {
    const q = getQuestion(ans.questionId);
    if (!q || !allowed.has(q.id)) throw new ValidationError("Unknown question", ans.questionId);
    const value = normalizeAnswer(q, ans.value);
    if (value === null) throw new ValidationError("Please choose one of the listed options", q.id);
    rows.push({ assessmentId: a.id, questionId: q.id, questionBankVersion: QUESTION_BANK_VERSION, value, source: "customer" });
  }
  if (rows.length) await db.insert(answers).values(rows).onConflictDoNothing();
  const answered = new Set((await db.select({ q: answers.questionId }).from(answers).where(and(eq(answers.assessmentId, a.id), inArray(answers.questionId, [...allowed])))).map((r) => r.q));
  const remaining = [...allowed].filter((q) => !answered.has(q));
  if (remaining.length === 0 || parsed.data.finish) {
    await transitionAssessment(db, a.id, "needs_answers", "processing");
    await enqueue(db, { type: JOB_TYPES.synthesize, payload: { assessmentId: a.id }, idempotencyKey: `synth:${a.id}:${a.version + 1}`, orgId: a.orgId });
    await audit(db, { orgId: a.orgId, actorType: "customer", actorId: a.customerId, action: "assessment.answers_completed", resourceType: "assessment", resourceId: a.id, metadata: { answered: answered.size, skipped: remaining.length } });
    return { done: true, remaining: 0 };
  }
  return { done: false, remaining: remaining.length };
}


/** Lock the assessment for upload mutations before touching its files or offsets. */
export async function createUploadSession(db: Db, principal: Principal, cfg: PipelineConfig, assessmentId: string, input: unknown) {
  const { a } = await assessmentResource(db, principal, assessmentId);
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM assessments WHERE id=${a.id}::uuid FOR UPDATE`);
    return createUploadSessionLocked(tx as unknown as Db, principal, cfg, a.id, input);
  });
}
async function withUploadLock<T>(db: Db, principal: Principal, sessionId: string, work: (tx: Db) => Promise<T>) {
  const session = await loadSession(db, principal, sessionId);
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM assessments WHERE id=${session.assessmentId}::uuid FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM upload_sessions WHERE id=${session.id}::uuid FOR UPDATE`);
    return work(tx as unknown as Db);
  });
}
export async function appendUploadChunk(db: Db, store: ObjectStore, principal: Principal, sessionId: string, offset: number, chunk: Buffer) {
  return withUploadLock(db, principal, sessionId, tx => appendUploadChunkLocked(tx, store, principal, sessionId, offset, chunk));
}
export async function completeUpload(db: Db, store: ObjectStore, principal: Principal, sessionId: string) {
  return withUploadLock(db, principal, sessionId, tx => completeUploadLocked(tx, store, principal, sessionId));
}
