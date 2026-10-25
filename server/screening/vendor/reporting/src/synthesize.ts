import { createHash } from "node:crypto";
import {
  AREAS,
  CONCERNS,
  GUIDANCE_LIBRARY,
  POLICY_VERSION,
  PROPERTY_TYPES,
  QUESTION_BANK_VERSION,
  REGIONS,
  REPORT_TYPE_LABEL,
  STANDARD_DISCLOSURE,
  answerLabel,
  getQuestion,
  labelFor,
  type EvidenceRef,
  type EvidenceStrength,
  type GuidanceEntry,
  type ObservationCategory,
  type Priority,
  type Region,
} from "@mb/domain";

/** Everything synthesis may use. Built by the pipeline from the database; nothing else leaks in. */
export interface ReportInputSnapshot {
  assessment: {
    id: string;
    reference: string;
    region: string;
    propertyType: string;
    areas: string[];
    concerns: string[];
    createdAt: string;
  };
  concerns: { id: string; area: string; issueTypes: string[]; statement: string | null }[];
  observations: {
    id: string;
    frameId: string | null;
    assetId: string | null;
    area: string | null;
    timestampMs: number | null;
    sourceLabel: string;
    category: ObservationCategory;
    location: string;
    neutralDescription: string;
    visibility: "good" | "limited" | "poor";
    strength: EvidenceStrength;
    alternativeExplanations: string[];
    limitations: string[];
    region: Region | null;
  }[];
  answers: { id: string; questionId: string; value: string | string[] }[];
  media: { videos: number; images: number; framesTotal: number; framesUsable: number; framesAnalyzed: number };
  model: { provider: string; model: string; promptVersion: string; isMock: boolean; overallLimitations: string[]; visualReviewCompleted: boolean };
}

export type ReportOutcome = "qualified" | "limited" | "inconclusive";

export interface ReportFinding {
  id: string;
  kind: "visual" | "reported_only" | "poor_visibility";
  statement: string;
  strength: EvidenceStrength | null;
  evidenceRefs: EvidenceRef[];
  alternatives: string[];
  missing: string[];
}

export interface ReportContent {
  schemaVersion: "report-v1";
  reportType: string;
  reference: string;
  generatedAt: string;
  outcome: ReportOutcome;
  outcomeReasons: string[];
  priority: Priority;
  priorityReasons: string[];
  property: { region: string; type: string };
  method: string;
  summary: { headline: string; points: string[] };
  customerContext: { label: string; value: string; evidenceRef: EvidenceRef }[];
  areas: { area: string; label: string; findings: ReportFinding[] }[];
  evidenceGallery: EvidenceRef[];
  /** The clearest frame per visual finding, with what is visible and an approximate box. Shown in the free results. */
  highlights: Highlight[];
  unknowns: string[];
  safetyGuidance: GuidanceEntry[];
  recommendations: { id: string; text: string; rationale: string; evidenceRefs: EvidenceRef[] }[];
  checklist: string[];
  limitations: string[];
  disclosure: string;
  provenance: {
    modelProvider: string;
    model: string;
    promptVersion: string;
    isMock: boolean;
    ruleVersion: string;
    policyVersion: string;
    questionBankVersion: string;
    inputSnapshotHash: string;
    /** Set when the summary was written by a text model (and passed the gate). */
    summaryModel?: string;
  };
}

export interface Highlight {
  observationId: string;
  frameId: string;
  sourceLabel: string;
  timestampMs: number | null;
  area: string;
  category: ObservationCategory;
  location: string;
  description: string;
  strength: EvidenceStrength;
  region: Region | null;
}

const HIGHLIGHT_CATEGORIES: ObservationCategory[] = ["discoloration", "staining", "moisture_indicator", "material_damage", "ventilation_component", "plumbing_component"];

/**
 * Frames that show a visible feature, strongest first, one image per frame, max 6.
 * A topic (area + category + location) may appear twice so a video moment can sit next to a sharper photo.
 */
