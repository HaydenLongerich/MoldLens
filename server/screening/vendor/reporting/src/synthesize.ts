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

/** When a step should happen. Drives the grouped "What to do" list. */
export type StepTiming = "now" | "next" | "ongoing";

/**
 * One line of the "Checks & measurements" table, mirroring what an on-site inspection records.
 * A remote screening never has instrument values, so anything that needs a tool says so.
 */
export interface DiagnosticCheck {
  id: "visual" | "surface" | "moisture" | "humidity" | "thermal" | "odor" | "air";
  label: string;
  /** seen = visible in the media; reviewed = media checked, nothing stood out; reported = customer said so; not_measured = needs a tool; not_reported = nothing raised. */
  status: "seen" | "reviewed" | "reported" | "not_measured" | "not_reported";
  finding: string;
  needs: string;
}

/** What a contractor would likely do next. Descriptive only: no prices, sizes or durations. */
export interface ProfessionalOutlook {
  inspectionFocus: { area: string; items: string[] }[];
  typicalWork: { step: string; detail: string }[];
  quoteChecklist: string[];
  costNote: string;
}

export interface ReportContent {
  schemaVersion: "report-v2";
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
  recommendations: { id: string; when: StepTiming; text: string; rationale: string; evidenceRefs: EvidenceRef[] }[];
  checks: DiagnosticCheck[];
  professional: ProfessionalOutlook;
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

// What an on-site inspector typically checks per area. Based on the structure of real
// inspection reports (moisture, ventilation, insulation, drainage), with no values.
const INSPECTION_FOCUS: Record<string, string[]> = {
  basement: ["Foundation walls and floor edges for moisture", "Humidity and air circulation", "Grading and drainage outside, near the foundation"],
  bathroom: ["Moisture behind tiles and around the tub, shower and sink", "Caulking, grout and the ceiling above the shower", "Whether the exhaust fan clears moisture"],
  kitchen: ["Under the sink and behind appliances for leaks", "Range hood venting"],
  laundry: ["Washer hoses and the wall behind the machines", "The dryer vent path to the outdoors"],
  bedroom: ["Exterior walls, corners and behind furniture", "Windows and ceiling for water marks"],
  living: ["Exterior walls, corners and behind furniture", "Windows and ceiling for water marks"],
  attic: ["Roof boards and framing", "Insulation coverage and soffit ventilation", "Roof leaks, and exhaust fans that vent into the attic"],
  hvac_vents: ["Inside vents and ductwork", "Condensation on ducts and around the furnace or air conditioner"],
  windows: ["Sills, frames and the wall below for water damage", "Where condensation collects"],
  exterior: ["Grading, gutters and downspouts", "Cracks or gaps where water can get in"],
  other: ["The area you described, with moisture and thermal checks"],
};

// Materials commonly involved when work is done in an area (from real remediation scopes).
const AREA_MATERIALS: Record<string, string> = {
  basement: "framing, concrete and drywall",
  bathroom: "caulking, grout, tile and the drywall ceiling",
  kitchen: "cabinet bases and drywall behind appliances",
  laundry: "drywall behind the machines and the dryer duct",
  attic: "roof boards, trusses and insulation",
  hvac_vents: "vent grilles and ductwork",
  windows: "sills, frames and nearby drywall",
};

const QUOTE_CHECKLIST = [
  "Which areas and materials are covered",
  "What gets removed and what gets cleaned in place",
  "How the work area is sealed off from the rest of the home",
  "Estimated time, and whether you need to stay out during the work",
  "How the result is checked at the end, and whether a written clearance report is included",
  "What isn't included (repairs and rebuilding often aren't)",
  "Deposit, how long the quote is valid, and cancellation terms",
  "What happens if more damage is found once work starts",
];

const COST_NOTE =
  "Cost depends on the size of the area, access and materials. Only a contractor who has assessed the space can price the work, so this screening does not estimate cost.";

const TIMING_ORDER: Record<StepTiming, number> = { now: 0, next: 1, ongoing: 2 };

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
      findings.push({
        id: `F${++findingSeq}`,
        kind: cat === "poor_visibility" ? "poor_visibility" : "visual",
        statement:
          cat === "poor_visibility"
            ? `Some views were too unclear to assess: ${locations}.`
            : `${CATEGORY_PHRASE[cat]}: ${locations}.`,
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
  const seenCats = new Set(snap.observations.map((o) => o.category));
  const dampProne =
    snap.assessment.areas.some((a) => ["basement", "bathroom", "laundry", "windows", "attic"].includes(a)) || concernSet.has("condensation");
  if (priority === "prompt")
    recommendations.push({
      id: "stop_water",
      when: "now",
      text: "Stop the water if it is safe to do so, and dry wet materials quickly.",
      rationale: "You reported active water. Materials that stay wet for more than a day or two are much harder to save.",
      evidenceRefs: [...answerRef(snap, "leak_ongoing"), ...answerRef(snap, "water_event_timing")],
    });
  if (visualFindings.length > 0 || concernSet.has("visible_spots"))
    recommendations.push({
      id: "leave_undisturbed",
      when: "now",
      text: "Leave discolored areas alone for now.",
      rationale: "Scraping, sanding or tearing out material can release particles into the air.",
      evidenceRefs: allVisualRefs.slice(0, 3),
    });
  if (answerIs(snap, "hvac_maintenance", "landlord"))
    recommendations.push({ id: "notify_manager", when: "now", text: "Tell your landlord or building manager in writing.", rationale: "Building systems and repairs may be their responsibility. Keep a dated copy with your photos.", evidenceRefs: answerRef(snap, "hvac_maintenance") });
  const waterOrSpots = ["visible_spots", "water_damage", "active_leak", "flooding", "musty_odor"].some((c) => concernSet.has(c));
  if (priority !== "routine" || visualFindings.length > 0 || waterOrSpots) {
    recommendations.push({
      id: "professional_inspection",
      when: "next",
      text: "Book an on-site inspection.",
      rationale: "Only on-site tools can measure moisture inside materials, find hidden damp spots and test surfaces or air.",
      evidenceRefs: [...allVisualRefs, ...answerRef(snap, "leak_ongoing"), ...answerRef(snap, "affected_size")].slice(0, 8),
    });
  }
  if (answerIs(snap, "dryer_vent", "indoors"))
    recommendations.push({ id: "dryer_outdoors", when: "next", text: "Have the clothes dryer vented outdoors.", rationale: "Venting a dryer indoors adds a lot of moisture to the air.", evidenceRefs: answerRef(snap, "dryer_vent") });
  if (answerIs(snap, "hvac_maintenance", "over_year"))
    recommendations.push({ id: "hvac_service", when: "next", text: "Have vents, ducts and filters serviced by an HVAC technician.", rationale: "You reported no maintenance in over a year.", evidenceRefs: answerRef(snap, "hvac_maintenance") });
  if (answerIs(snap, "bath_ventilation", "rarely", "none_or_broken"))
    recommendations.push({ id: "bath_fan", when: "next", text: "Run, repair or install a bathroom exhaust fan.", rationale: "You reported the fan is missing, broken or rarely used.", evidenceRefs: answerRef(snap, "bath_ventilation") });
  if (answerIs(snap, "dehumidification", "none"))
    recommendations.push({ id: "dehumidify", when: "ongoing", text: "Run a dehumidifier here and check humidity with a hygrometer.", rationale: "You reported no dehumidifier in a damp-prone area.", evidenceRefs: answerRef(snap, "dehumidification") });
  else if (dampProne)
    recommendations.push({ id: "track_humidity", when: "ongoing", text: "Check indoor humidity with a hygrometer.", rationale: "It's an inexpensive way to see if the air is too damp. This screening cannot measure humidity.", evidenceRefs: [] });
  recommendations.push({
    id: "monitor",
    when: "ongoing",
    text: "Take dated photos of the same spots every few weeks.",
    rationale: "Changes over time help you and any professional you consult.",
    evidenceRefs: [],
  });
  recommendations.sort((a, b) => TIMING_ORDER[a.when] - TIMING_ORDER[b.when]);

  // ---- Checks & measurements (honest: never a value) ------------------------------------
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const mediaCount = [snap.media.images ? plural(snap.media.images, "photo") : "", snap.media.videos ? plural(snap.media.videos, "video") : ""].filter(Boolean).join(" and ");
  const reviewed = hasMedia && snap.model.visualReviewCompleted && snap.media.framesUsable > 0;
  const surfaceSeen = seenCats.has("discoloration") || seenCats.has("staining");
  const odorWhere = answer(snap, "odor_location");
  const odorQ = getQuestion("odor_location");
  const odorDetail = odorWhere && odorQ && !answerIs(snap, "odor_location", "not_sure") ? ` Strongest: ${answerLabel(odorQ, odorWhere).toLowerCase()}.` : "";
  const checks: DiagnosticCheck[] = [
    {
      id: "visual",
      label: "Visible surfaces",
      status: reviewed ? (visualFindings.length ? "seen" : "reviewed") : "not_measured",
      finding: reviewed
        ? visualFindings.length
          ? `Reviewed ${mediaCount}. Areas worth a closer look are listed above.`
          : `Reviewed ${mediaCount}. No clear visible signs stood out.`
        : hasMedia
          ? "Your media could not be reviewed clearly."
          : "No photos or video were provided.",
      needs: "Clear photos or a short video, or an on-site visual inspection",
    },
    {
      id: "surface",
      label: "What the discoloration is",
      status: surfaceSeen ? "seen" : concernSet.has("visible_spots") ? "reported" : "not_reported",
      finding: surfaceSeen
        ? "Discoloration or staining is visible in your media. Appearance alone can't tell what it is."
        : concernSet.has("visible_spots")
          ? "You reported spots or discoloration. Appearance alone can't tell what it is."
          : "No discoloration was reported or seen.",
      needs: "Surface swab or tape sample, taken by an inspector",
    },
    {
      id: "moisture",
      label: "Moisture inside materials",
      status: "not_measured",
      finding: answerIs(snap, "leak_ongoing", "yes")
        ? "Not measured. You reported it is wet or leaking right now."
        : seenCats.has("moisture_indicator") || seenCats.has("staining")
          ? "Not measured. Your media shows possible signs of water, but images can't show how damp a material is."
          : concernSet.has("water_damage") || concernSet.has("flooding") || concernSet.has("active_leak")
            ? "Not measured. You reported water damage, a leak or flooding."
            : "Not measured.",
      needs: "Moisture meter",
    },
    {
      id: "humidity",
      label: "Indoor humidity",
      status: "not_measured",
      finding: concernSet.has("condensation")
        ? "Not measured. You reported condensation or damp surfaces, which often go with humid air."
        : "Not measured.",
      needs: "Hygrometer (humidity meter). Inexpensive home models work.",
    },
    {
      id: "thermal",
      label: "Hidden damp or cold spots",
      status: "not_measured",
      finding: "Not checked. Damp areas behind walls and ceilings don't show up in ordinary photos.",
      needs: "Thermal camera, followed up with a moisture meter",
    },
    {
      id: "odor",
      label: "Musty smell",
      status: concernSet.has("musty_odor") ? "reported" : "not_reported",
      finding: concernSet.has("musty_odor") ? `You reported a musty or earthy smell.${odorDetail}` : "No smell was reported.",
      needs: "Smell can only be checked in person",
    },
    {
      id: "air",
      label: "Airborne spores",
      status: "not_measured",
      finding: "Not tested. Air quality can't be judged from photos or answers.",
      needs: "Air sampling analysed by an accredited lab",
    },
  ];

  // ---- What a professional would do -------------------------------------------------------
  const focusAreas = [...new Set(snap.assessment.areas)].filter((a) => INSPECTION_FOCUS[a]);
  const materials = focusAreas.map((a) => AREA_MATERIALS[a]).filter(Boolean);
  const professional: ProfessionalOutlook = {
    inspectionFocus: focusAreas.map((a) => ({ area: labelFor(AREAS, a), items: INSPECTION_FOCUS[a]! })),
    typicalWork: [
      { step: "Seal off the area", detail: "Plastic sheeting and zipper doors, often with negative air pressure, keep dust from spreading to the rest of the home." },
      {
        step: "Remove or treat affected materials",
        detail: `Damaged porous materials are removed and bagged. Solid surfaces are cleaned with HEPA vacuuming and a treatment product.${materials.length ? ` In your areas this often involves ${materials.join("; ")}.` : ""}`,
      },
      { step: "Clean the space", detail: "HEPA vacuuming and fogging of the sealed-off area, then cleanup of the work path." },
      { step: "Check the result", detail: "A visual check and surface tests after the work, usually with a written clearance report." },
      { step: "Fix the moisture source", detail: "Leaks, ventilation, insulation or drainage. Often done by another trade, such as a plumber or roofer. Without this, the problem can return." },
    ],
    quoteChecklist: QUOTE_CHECKLIST,
    costNote: COST_NOTE,
  };

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
  if (priority === "prompt") points.push("You reported active water. Stopping it comes first.");
  if (visualFindings.length) points.push(`Visible signs in: ${visualAreas.join(", ")}. Photos are linked below.`);
  if (concernSet.has("musty_odor")) points.push("You reported a musty smell. Smells can't be checked remotely.");
  points.push("Moisture, humidity and air quality need on-site tools. None were measured.");

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
    schemaVersion: "report-v2",
    reportType: REPORT_TYPE_LABEL,
    reference: snap.assessment.reference,
    generatedAt: now.toISOString(),
    outcome,
    outcomeReasons,
    priority,
    priorityReasons,
    property: { region: labelFor(REGIONS, snap.assessment.region), type: labelFor(PROPERTY_TYPES, snap.assessment.propertyType) },
    method: hasMedia
      ? `${snap.model.isMock ? "Demo processing (no AI vision model)" : snap.model.provider !== "none" ? "AI-assisted remote review" : "Remote review"} of the ${mediaCount} you submitted, plus your answers. No site visit.`
      : "Review of your written answers only. No photos, video or site visit.",
    summary: { headline, points },
    customerContext,
    areas,
    evidenceGallery: snap.observations.filter((o) => o.category !== "poor_visibility").map(observationRef),
    highlights: pickHighlights(snap, (a) => (a === "unspecified" ? "Area not specified" : labelFor(AREAS, a))),
    unknowns,
    safetyGuidance,
    recommendations,
    checks,
    professional,
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
