/**
 * Safety & claims policy (PLAN §7.1 ValidateReport, §7.3, §9, §16).
 * Versioned. Wording is DRAFT pending Mold Busters business, safety and legal review (PLAN §15.2).
 */
export const POLICY_VERSION = "policy-2026.10-moldlens1";

export const REPORT_TYPE_LABEL = "Preliminary Virtual Screening";

export const STANDARD_DISCLOSURE =
  "This is a preliminary virtual screening based only on the information you provided. " +
  "It is not a certified mold inspection. No physical testing, sampling, laboratory analysis, moisture metering or " +
  "thermal imaging was performed. Appearance alone cannot confirm whether mold is present, identify a species, or " +
  "reveal hidden growth behind surfaces. It does not provide medical advice.";

export interface ProhibitedPattern {
  id: string;
  pattern: RegExp;
  reason: string;
}

/**
 * Applied to every synthesized / model-written customer-facing string.
 * Customer statements are displayed verbatim but separately labelled and are not
 * passed through this list (they are not our claims).
 */
export const PROHIBITED_ASSERTIONS: readonly ProhibitedPattern[] = [
  {
    id: "species",
    pattern: /\b(stachybotrys|aspergillus|penicillium|cladosporium|chaetomium|alternaria|fusarium|trichoderma)\b/i,
    reason: "Species cannot be identified from consumer media",
  },
  { id: "toxic", pattern: /\btoxi(c|n|gen)\w*\b/i, reason: "Toxicity cannot be assessed remotely" },
  { id: "black_mold", pattern: /\bblack\s+mou?ld\b/i, reason: "Colour-based mold labelling is misleading" },
  {
    id: "confirm_mold",
    pattern: /\b(confirm\w*|definite\w*|certain\w*|positive\w*|verified)\b[^.]{0,40}\bmou?ld\b|\bmou?ld\b[^.]{0,30}\b(confirmed|detected|is present|was found|identified|verified)\b/i,
    reason: "Mold presence cannot be confirmed from appearance",
  },
  { id: "is_mold", pattern: /\b(this|it|that) (is|looks like definite) mou?ld\b/i, reason: "Unsupported identification" },
  {
    id: "direct_mold_presence",
    pattern: /\bthere\s+(is|are|was|were)\s+(visible\s+)?mou?ld\b|\b(has|have|contains?|shows?)\s+(visible\s+)?mou?ld\b|\bmou?ld\s+(growth\s+)?((has|had|is|was)\s+)?(covers?|covering|spread|spreading|growing|present)\b/i,
    reason: "A visual screening cannot establish mold presence or spread",
  },
  { id: "percentage", pattern: /\b\d+(\.\d+)?\s?%/, reason: "No uncalibrated percentages in generated findings" },
  { id: "probability", pattern: /\b(probability|likelihood score|risk score|\d+\s*(in|out of)\s*\d+ chance)\b/i, reason: "No uncalibrated probability" },
  {
    id: "medical",
    pattern: /\b(diagnos\w*|you (have|are suffering from|suffer from) (a |an )?(disease|illness|infection|condition|allerg\w*|asthma|poisoning|mou?ld (exposure|illness|poisoning))|caus\w* your (symptom\w*|illness\w*|health \w+)|mycotoxicosis|aspergillosis)\b/i,
    reason: "No medical diagnosis",
  },
  {
    id: "physical_test_claim",
    pattern: /\b(lab(oratory)?|swab|air sample|moisture meter|thermal (camera|imag\w*))\b[^.]{0,40}\b(show\w*|confirm\w*|result\w*|reading\w*|indicat\w*)\b/i,
    reason: "No physical test was performed in a virtual screening",
  },
  { id: "certified", pattern: /\b(certified|official) (mou?ld )?inspection\b/i, reason: "Not a certified inspection" },
  { id: "hidden_growth", pattern: /\b(hidden|concealed) (mou?ld|growth)\b[^.]{0,30}\b(is|confirmed|present)\b/i, reason: "Concealed growth cannot be confirmed" },
  { id: "unsupported_reassurance", pattern: /\b(safe to (stay|live|occupy)|no risk|nothing to worry about|completely safe)\b/i, reason: "Unsupported reassurance" },
  { id: "reported_as_detected", pattern: /\b(detected|measured|observed) (an? )?(musty )?(odou?r|smell)\b/i, reason: "Odor is customer-reported, never detected" },
  { id: "cost_estimate", pattern: /\$\s?\d/, reason: "No unverified cost estimates" },
];

