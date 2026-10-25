import { findProhibited, GUIDANCE_LIBRARY, STANDARD_DISCLOSURE } from "@mb/domain";
import type { ReportContent, ReportInputSnapshot } from "./synthesize";

/**
 * Deterministic report gate (PLAN §7.1 ValidateReport). Fails closed:
 *  - model-written observation text with prohibited claims is excluded BEFORE synthesis;
 *  - any remaining violation, ungrounded claim or missing disclosure → not publishable.
 */

export interface ValidationIssue {
  code: "prohibited_assertion" | "ungrounded_claim" | "unknown_evidence_ref" | "missing_disclosure" | "urgency_guidance_missing" | "empty_report";
  path: string;
  detail: string;
}

export interface ValidationResult {
  passed: boolean;
  issues: ValidationIssue[];
  checkedStrings: number;
}

/** Remove model observations whose text breaks policy. Returns the clean snapshot and what was removed. */
export function sanitizeSnapshot(snap: ReportInputSnapshot): { snapshot: ReportInputSnapshot; removed: { id: string; rules: string[] }[] } {
  const removed: { id: string; rules: string[] }[] = [];
  const observations = snap.observations.filter((o) => {
    const text = [o.location, o.neutralDescription, ...o.alternativeExplanations, ...o.limitations].join(" \n ");
    const hits = findProhibited(text);
    if (hits.length) {
      removed.push({ id: o.id, rules: hits.map((h) => h.id) });
      return false;
    }
    return true;
  });
  return { snapshot: { ...snap, observations }, removed };
}

export function validateReport(content: ReportContent, snap: ReportInputSnapshot): ValidationResult {
  const issues: ValidationIssue[] = [];
  let checked = 0;
  const check = (path: string, text: string) => {
    checked++;
    for (const hit of findProhibited(text)) issues.push({ code: "prohibited_assertion", path, detail: `${hit.id}: ${hit.reason}` });
  };

  // Generated strings only. Customer statements (customerContext) are shown verbatim, labelled, and not our claims.
  check("summary.headline", content.summary.headline);
  content.summary.points.forEach((p, i) => check(`summary.points[${i}]`, p));
  content.unknowns.forEach((u, i) => check(`unknowns[${i}]`, u));
  content.checklist.forEach((c, i) => check(`checklist[${i}]`, c));
  content.limitations.forEach((l, i) => check(`limitations[${i}]`, l));
  content.recommendations.forEach((r, i) => {
    check(`recommendations[${i}].text`, r.text);
    check(`recommendations[${i}].rationale`, r.rationale);
  });

  (content.highlights ?? []).forEach((h, i) => {
    check(`highlights[${i}].location`, h.location);
    check(`highlights[${i}].description`, h.description);
  });

  const known = new Set<string>([
    ...snap.observations.map((o) => o.id),
    ...snap.answers.map((a) => a.id),
    ...snap.concerns.map((c) => c.id),
    ...Object.keys(GUIDANCE_LIBRARY),
  ]);

  content.areas.forEach((a, ai) =>
    a.findings.forEach((f, fi) => {
      const p = `areas[${ai}].findings[${fi}]`;
      check(`${p}.statement`, f.statement);
      f.alternatives.forEach((x, i) => check(`${p}.alternatives[${i}]`, x));
      if (f.evidenceRefs.length === 0) issues.push({ code: "ungrounded_claim", path: p, detail: "Finding has no evidence reference" });
      for (const r of f.evidenceRefs) if (!known.has(r.id)) issues.push({ code: "unknown_evidence_ref", path: p, detail: `Unknown evidence ${r.type}:${r.id}` });
      if (f.kind === "visual" && !f.evidenceRefs.some((r) => r.type === "visual_observation")) {
        issues.push({ code: "ungrounded_claim", path: p, detail: "Visual finding without visual evidence" });
      }
    }),
  );
  content.recommendations.forEach((r, i) => {
    for (const e of r.evidenceRefs) if (!known.has(e.id)) issues.push({ code: "unknown_evidence_ref", path: `recommendations[${i}]`, detail: `Unknown evidence ${e.id}` });
  });

  if (content.disclosure !== STANDARD_DISCLOSURE) issues.push({ code: "missing_disclosure", path: "disclosure", detail: "Standard disclosure missing or altered" });
  if (content.priority === "prompt" && !content.safetyGuidance.some((g) => g.id === "active_water")) {
    issues.push({ code: "urgency_guidance_missing", path: "safetyGuidance", detail: "Urgent case without active-water guidance" });
  }
  if (content.outcome !== "inconclusive" && content.areas.length === 0 && content.customerContext.length === 0) {
    issues.push({ code: "empty_report", path: "areas", detail: "Report has no findings or context" });
  }

  return { passed: issues.length === 0, issues, checkedStrings: checked };
}

/**
 * Free preview projection: summary, unknowns, safety guidance, recommendations headline.
 * Safety-critical information is always included (PLAN §0.4).
 */
export function toPreview(content: ReportContent) {
  return {
    reference: content.reference,
    reportType: content.reportType,
    generatedAt: content.generatedAt,
    outcome: content.outcome,
    outcomeReasons: content.outcomeReasons,
    priority: content.priority,
    priorityReasons: content.priorityReasons,
    summary: content.summary,
    areasCovered: content.areas.map((a) => ({ label: a.label, findingCount: a.findings.filter((f) => f.kind === "visual").length })),
    evidenceCount: content.evidenceGallery.length,
    highlights: content.highlights ?? [],
    unknowns: content.unknowns.slice(0, 3),
    safetyGuidance: content.safetyGuidance,
    recommendations: content.recommendations.map((r) => ({ id: r.id, text: r.text })),
    disclosure: content.disclosure,
    provenance: { isMock: content.provenance.isMock, generatedAt: content.generatedAt },
  };
}
export type ReportPreview = ReturnType<typeof toPreview>;
