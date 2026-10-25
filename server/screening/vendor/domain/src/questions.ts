import type { AreaId, ConcernId, ObservationCategory } from "./enums";

/**
 * Approved, versioned follow-up question bank (PLAN §7.1 SelectFollowups).
 * Deterministic rules choose from this set. A model may later *rank* within the
 * eligible set, but can never author a question. Every question offers "Not sure".
 *
 * NOTE: wording is a placeholder pending Mold Busters business/safety review (PLAN §15.2).
 */
export const QUESTION_BANK_VERSION = "qb-2026.10-draft1";

export const NOT_SURE = "not_sure";

export interface QuestionOption {
  value: string;
  label: string;
}

export interface Question {
  id: string;
  text: string;
  help?: string;
  kind: "single" | "multi";
  options: QuestionOption[];
  /** Base priority (higher = asked earlier). */
  priority: number;
  /** Fires when any of these match. Empty triggers = never auto-selected. */
  triggers: {
    areas?: AreaId[];
    concerns?: ConcernId[];
    observations?: ObservationCategory[];
    always?: boolean;
  };
  /** Answers to this question can change safety guidance; never skipped when triggered. */
  safetyRelevant?: boolean;
  /** Optional, sensitive: user can skip without penalty. Never used for diagnosis. */
  optional?: boolean;
}

const notSure: QuestionOption = { value: NOT_SURE, label: "Not sure" };

export const QUESTION_BANK: readonly Question[] = [
  {
    id: "leak_ongoing",
    text: "Is it wet or leaking right now?",
    kind: "single",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No, it's dry" },
      notSure,
    ],
    priority: 100,
    triggers: { concerns: ["active_leak", "water_damage", "flooding"], observations: ["moisture_indicator"] },
    safetyRelevant: true,
  },
  {
    id: "water_event_timing",
    text: "When did the water problem happen?",
    kind: "single",
    options: [
      { value: "within_48h", label: "Last 48 hours" },
      { value: "within_week", label: "Last week" },
      { value: "within_months", label: "Last few months" },
      { value: "longer", label: "Longer ago" },
      notSure,
    ],
    priority: 90,
    triggers: { concerns: ["flooding", "water_damage"] },
    safetyRelevant: true,
  },
  {
    id: "affected_size",
    text: "How big is the largest affected area?",
    help: "1 m² is a square about 1 m by 1 m.",
    kind: "single",
    options: [
      { value: "under_1m2", label: "Under 1 m²" },
      { value: "1_to_3m2", label: "1 to 3 m²" },
      { value: "over_3m2", label: "Over 3 m²" },
      { value: "multiple_areas", label: "Several separate spots" },
      notSure,
    ],
    priority: 85,
    triggers: { concerns: ["visible_spots", "water_damage"], observations: ["discoloration", "staining", "material_damage"] },
    safetyRelevant: true,
  },
  {
    id: "recurrence",
    text: "Has this happened here before?",
    kind: "single",
    options: [
      { value: "recurring", label: "Yes, it keeps coming back" },
      { value: "once", label: "Once before" },
      { value: "no", label: "No, it's new" },
      notSure,
    ],
    priority: 70,
    triggers: { areas: ["basement", "bathroom", "windows"], concerns: ["water_damage", "flooding", "condensation"] },
  },
  {
    id: "odor_location",
    text: "Where is the smell strongest?",
    kind: "single",
    options: [
      { value: "one_room", label: "One room or area" },
      { value: "near_vents", label: "Near vents" },
      { value: "whole_home", label: "Whole home" },
      notSure,
    ],
    priority: 75,
    triggers: { concerns: ["musty_odor"] },
  },
  {
    id: "bath_ventilation",
    text: "Is there a working bathroom fan that gets used?",
    kind: "single",
    options: [
      { value: "used", label: "Yes, used often" },
      { value: "rarely", label: "Yes, rarely used" },
      { value: "none_or_broken", label: "No fan or broken" },
      notSure,
    ],
    priority: 65,
    triggers: { areas: ["bathroom"] },
  },
  {
    id: "hvac_maintenance",
    text: "When were vents or filters last cleaned?",
    kind: "single",
    options: [
      { value: "within_year", label: "Within a year" },
      { value: "over_year", label: "Over a year ago" },
      { value: "landlord", label: "Landlord handles it" },
      notSure,
    ],
    priority: 60,
    triggers: { areas: ["hvac_vents"], observations: ["ventilation_component"] },
  },
  {
    id: "dryer_vent",
    text: "Does the dryer vent outdoors?",
    kind: "single",
    options: [
      { value: "outdoors", label: "Yes" },
      { value: "indoors", label: "No, indoors" },
      { value: "no_dryer", label: "No dryer" },
      notSure,
    ],
    priority: 58,
    triggers: { areas: ["laundry"] },
  },
  {
    id: "dehumidification",
    text: "Is a dehumidifier used in this area?",
    kind: "single",
    options: [
      { value: "dehumidifier", label: "Yes" },
      { value: "none", label: "No" },
      notSure,
    ],
    priority: 45,
    triggers: { areas: ["basement"], concerns: ["condensation"] },
  },
];