export function pickHighlights(snap: ReportInputSnapshot, areaLabel: (a: string) => string, max = 6): Highlight[] {
  const usable = snap.observations
    .filter((o) => o.frameId && HIGHLIGHT_CATEGORIES.includes(o.category))
    .sort((a, b) => STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength] || Number(!!b.region) - Number(!!a.region) || (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
  const seenFrames = new Set<string>();
  const topicCount = new Map<string, number>();
  const out: Highlight[] = [];
  for (const o of usable) {
    const topic = `${o.area}|${o.category}|${o.location.toLowerCase()}`;
    if (seenFrames.has(o.frameId!) || (topicCount.get(topic) ?? 0) >= 2) continue;
    seenFrames.add(o.frameId!);
    topicCount.set(topic, (topicCount.get(topic) ?? 0) + 1);
    out.push({
      observationId: o.id,
      frameId: o.frameId!,
      sourceLabel: o.sourceLabel,
      timestampMs: o.timestampMs,
      area: areaLabel(o.area ?? "unspecified"),
      category: o.category,
      location: o.location,
      description: o.neutralDescription,
      strength: o.strength,
      region: o.region,
    });
    if (out.length >= max) break;
  }
  return out;
}

export const RULE_VERSION = "rules-2026.10-moldlens1";

const CATEGORY_PHRASE: Record<ObservationCategory, string> = {
  discoloration: "Discoloration",
  staining: "Staining",
  moisture_indicator: "Possible moisture indicators",
  material_damage: "Visible material damage",
  ventilation_component: "Ventilation components with visible surface changes",
  plumbing_component: "Plumbing components with visible surface changes",
  poor_visibility: "Areas that could not be seen clearly",
  context: "General context",
};

const CATEGORY_MISSING: Partial<Record<ObservationCategory, string[]>> = {
  discoloration: ["What the discoloration is (appearance alone cannot tell)", "Whether the material behind or around it is damp"],
  staining: ["Whether the staining is old or still active", "Where the water came from"],
  moisture_indicator: ["Actual moisture levels inside the material (needs a moisture meter)"],
  material_damage: ["How far the damage extends behind the surface"],
  ventilation_component: ["Condition inside the ductwork beyond what's visible", "Whether condensation forms in the system"],
  plumbing_component: ["Whether there is an active leak at connections"],
};

const STRENGTH_RANK: Record<EvidenceStrength, number> = { weak: 0, moderate: 1, clear: 2 };

export function canonicalHash(value: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canon(value))).digest("hex");
}

