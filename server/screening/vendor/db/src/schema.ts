import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Data model (PLAN §5). Conventions:
 * - Every tenant-owned row carries org_id (single org today, boundary from day one).
 * - No media bytes in the database; only private object keys.
 * - Financial and audit rows are never cascade-deleted (ON DELETE RESTRICT).
 * - `version` columns enable optimistic concurrency on mutable aggregates.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const id = () => uuid("id").primaryKey().defaultRandom();

// --- Identity & tenancy -------------------------------------------------------------------

export const organizations = pgTable("organizations", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  locale: text("locale").notNull().default("en-CA"),
  serviceRegions: jsonb("service_regions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  policyVersion: text("policy_version").notNull(),
  settings: jsonb("settings").$type<OrgSettings>().notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});

export interface OrgSettings {
  reportPrice?: { amountCents: number; currency: string; label: string; approved: boolean };
  supportPhone?: string;
  supportEmail?: string;
  retentionDays?: { media: number; reports: number };
  ai?: { provider: string; visionModel: string; maxFramesPerRun: number; budgetUsdPerRun: number };
}

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(), // stored lower-cased
  displayName: text("display_name"),
  identityProviderId: text("identity_provider_id"),
  status: text("status").notNull().default("active"),
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    role: text("role").notNull(), // customer | staff | manager | owner | service_worker
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_user_org_uq").on(t.userId, t.orgId)],
);

export const customerProfiles = pgTable(
  "customer_profiles",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    userId: uuid("user_id").references(() => users.id),
    email: text("email"),
    contactName: text("contact_name"),
    phone: text("phone"),
    emailVerifiedAt: ts("email_verified_at"),
    createdAt: createdAt(),
  },
  (t) => [index("customer_profiles_org_idx").on(t.orgId), index("customer_profiles_user_idx").on(t.userId)],
);

/** Opaque session tokens; only the SHA-256 hash is stored. */
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    kind: text("kind").notNull(), // customer | staff
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    userId: uuid("user_id").references(() => users.id),
    customerId: uuid("customer_id").references(() => customerProfiles.id),
    reauthenticatedAt: ts("reauthenticated_at"),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_customer_idx").on(t.customerId)],
);

export const magicLinks = pgTable("magic_links", {
  tokenHash: text("token_hash").primaryKey(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  email: text("email").notNull(),
  purpose: text("purpose").notNull(), // customer_verify | staff_login
  customerId: uuid("customer_id").references(() => customerProfiles.id),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
});

export const consents = pgTable(
  "consents",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    customerId: uuid("customer_id").notNull().references(() => customerProfiles.id),
    assessmentId: uuid("assessment_id"),
    kind: text("kind").notNull(), // ai_processing | media_storage | transcription | marketing | referral_sharing
    granted: boolean("granted").notNull(),
    textVersion: text("text_version").notNull(),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("consents_customer_idx").on(t.customerId, t.kind)],
);

// --- Assessments ------------------------------------------------------------------------

export const properties = pgTable("properties", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  customerId: uuid("customer_id").notNull().references(() => customerProfiles.id),
  propertyType: text("property_type").notNull(),
  approximateRegion: text("approximate_region").notNull(),
  exactAddressEncrypted: text("exact_address_encrypted"),
  createdAt: createdAt(),
});

export const assessments = pgTable(
  "assessments",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    reference: text("reference").notNull().unique(),
    customerId: uuid("customer_id").notNull().references(() => customerProfiles.id),
    propertyId: uuid("property_id").references(() => properties.id),
    status: text("status").notNull().default("draft"),
    modality: text("modality").notNull().default("form_only"),
    assignedStaffId: uuid("assigned_staff_id").references(() => users.id),
    policyVersion: text("policy_version").notNull(),
    priority: text("priority"), // routine | soon | prompt (set by rules)
    lastErrorCode: text("last_error_code"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    submittedAt: ts("submitted_at"),
    completedAt: ts("completed_at"),
  },
  (t) => [
    index("assessments_org_status_idx").on(t.orgId, t.status, t.createdAt),
    index("assessments_customer_idx").on(t.customerId),
    index("assessments_assigned_idx").on(t.assignedStaffId),
  ],
);

