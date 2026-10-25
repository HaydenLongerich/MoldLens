import type { StaffRole } from "./enums";

/**
 * Deny-by-default authorization (PLAN §9). Pure function: the server resolves the
 * principal and the resource facts from the database, then asks `authorize`.
 * Nothing produced by a model can reach this function as a principal.
 */

export type Principal =
  | { kind: "anonymous" }
  | { kind: "customer"; orgId: string; customerId: string; userId?: string | null; emailVerified: boolean }
  | { kind: "staff"; orgId: string; userId: string; role: StaffRole; reauthenticatedAt?: Date | null };

export type Action =
  // customer-facing
  | "assessment.create"
  | "assessment.read"
  | "assessment.edit_draft"
  | "assessment.upload_media"
  | "assessment.answer"
  | "assessment.read_preview"
  | "report.read_full"
  | "media.read"
  // staff operations
  | "assessment.list"
  | "assessment.read_operational" // status, timings, contact-free summary
  | "assessment.override" // corrections with audit trail
  | "assessment.request_access"
  | "access_grant.approve"
  | "client.read"
  | "client.read_contact"
  | "job.read"
  | "job.write"
  | "contractor.read"
  | "contractor.write"
  | "contractor.export"
  | "referral.propose"
  | "referral.approve"
  | "report.manage_templates"
  | "analytics.read"
  | "audit.read"
  | "settings.read"
  | "settings.write_roles"
  | "settings.write_billing"
  | "settings.write_ai_policy"
  | "payment.refund";

export interface ResourceContext {
  orgId?: string;
  /** Customer profile that owns the assessment / report / media. */
  ownerCustomerId?: string | null;
  /** Staff member the case is assigned to. */
  assignedStaffId?: string | null;
  /** Staff user IDs holding an active, unexpired, approved elevated-access grant. */
  activeGrantUserIds?: readonly string[];
  /** Service job assignee (service_worker scope). */
  jobAssigneeId?: string | null;
  /** Whether the requesting customer holds an active entitlement for the full report. */
  entitled?: boolean;
  /** Assessment status, for draft-only edits. */
  status?: string;
}

export interface Decision {
  allowed: boolean;
  reason: string;
}

const RANK: Record<StaffRole, number> = { service_worker: 0, staff: 1, manager: 2, owner: 3 };
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

const allow = (reason: string): Decision => ({ allowed: true, reason });
const deny = (reason: string): Decision => ({ allowed: false, reason });

function atLeast(role: StaffRole, min: StaffRole) {
  return RANK[role] >= RANK[min];
}

function recentlyReauthenticated(p: Extract<Principal, { kind: "staff" }>, now: Date) {
  return !!p.reauthenticatedAt && now.getTime() - p.reauthenticatedAt.getTime() <= REAUTH_WINDOW_MS;
}

/** Staff case access: assigned, or holding an approved time-limited grant. Manager+ is org-wide. */
function staffHasCaseAccess(p: Extract<Principal, { kind: "staff" }>, r: ResourceContext): Decision {
  if (atLeast(p.role, "manager")) return allow("manager_org_wide");
  if (p.role === "service_worker") {
    return r.jobAssigneeId && r.jobAssigneeId === p.userId ? allow("job_scoped") : deny("not_job_assignee");
  }
  if (r.assignedStaffId && r.assignedStaffId === p.userId) return allow("assigned");
  if (r.activeGrantUserIds?.includes(p.userId)) return allow("elevated_grant");
  return deny("not_assigned_no_grant");
}

export function authorize(principal: Principal, action: Action, resource: ResourceContext = {}, now = new Date()): Decision {
  // Tenant boundary first: every resource with an org must match the principal's org.
  if (principal.kind !== "anonymous" && resource.orgId && resource.orgId !== principal.orgId) {
    return deny("cross_org");
  }

  if (action === "assessment.create") {
    return principal.kind === "staff" ? deny("staff_cannot_create_customer_assessment") : allow("public_intake");
  }

  if (principal.kind === "anonymous") return deny("unauthenticated");

  // ---- Customers: only their own records, never staff actions --------------------------
  if (principal.kind === "customer") {
    const owns = !!resource.ownerCustomerId && resource.ownerCustomerId === principal.customerId;
    switch (action) {
      case "assessment.read":
      case "assessment.read_preview":
      case "media.read":
      case "assessment.answer":
        return owns ? allow("owner") : deny("not_owner");
      case "assessment.upload_media":
        return owns ? allow("owner") : deny("not_owner");
      case "assessment.edit_draft":
        if (!owns) return deny("not_owner");
        return resource.status === "draft" || resource.status === "uploading" ? allow("owner_draft") : deny("not_draft");
      case "report.read_full":
        if (!owns) return deny("not_owner");
        return resource.entitled ? allow("owner_entitled") : deny("no_entitlement");
      default:
        return deny("customer_forbidden_action");
    }
  }

  // ---- Staff -------------------------------------------------------------------------------
  const p = principal;
  switch (action) {
    case "assessment.list":
    case "assessment.read_operational":
    case "job.read":
    case "contractor.read":
    case "referral.propose":
    case "assessment.request_access":
      return atLeast(p.role, "staff") ? allow("staff") : deny("role_too_low");
    case "client.read":
      return atLeast(p.role, "staff") ? allow("staff") : deny("role_too_low");
    case "assessment.read":
    case "media.read":
    case "report.read_full":
    case "client.read_contact":
      return staffHasCaseAccess(p, resource);
    case "assessment.read_preview":
      return staffHasCaseAccess(p, resource);
    case "job.write":
      if (p.role === "service_worker") return staffHasCaseAccess(p, resource);
      return atLeast(p.role, "staff") ? allow("staff") : deny("role_too_low");
    case "assessment.override":
    case "access_grant.approve":
    case "contractor.write":
    case "referral.approve":
    case "analytics.read":
    case "audit.read":
    case "settings.read":
    case "report.manage_templates":
      return atLeast(p.role, "manager") ? allow("manager") : deny("role_too_low");
    case "contractor.export":
    case "settings.write_roles":
    case "settings.write_billing":
    case "settings.write_ai_policy":
    case "payment.refund":
      if (p.role !== "owner") return deny("owner_only");
      return recentlyReauthenticated(p, now) ? allow("owner_recent_reauth") : deny("reauth_required");
    case "assessment.edit_draft":
    case "assessment.upload_media":
    case "assessment.answer":
      return deny("customer_only_action");
    default: {
      const exhaustive: never = action;
      return deny(`unknown_action:${String(exhaustive)}`);
    }
  }
}

export class ForbiddenError extends Error {
  constructor(
    readonly action: Action,
    readonly reason: string,
  ) {
    super(`Forbidden: ${action} (${reason})`);
    this.name = "ForbiddenError";
  }
}

export function assertAuthorized(principal: Principal, action: Action, resource?: ResourceContext, now?: Date): Decision {
  const d = authorize(principal, action, resource, now);
  if (!d.allowed) throw new ForbiddenError(action, d.reason);
  return d;
}