function fmtTs(ms: number | null): string {
  if (ms == null) return "";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function observationRef(o: ReportInputSnapshot["observations"][number]): EvidenceRef {
  return {
    type: "visual_observation",
    id: o.id,
    label: `${o.sourceLabel}${o.timestampMs != null ? ` at ${fmtTs(o.timestampMs)}` : ""}, ${o.location}`,
    frameId: o.frameId ?? undefined,
    assetId: o.assetId ?? undefined,
    timestampMs: o.timestampMs,
    region: o.region,
  };
}

function answer(snap: ReportInputSnapshot, qid: string): string | string[] | undefined {
  return snap.answers.find((a) => a.questionId === qid)?.value;
}
function answerIs(snap: ReportInputSnapshot, qid: string, ...vals: string[]): boolean {
  const v = answer(snap, qid);
  if (v === undefined) return false;
  return (Array.isArray(v) ? v : [v]).some((x) => vals.includes(x));
}
function answerRef(snap: ReportInputSnapshot, qid: string): EvidenceRef[] {
  const a = snap.answers.find((x) => x.questionId === qid);
  if (!a) return [];
  const q = getQuestion(qid);
  return [{ type: "customer_statement", id: a.id, label: q ? `Your answer: ${q.text}, ${answerLabel(q, a.value)}` : `Your answer (${qid})` }];
}

export function synthesizeReport(snap: ReportInputSnapshot, now = new Date()): ReportContent {
  const inputSnapshotHash = canonicalHash(snap);
  const hasMedia = snap.media.videos + snap.media.images > 0;
  const concernSet = new Set(snap.assessment.concerns);

  // ---- Findings by area ------------------------------------------------------------------
  const areaIds = [...new Set([...snap.assessment.areas, ...snap.observations.map((o) => o.area ?? "unspecified")])];
  const areas: ReportContent["areas"] = [];
  let findingSeq = 0;
  for (const area of areaIds) {
    const obs = snap.observations.filter((o) => (o.area ?? "unspecified") === area);
    const findings: ReportFinding[] = [];
    const byCat = new Map<ObservationCategory, typeof obs>();
    for (const o of obs) byCat.set(o.category, [...(byCat.get(o.category) ?? []), o]);
    for (const [cat, list] of byCat) {
      if (cat === "context") continue;
      const locations = [...new Set(list.map((o) => o.location))].slice(0, 3).join("; ");
      const maxStrength = list.reduce<EvidenceStrength>((m, o) => (STRENGTH_RANK[o.strength] > STRENGTH_RANK[m] ? o.strength : m), "weak");
      const frames = new Set(list.map((o) => o.frameId)).size;
      findings.push({
        id: `F${++findingSeq}`,
        kind: cat === "poor_visibility" ? "poor_visibility" : "visual",
        statement:
          cat === "poor_visibility"
            ? `Some frames could not be assessed clearly (${locations}).`
            : `${CATEGORY_PHRASE[cat]} visible in ${frames} ${frames === 1 ? "frame" : "frames"} (${locations}).`,
        strength: cat === "poor_visibility" ? null : maxStrength,
        evidenceRefs: list.map(observationRef),
        alternatives: [...new Set(list.flatMap((o) => o.alternativeExplanations))].slice(0, 4),
        missing: CATEGORY_MISSING[cat] ?? [],
      });
    }
    // Reported concerns for this area that the media did not show.
    const reported = snap.concerns.filter((c) => c.area === area);
    const visualCount = findings.filter((f) => f.kind === "visual").length;
    for (const c of reported) {
      const labels = c.issueTypes.filter((t) => t !== "not_sure").map((t) => labelFor(CONCERNS, t).toLowerCase());
      if (labels.length === 0) continue;
      if (visualCount > 0 && !c.issueTypes.includes("musty_odor")) continue;
      const odorOnly = c.issueTypes.includes("musty_odor") && visualCount > 0;
      findings.push({
        id: `F${++findingSeq}`,
        kind: "reported_only",
        statement: odorOnly
          ? "You reported a musty or earthy smell here. Smells are self-reported and cannot be assessed from photos or video."
          : `You reported ${labels.join(", ")} here. ${hasMedia ? "The submitted media did not clearly show this." : "No photos or video were provided for this area."}`,
        strength: null,
        evidenceRefs: [{ type: "customer_statement", id: c.id, label: `Your description of the ${labelFor(AREAS, area).toLowerCase()}` }],
        alternatives: [],
        missing: hasMedia ? ["Clear close-up and wide photos of the affected spot"] : ["Photos or video of this area"],
      });
    }
    if (findings.length) areas.push({ area, label: area === "unspecified" ? "Area not specified" : labelFor(AREAS, area), findings });
  }
  const visualFindings = areas.flatMap((a) => a.findings).filter((f) => f.kind === "visual");

  // ---- Priority (deterministic) ---------------------------------------------------------
  const priorityReasons: string[] = [];
  let priority: Priority = "routine";
  if (answerIs(snap, "leak_ongoing", "yes") || concernSet.has("active_leak")) priorityReasons.push("Active water or leak reported");
  if (answerIs(snap, "water_event_timing", "within_48h")) priorityReasons.push("Water event within the last 48 hours");
  if (priorityReasons.length) priority = "prompt";
  else {
    if (answerIs(snap, "affected_size", "1_to_3m2", "over_3m2", "multiple_areas")) priorityReasons.push("Affected area of 1 m² or more, or several spots");
    if (answerIs(snap, "recurrence", "recurring")) priorityReasons.push("Recurring dampness reported");
    if (visualFindings.some((f) => f.strength === "clear")) priorityReasons.push("Clearly visible features in the media");
    if (priorityReasons.length) priority = "soon";
  }

  // ---- Guidance (always free) -----------------------------------------------------------
  const g = new Set<string>(["moisture_first"]);
  if (visualFindings.length || concernSet.has("visible_spots")) g.add("dont_disturb");
  if (priority === "prompt") g.add("active_water");
  if (answerIs(snap, "affected_size", "over_3m2", "multiple_areas") || answerIs(snap, "recurrence", "recurring")) g.add("larger_area");
  if (answerIs(snap, "hvac_maintenance", "landlord")) g.add("renter");
  if (
    snap.assessment.areas.some((a) => ["bathroom", "laundry", "windows", "kitchen"].includes(a)) ||
    concernSet.has("condensation") ||
    answerIs(snap, "bath_ventilation", "rarely", "none_or_broken") ||
    answerIs(snap, "dryer_vent", "indoors")
  )
    g.add("ventilation");
  const safetyGuidance = [...g].map((id) => GUIDANCE_LIBRARY[id]!).filter(Boolean);

  // ---- Recommendations ------------------------------------------------------------------
  const recommendations: ReportContent["recommendations"] = [];
  const allVisualRefs = visualFindings.flatMap((f) => f.evidenceRefs).slice(0, 6);
  if (priority !== "routine" || visualFindings.length > 0 || concernSet.has("musty_odor")) {
    recommendations.push({
      id: "professional_inspection",
      text: "Consider a professional on-site inspection.",
      rationale:
        "An inspector can measure moisture inside materials, use thermal imaging and, if warranted, take samples for a laboratory, none of which a remote screening can do.",
      evidenceRefs: [...allVisualRefs, ...answerRef(snap, "leak_ongoing"), ...answerRef(snap, "affected_size")].slice(0, 8),
    });
  }
  if (answerIs(snap, "dryer_vent", "indoors"))
    recommendations.push({ id: "dryer_outdoors", text: "Have the clothes dryer vented to the outdoors.", rationale: "Indoor dryer venting adds a large amount of moisture to the air.", evidenceRefs: answerRef(snap, "dryer_vent") });
  if (answerIs(snap, "hvac_maintenance", "over_year"))
    recommendations.push({ id: "hvac_service", text: "Have vents, ducts and filters inspected by a qualified HVAC technician.", rationale: "You reported no recent maintenance.", evidenceRefs: answerRef(snap, "hvac_maintenance") });
  if (answerIs(snap, "hvac_maintenance", "landlord"))
    recommendations.push({ id: "notify_manager", text: "Share these findings with your landlord or building manager.", rationale: "Building systems and repairs may be their responsibility.", evidenceRefs: answerRef(snap, "hvac_maintenance") });
  if (answerIs(snap, "bath_ventilation", "rarely", "none_or_broken"))
    recommendations.push({ id: "bath_fan", text: "Run, repair or install a bathroom exhaust fan.", rationale: "You reported the fan is missing, broken or rarely used.", evidenceRefs: answerRef(snap, "bath_ventilation") });
  if (answerIs(snap, "dehumidification", "none"))
    recommendations.push({ id: "dehumidify", text: "Consider running a dehumidifier in this area and tracking humidity with a hygrometer.", rationale: "You reported no dehumidifier in a damp-prone area.", evidenceRefs: answerRef(snap, "dehumidification") });
  recommendations.push({
    id: "monitor",
    text: "Take dated photos of the same spots over the next few weeks.",
    rationale: "Changes over time are useful information for you and any professional you consult.",
    evidenceRefs: [],
  });

  // ---- Unknowns & checklist -------------------------------------------------------------
  const unknowns = [
    "Whether any discoloration is mold. Appearance alone cannot confirm this.",
    "Moisture levels inside walls, floors or ceilings.",
    "Conditions behind surfaces or in areas not shown.",
  ];
  for (const a of snap.answers) {
    if ((Array.isArray(a.value) ? a.value : [a.value]).includes("not_sure")) {
      const q = getQuestion(a.questionId);
      if (q) unknowns.push(`You weren't sure: "${q.text}"`);
    }
  }
  const checklist: string[] = [];
  const areasSel = new Set(snap.assessment.areas);
  if (areasSel.has("basement")) checklist.push("After heavy rain, check the base of basement walls and floor edges for new water marks.");
  if (areasSel.has("bathroom")) checklist.push("Look under the sink and around the tub or shower base for soft, swollen or stained material.");
  if (areasSel.has("kitchen")) checklist.push("Check under the kitchen sink and behind the dishwasher for drips.");
  if (areasSel.has("laundry")) checklist.push("Check the washer hoses, the area behind the machine and the dryer vent connection for drips or lint build-up.");
  if (areasSel.has("hvac_vents")) checklist.push("Note whether vents or ducts sweat (form droplets) when the system runs.");
  if (areasSel.has("windows")) checklist.push("On cold mornings, note whether condensation collects on windows and sills.");
  if (areasSel.has("attic")) checklist.push("From the hatch only, without disturbing insulation, look for daylight, wet spots or frost on the roof boards.");
  checklist.push("Note when the smell or dampness is worst (after rain, showers, cooking, or seasonally).");

  // ---- Outcome (quality gate input) -----------------------------------------------------
  const outcomeReasons: string[] = [];
  let outcome: ReportOutcome = "qualified";
  if (hasMedia && !snap.model.visualReviewCompleted) {
    outcome = "inconclusive";
    outcomeReasons.push("The automated visual review of your media could not be completed.");
  } else if (hasMedia && snap.media.framesUsable === 0) {
    outcome = "inconclusive";
    outcomeReasons.push("No submitted photos or video frames were suitable for the report; they were unclear or withheld for privacy.");
  } else if (!hasMedia && snap.answers.length < 2) {
    outcome = "inconclusive";
    outcomeReasons.push("Not enough information was provided: no media and too few answers.");
  } else {
    if (!hasMedia) {
      outcome = "limited";
      outcomeReasons.push("No usable photos or video were available; this summary is based only on your answers.");
    }
    if (snap.model.isMock) {
      outcome = "limited";
      outcomeReasons.push("Demo mode: no AI vision model was used. Visual observations come from a simple pixel heuristic.");
    }
    if (hasMedia && visualFindings.length > 0 && visualFindings.every((f) => f.strength === "weak") && outcome === "qualified") {
      outcome = "limited";
      outcomeReasons.push("Visible features were only weakly shown in the media.");
    }
  }

  // ---- Summary ---------------------------------------------------------------------------
  const visualAreas = areas.filter((a) => a.findings.some((f) => f.kind === "visual")).map((a) => a.label.toLowerCase());
  const headline =
    outcome === "inconclusive"
      ? "We couldn't complete a useful screening from the information provided."
      : !hasMedia
        ? "Your answers highlight concerns to discuss with a professional."
        : visualFindings.length
        ? `Your media shows visible features worth a closer look (${visualAreas.join(", ")}).`
        : "We didn't see clear visual signs in your media, but your reported concerns still deserve follow-up.";
  const points: string[] = [];
  if (visualFindings.length) points.push(`${visualFindings.length} visual ${visualFindings.length === 1 ? "finding" : "findings"} across ${visualAreas.length} ${visualAreas.length === 1 ? "area" : "areas"}, each linked to the frame it came from.`);
  if (concernSet.has("musty_odor")) points.push("You reported a musty smell; smells can't be assessed remotely, so this remains a reported concern.");
  if (priority === "prompt") points.push("You reported active water. Stopping the water source comes first.");
  points.push("Appearance alone cannot confirm mold or reveal hidden conditions behind surfaces.");

  // ---- Customer context (self-reported) --------------------------------------------------
  const customerContext: ReportContent["customerContext"] = [];
  for (const c of snap.concerns) {
    customerContext.push({
      label: `${labelFor(AREAS, c.area)}, concerns`,
      value: c.issueTypes.map((t) => labelFor(CONCERNS, t)).join(", "),
      evidenceRef: { type: "customer_statement", id: c.id, label: "Your intake form" },
    });
    if (c.statement) customerContext.push({ label: `${labelFor(AREAS, c.area)}, your description`, value: c.statement, evidenceRef: { type: "customer_statement", id: c.id, label: "Your intake form" } });
  }
  for (const a of snap.answers) {
    const q = getQuestion(a.questionId);
    if (q) customerContext.push({ label: q.text, value: answerLabel(q, a.value), evidenceRef: { type: "customer_statement", id: a.id, label: "Your answer" } });
  }

  const limitations = [
    ...outcomeReasons,
    ...snap.model.overallLimitations,
    hasMedia ? `${snap.media.framesAnalyzed} of ${snap.media.framesTotal} extracted frames were analysed; ${snap.media.framesTotal - snap.media.framesUsable} were unusable or withheld for privacy.` : "No media was analysed. This report uses your written answers and preset screening rules; no AI model was used.",
  ];

  return {
    schemaVersion: "report-v1",
    reportType: REPORT_TYPE_LABEL,
    reference: snap.assessment.reference,
    generatedAt: now.toISOString(),
    outcome,
    outcomeReasons,
    priority,
    priorityReasons,
    property: { region: labelFor(REGIONS, snap.assessment.region), type: labelFor(PROPERTY_TYPES, snap.assessment.propertyType) },
    method: hasMedia
      ? `${snap.model.isMock ? "Demo processing (no AI vision model)" : snap.model.provider !== "none" ? "AI-assisted remote review" : "Remote review"} of ${snap.media.videos} video(s) and ${snap.media.images} photo(s) you submitted, plus your answers. No site visit.`
      : "Review of your written answers only. No photos, video or site visit.",
    summary: { headline, points },
    customerContext,
    areas,
    evidenceGallery: snap.observations.filter((o) => o.category !== "poor_visibility").map(observationRef),
    highlights: pickHighlights(snap, (a) => (a === "unspecified" ? "Area not specified" : labelFor(AREAS, a))),
    unknowns,
    safetyGuidance,
    recommendations,
    checklist,
    limitations,
    disclosure: STANDARD_DISCLOSURE,
    provenance: {
      modelProvider: snap.model.provider,
      model: snap.model.model,
      promptVersion: snap.model.promptVersion,
      isMock: snap.model.isMock,
      ruleVersion: RULE_VERSION,
      policyVersion: POLICY_VERSION,
      questionBankVersion: QUESTION_BANK_VERSION,
      inputSnapshotHash,
    },
  };
}