export const concerns = pgTable(
  "concerns",
  {
    id: id(),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
    area: text("area").notNull(),
    issueTypes: jsonb("issue_types").$type<string[]>().notNull(),
    statement: text("statement"), // customer's own words (customer_statement evidence)
    createdAt: createdAt(),
  },
  (t) => [index("concerns_assessment_idx").on(t.assessmentId)],
);

export const answers = pgTable(
  "answers",
  {
    id: id(),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull(),
    questionBankVersion: text("question_bank_version").notNull(),
    value: jsonb("value").$type<string | string[]>().notNull(),
    source: text("source").notNull().default("customer"), // customer | staff_correction
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("answers_assessment_question_source_uq").on(t.assessmentId, t.questionId, t.source)],
);

/** Questions the rules engine selected for this case (versioned, auditable). */
export const pendingQuestions = pgTable(
  "pending_questions",
  {
    id: id(),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull(),
    questionBankVersion: text("question_bank_version").notNull(),
    position: integer("position").notNull(),
    score: integer("score").notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull(),
    round: integer("round").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("pending_questions_uq").on(t.assessmentId, t.questionId)],
);

// --- Media ----------------------------------------------------------------------------------

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").notNull().references(() => customerProfiles.id),
    clientFingerprint: text("client_fingerprint").notNull(), // name+size+mtime hash from browser for resume
    declaredMime: text("declared_mime").notNull(),
    area: text("area"),
    declaredSize: bigint("declared_size", { mode: "number" }).notNull(),
    receivedBytes: bigint("received_bytes", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("open"), // open | completed | aborted | expired
    objectKey: text("object_key").notNull(),
    assetId: uuid("asset_id"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("upload_sessions_assessment_idx").on(t.assessmentId)],
);

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // video | image
    area: text("area"), // optional customer tag: which area this media shows
    status: text("status").notNull().default("quarantined"),
    originalObjectKey: text("original_object_key").notNull(),
    proxyObjectKey: text("proxy_object_key"),
    posterObjectKey: text("poster_object_key"),
    sha256: text("sha256"),
    mime: text("mime"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    durationMs: integer("duration_ms"),
    width: integer("width"),
    height: integer("height"),
    hasAudio: boolean("has_audio"),
    rejectionReason: text("rejection_reason"),
    retentionUntil: ts("retention_until"),
    createdAt: createdAt(),
  },
  (t) => [index("media_assets_assessment_idx").on(t.assessmentId), index("media_assets_sha_idx").on(t.assessmentId, t.sha256)],
);