// Explicit negations ("cannot confirm mold", "can't be identified") are the honest
// phrasing we want, so they are neutralised before matching. Anything else fails closed.
const NEGATED_CLAIM =
  /\b(cannot|can't|can ?not|could ?not|couldn't|does ?not|doesn't|is ?not|isn't|not|unable to|no way to)\s+(be\s+)?(confirm\w*|identif\w*|determin\w*|tell|diagnos\w*|verif\w*|detect\w*|assess\w*)\b/gi;

export function findProhibited(text: string): ProhibitedPattern[] {
  const t = text.replace(NEGATED_CLAIM, "[negated]")
    .replace(/\b(whether|if)\s+there\s+(is|are|was|were)\s+(any\s+)?mou?ld\b/gi, "[uncertain presence]");
  return PROHIBITED_ASSERTIONS.filter((p) => p.pattern.test(t));
}

// ---------------------------------------------------------------------------
// Vetted guidance library. Always shown free when triggered (PLAN §0.4, §9).
export interface GuidanceEntry {
  id: string;
  title: string;
  text: string;
  source: { title: string; publisher: string; url?: string };
  reviewStatus: "pending_business_review" | "approved";
}

export const GUIDANCE_LIBRARY: Record<string, GuidanceEntry> = {
  dont_disturb: {
    id: "dont_disturb",
    title: "Don't disturb discolored material",
    text:
      "Avoid scraping, sanding, dry-brushing or tearing out discolored or water-damaged materials yourself. " +
      "Disturbing them can release particles into the air. Leave larger or uncertain areas for a professional.",
    source: { title: "Addressing moisture and mould in your home", publisher: "Health Canada", url: "https://www.canada.ca/en/health-canada/services/publications/healthy-living/addressing-moisture-mould-your-home.html" },
    reviewStatus: "pending_business_review",
  },
  moisture_first: {
    id: "moisture_first",
    title: "Moisture is the root cause to address",
    text:
      "Mould needs moisture to grow. Finding and fixing the source of water or dampness (leaks, condensation, " +
      "poor ventilation) matters more than cleaning surfaces, which can come back if moisture remains.",
    source: { title: "Addressing moisture and mould in your home", publisher: "Health Canada", url: "https://www.canada.ca/en/health-canada/services/publications/healthy-living/addressing-moisture-mould-your-home.html" },
    reviewStatus: "pending_business_review",
  },
  active_water: {
    id: "active_water",
    title: "Active water: act now",
    text:
      "If water is actively leaking, stop the source if you can do so safely (for example, close the supply valve), " +
      "keep away from water near electrical outlets or panels, and contact a plumber or your building manager. " +
      "Wet building materials should be dried as soon as possible, ideally within 24 to 48 hours.",
    source: { title: "Mold Busters procedure (pending approval)", publisher: "Mold Busters" },
    reviewStatus: "pending_business_review",
  },
  larger_area: {
    id: "larger_area",
    title: "Larger areas need a professional",
    text:
      "Health Canada guidance treats larger affected areas (over 3 m²), or areas that keep " +
      "coming back, as needing professional help rather than do-it-yourself cleaning.",
    source: { title: "Addressing moisture and mould in your home", publisher: "Health Canada", url: "https://www.canada.ca/en/health-canada/services/publications/healthy-living/addressing-moisture-mould-your-home.html" },
    reviewStatus: "pending_business_review",
  },
  health_professional: {
    id: "health_professional",
    title: "Health questions go to a health professional",
    text:
      "If anyone in the home has health concerns they think may be related to their living conditions, please talk " +
      "with a doctor or other health professional. This screening cannot assess health effects.",
    source: { title: "Mold Busters procedure (pending approval)", publisher: "Mold Busters" },
    reviewStatus: "pending_business_review",
  },
  renter: {
    id: "renter",
    title: "Renters: tell your landlord in writing",
    text:
      "If you rent, notify your landlord or building manager about water or dampness problems in writing and keep a " +
      "dated copy with your photos.",
    source: { title: "Mold Busters procedure (pending approval)", publisher: "Mold Busters" },
    reviewStatus: "pending_business_review",
  },
  ventilation: {
    id: "ventilation",
    title: "Reduce indoor humidity",
    text:
      "Run bathroom and kitchen exhaust fans during and after showers and cooking, make sure clothes dryers vent " +
      "outdoors, and use a dehumidifier in damp areas such as basements.",
    source: { title: "Addressing moisture and mould in your home", publisher: "Health Canada", url: "https://www.canada.ca/en/health-canada/services/publications/healthy-living/addressing-moisture-mould-your-home.html" },
    reviewStatus: "pending_business_review",
  },
};

export type Priority = "routine" | "soon" | "prompt";
export const PRIORITY_LABEL: Record<Priority, string> = {
  routine: "Routine follow-up",
  soon: "Follow up soon",
  prompt: "Address promptly",
};
