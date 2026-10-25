import type { AssessmentStatus } from "./enums";

/**
 * Core assessment processing state machine (PLAN §6).
 * Payment, report versions, jobs and referrals have their own independent machines;
 * payment state never overwrites processing state.
 */
const ASSESSMENT_TRANSITIONS: Record<AssessmentStatus, readonly AssessmentStatus[]> = {
  draft: ["uploading", "queued"], // queued directly for form-only submissions
  uploading: ["queued", "draft", "failed"],
  queued: ["processing", "failed"],
  processing: ["needs_answers", "ready_preview", "inconclusive", "failed"],
  needs_answers: ["processing"],
  // A customer may add evidence to an inconclusive / ready case, which re-queues it.
  ready_preview: ["queued"],
  inconclusive: ["queued"],
  failed: ["queued"], // admin/system retry
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid ${machine} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransitionAssessment(from: AssessmentStatus, to: AssessmentStatus): boolean {
  return ASSESSMENT_TRANSITIONS[from].includes(to);
}

export function assertAssessmentTransition(from: AssessmentStatus, to: AssessmentStatus): void {
  if (!canTransitionAssessment(from, to)) throw new InvalidTransitionError("assessment", from, to);
}

export const TERMINAL_RESULT_STATUSES: readonly AssessmentStatus[] = ["ready_preview", "inconclusive", "failed"];

/** Customer-facing phase labels. Honest phases, no fabricated percentages. */
export function customerPhase(status: AssessmentStatus): { step: number; label: string } {
  switch (status) {
    case "draft":
      return { step: 0, label: "Draft" };
    case "uploading":
      return { step: 1, label: "Uploading" };
    case "queued":
      return { step: 2, label: "Preparing your media" };
    case "processing":
      return { step: 3, label: "Reviewing evidence" };
    case "needs_answers":
      return { step: 4, label: "A few questions for you" };
    case "ready_preview":
    case "inconclusive":
      return { step: 5, label: "Results ready" };
    case "failed":
      return { step: 5, label: "We couldn't finish processing" };
  }
}

// ---------------------------------------------------------------------------
// Payment (PLAN §6). Entitlements are issued/revoked only from verified webhook events.
export const PAYMENT_STATUSES = ["created", "pending", "succeeded", "failed", "cancelled", "refunded", "disputed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ["pending", "succeeded", "failed", "cancelled"],
  pending: ["succeeded", "failed", "cancelled"],
  succeeded: ["refunded", "disputed"],
  failed: [],
  cancelled: [],
  refunded: [],
  disputed: ["succeeded", "refunded"],
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return from === to || PAYMENT_TRANSITIONS[from].includes(to);
}

export function entitlementStateForPayment(status: PaymentStatus): "active" | "revoked" | "none" {
  if (status === "succeeded") return "active";
  if (status === "refunded" || status === "disputed") return "revoked";
  return "none";
}

// ---------------------------------------------------------------------------
// Report versions
export const REPORT_STATUSES = ["draft", "validated", "rejected", "published", "superseded"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

// Service jobs (admin pipeline)
export const SERVICE_JOB_STATUSES = ["new", "contacted", "scheduled", "in_progress", "completed", "closed_lost", "cancelled"] as const;
export type ServiceJobStatus = (typeof SERVICE_JOB_STATUSES)[number];

// Referrals (always admin-initiated, consent-gated)
export const REFERRAL_STATUSES = ["proposed", "awaiting_consent", "approved", "contacted", "accepted", "declined", "withdrawn"] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];