/** Routine cap. Kept short on purpose: every question must be able to change the advice. */
export const ROUTINE_QUESTION_CAP = 4;

export interface FollowupContext {
  areas: readonly AreaId[];
  concerns: readonly ConcernId[];
  observationCategories: readonly ObservationCategory[];
  answeredQuestionIds: readonly string[];
  /** Raise cap only with a recorded justification (e.g. safety). */
  capOverride?: { cap: number; justification: string };
  /**
   * Optional ranking from the vision model (approved IDs only, most useful first).
   * When present, only ranked questions plus triggered safety questions are asked.
   */
  ranking?: readonly string[];
}

export interface SelectedQuestion {
  question: Question;
  score: number;
  reasons: string[];
}

/**
 * Deterministic selection: filter by triggers, skip already-answered, rank by
 * priority + number of matching signals, cap at 4 (safety-relevant questions first).
 */
export function selectFollowups(ctx: FollowupContext, bank: readonly Question[] = QUESTION_BANK): SelectedQuestion[] {
  const answered = new Set(ctx.answeredQuestionIds);
  const selected: SelectedQuestion[] = [];
  for (const q of bank) {
    if (answered.has(q.id)) continue;
    const reasons: string[] = [];
    for (const a of q.triggers.areas ?? []) if (ctx.areas.includes(a)) reasons.push(`area:${a}`);
    for (const c of q.triggers.concerns ?? []) if (ctx.concerns.includes(c)) reasons.push(`concern:${c}`);
    for (const o of q.triggers.observations ?? []) if (ctx.observationCategories.includes(o)) reasons.push(`observation:${o}`);
    if (q.triggers.always) reasons.push("always");
    if (reasons.length === 0) continue;
    let score = q.priority + (reasons.length - 1) * 5 + (q.safetyRelevant ? 50 : 0);
    if (ctx.ranking) {
      const rank = ctx.ranking.indexOf(q.id);
      if (rank === -1 && !q.safetyRelevant) continue; // model judged it unnecessary given the media
      if (rank !== -1) {
        score += 200 - rank * 10;
        reasons.push(`model_rank:${rank + 1}`);
      }
    }
    selected.push({ question: q, score, reasons });
  }
  // Safety-relevant questions always come first; then model rank / rule score.
  selected.sort((a, b) => Number(!!b.question.safetyRelevant) - Number(!!a.question.safetyRelevant) || b.score - a.score || a.question.id.localeCompare(b.question.id));
  const cap = ctx.capOverride?.cap ?? ROUTINE_QUESTION_CAP;
  return selected.slice(0, cap);
}

export function getQuestion(id: string): Question | undefined {
  return QUESTION_BANK.find((q) => q.id === id);
}

/** Validate an answer against the approved options. Returns normalized value or null. */
export function normalizeAnswer(q: Question, value: unknown): string | string[] | null {
  const allowed = new Set(q.options.map((o) => o.value));
  if (q.kind === "single") {
    return typeof value === "string" && allowed.has(value) ? value : null;
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  const vals = [...new Set(value.filter((v): v is string => typeof v === "string"))];
  if (vals.length === 0 || vals.some((v) => !allowed.has(v))) return null;
  if (vals.includes(NOT_SURE) && vals.length > 1) return null;
  return vals;
}

export function answerLabel(q: Question, value: string | string[]): string {
  const vals = Array.isArray(value) ? value : [value];
  return vals.map((v) => q.options.find((o) => o.value === v)?.label ?? v).join(", ");
}