export const mediaFrames = pgTable(
  "media_frames",
  {
    id: id(),
    assetId: uuid("asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
    timestampMs: integer("timestamp_ms"), // null for still images
    objectKey: text("object_key").notNull(),
    sceneIndex: integer("scene_index").notNull().default(0),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sharpness: real("sharpness").notNull(),
    brightness: real("brightness").notNull(),
    qualityFlags: jsonb("quality_flags").$type<string[]>().notNull(),
    selected: boolean("selected").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("media_frames_asset_idx").on(t.assetId, t.timestampMs), index("media_frames_assessment_idx").on(t.assessmentId)],
);

/** Immutable manifest of a processed asset (enforced by trigger). */
export const mediaManifests = pgTable("media_manifests", {
  id: id(),
  assetId: uuid("asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  manifest: jsonb("manifest").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: createdAt(),
});

export const transcriptSegments = pgTable("transcript_segments", {
  id: id(),
  assetId: uuid("asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  text: text("text").notNull(),
  createdAt: createdAt(),
});

// --- Evidence & reasoning -----------------------------------------------------------------

export const assessmentRuns = pgTable(
  "assessment_runs",
  {
    id: id(),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    stage: text("stage").notNull(), // observe | synthesize | ...
    state: text("state").notNull(), // running | succeeded | failed
    modelProvider: text("model_provider"),
    modelConfig: jsonb("model_config"),
    promptVersion: text("prompt_version"),
    ruleVersion: text("rule_version"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    imageCount: integer("image_count").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
    durationMs: integer("duration_ms"),
    errorCode: text("error_code"),
    traceId: text("trace_id"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("assessment_runs_assessment_idx").on(t.assessmentId, t.startedAt)],
);

export const observations = pgTable(
  "observations",
  {
    id: id(),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => assessmentRuns.id),
    frameId: uuid("frame_id").references(() => mediaFrames.id),
    evidenceType: text("evidence_type").notNull().default("visual_observation"),
    category: text("category").notNull(),
    location: text("location").notNull(),
    neutralDescription: text("neutral_description").notNull(),
    visibility: text("visibility").notNull(),
    strength: text("strength").notNull(),
    alternativeExplanations: jsonb("alternative_explanations").$type<string[]>().notNull(),
    limitations: jsonb("limitations").$type<string[]>().notNull(),
    /** Approximate highlight box {x,y,width,height} as fractions of the frame. */
    region: jsonb("region").$type<{ x: number; y: number; width: number; height: number } | null>(),
    modelVersion: text("model_version").notNull(),
    status: text("status").notNull().default("active"), // active | superseded | rejected_by_staff
    createdAt: createdAt(),
  },
  (t) => [index("observations_assessment_idx").on(t.assessmentId, t.status)],
);

export const findings = pgTable(
  "findings",
  {
    id: id(),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
    reportVersionId: uuid("report_version_id"),
    kind: text("kind").notNull(),
    assertion: text("assertion").notNull(),
    evidenceRefs: jsonb("evidence_refs").notNull(),
    uncertainty: text("uncertainty").notNull(),
    policyRuleRefs: jsonb("policy_rule_refs").$type<string[]>().notNull(),
    recommendationRefs: jsonb("recommendation_refs").$type<string[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("findings_assessment_idx").on(t.assessmentId)],
);

export const reportVersions = pgTable(
  "report_versions",
  {
    id: id(),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    kind: text("kind").notNull(), // preview | full
    status: text("status").notNull(), // draft | validated | rejected | published | superseded
    outcome: text("outcome").notNull(), // qualified | inconclusive
    content: jsonb("content").notNull(),
    validation: jsonb("validation").notNull(),
    inputSnapshotHash: text("input_snapshot_hash").notNull(),
    htmlKey: text("html_key"),
    pdfKey: text("pdf_key"),
    disclosure: text("disclosure").notNull(),
    policyVersion: text("policy_version").notNull(),
    generatedAt: ts("generated_at").notNull().defaultNow(),
    createdBy: text("created_by").notNull().default("system"),
  },
  (t) => [uniqueIndex("report_versions_uq").on(t.assessmentId, t.kind, t.version)],
);

// --- Commerce (PLAN §6: verified webhooks only) -----------------------------------------

export const orders = pgTable(
  "orders",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    customerId: uuid("customer_id").notNull().references(() => customerProfiles.id, { onDelete: "restrict" }),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "restrict" }),
    productVersion: text("product_version").notNull(),
    amountCents: integer("amount_cents").notNull(),
    taxCents: integer("tax_cents").notNull(),
    currency: text("currency").notNull(),
    provider: text("provider").notNull(), // stripe | mock
    paymentProviderId: text("payment_provider_id"),
    status: text("status").notNull().default("created"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("orders_assessment_idx").on(t.assessmentId), uniqueIndex("orders_provider_uq").on(t.provider, t.paymentProviderId)],
);

export const paymentEvents = pgTable("payment_events", {
  providerEventId: text("provider_event_id").primaryKey(), // idempotency ledger
  provider: text("provider").notNull(),
  type: text("type").notNull(),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
  payload: jsonb("payload").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
  processedAt: ts("processed_at"),
});

export const entitlements = pgTable(
  "entitlements",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id").notNull().references(() => customerProfiles.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    scope: text("scope").notNull().default("full_report"),
    state: text("state").notNull(), // active | revoked
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("entitlements_order_uq").on(t.orderId), index("entitlements_assessment_idx").on(t.assessmentId, t.customerId)],
);

// --- Operations -------------------------------------------------------------------------

export const accessGrants = pgTable(
  "access_grants",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    assessmentId: uuid("assessment_id").notNull().references(() => assessments.id, { onDelete: "cascade" }),
    staffUserId: uuid("staff_user_id").notNull().references(() => users.id),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("requested"), // requested | approved | denied | revoked
    decidedBy: uuid("decided_by").references(() => users.id),
    expiresAt: ts("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [index("access_grants_lookup_idx").on(t.assessmentId, t.staffUserId, t.status)],
);

export const serviceJobs = pgTable(
  "service_jobs",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    assessmentId: uuid("assessment_id").references(() => assessments.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id").references(() => customerProfiles.id),
    assignedStaffId: uuid("assigned_staff_id").references(() => users.id),
    status: text("status").notNull().default("new"),
    requestedServices: jsonb("requested_services").$type<string[]>().notNull(),
    notes: text("notes"),
    dueAt: ts("due_at"),
    referralStatus: text("referral_status"),
    syncState: jsonb("sync_state").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("service_jobs_org_status_idx").on(t.orgId, t.status)],
);

export const contractors = pgTable("contractors", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  services: jsonb("services").$type<string[]>().notNull(),
  serviceAreas: jsonb("service_areas").$type<{ postalPrefixes: string[]; regions: string[]; radiusKm?: number | null; baseLat?: number | null; baseLng?: number | null }>().notNull(),
  contact: jsonb("contact").$type<{ phone?: string; email?: string; website?: string }>().notNull(),
  credentialStatus: text("credential_status").notNull().default("not_verified"),
  credentials: jsonb("credentials").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  availabilityNote: text("availability_note"),
  availabilitySource: text("availability_source"),
  availabilityAsOf: ts("availability_as_of"),
  qualityNotes: text("quality_notes"),
  verificationAt: ts("verification_at"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const contractorRates = pgTable("contractor_rates", {
  id: id(),
  contractorId: uuid("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
  serviceType: text("service_type").notNull(),
  rateType: text("rate_type").notNull(), // fixed | starting | hourly | quote_only
  amountCents: integer("amount_cents"),
  currency: text("currency").notNull().default("CAD"),
  conditions: text("conditions"),
  source: text("source").notNull(),
  verifiedAt: ts("verified_at"),
});

export const referrals = pgTable("referrals", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  jobId: uuid("job_id").notNull().references(() => serviceJobs.id, { onDelete: "restrict" }),
  contractorId: uuid("contractor_id").notNull().references(() => contractors.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("proposed"),
  disclosedFields: jsonb("disclosed_fields").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  consentId: uuid("consent_id").references(() => consents.id),
  proposedBy: uuid("proposed_by").references(() => users.id),
  approvedBy: uuid("approved_by").references(() => users.id),
  outcome: text("outcome"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Append-only (UPDATE/DELETE blocked by trigger). Metadata must be pre-redacted. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    orgId: uuid("org_id"),
    actorType: text("actor_type").notNull(), // customer | staff | system | anonymous
    actorId: text("actor_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    traceId: text("trace_id"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_resource_idx").on(t.resourceType, t.resourceId, t.createdAt), index("audit_events_org_idx").on(t.orgId, t.createdAt)],
);

// --- Durable jobs & outbox -----------------------------------------------------------------

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    orgId: uuid("org_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("queued"), // queued | running | succeeded | failed | dead
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: ts("run_at").notNull().defaultNow(),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    traceId: text("trace_id"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("jobs_claim_idx").on(t.status, t.runAt)],
);

export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    orgId: uuid("org_id"),
    kind: text("kind").notNull(), // email
    recipient: text("recipient").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("pending"), // pending | sent | failed | suppressed
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: createdAt(),
    sentAt: ts("sent_at"),
  },
  (t) => [index("outbox_status_idx").on(t.status, t.createdAt)],
);
