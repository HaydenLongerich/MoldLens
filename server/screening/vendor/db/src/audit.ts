import { redact } from "@mb/observability";
import { auditEvents } from "./schema";
import type { Db } from "./client";

export interface AuditInput {
  orgId?: string | null;
  actorType: "customer" | "staff" | "system" | "anonymous";
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  traceId?: string | null;
}

/** Append-only audit record. Metadata is redacted before storage. */
export async function audit(db: Db, e: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    orgId: e.orgId ?? null,
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    action: e.action,
    resourceType: e.resourceType,
    resourceId: e.resourceId ?? null,
    metadata: (redact(e.metadata ?? {}) as Record<string, unknown>) ?? {},
    traceId: e.traceId ?? null,
  });
}
