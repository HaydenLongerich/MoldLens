export const SCREENING_AREAS = [
  ['basement', 'Basement'], ['bathroom', 'Bathroom'], ['kitchen', 'Kitchen'], ['laundry', 'Laundry area'],
  ['bedroom', 'Bedroom'], ['living', 'Living area'], ['attic', 'Attic'], ['hvac_vents', 'Vents / ductwork'],
  ['windows', 'Windows / sills'], ['exterior', 'Exterior / foundation'], ['other', 'Other'],
] as const;
export const SCREENING_CONCERNS = [
  ['musty_odor', 'Musty smell'], ['visible_spots', 'Spots or discoloration'], ['water_damage', 'Water stains'],
  ['active_leak', 'Active leak'], ['flooding', 'Recent flooding'], ['condensation', 'Condensation'],
  ['peeling_paint', 'Peeling paint'], ['not_sure', 'Not sure'],
] as const;
export const SCREENING_PROPERTY_TYPES = [['house', 'House'], ['apartment', 'Apartment / condo'], ['townhouse', 'Townhouse'], ['commercial', 'Commercial space'], ['other', 'Other']] as const;
export const SCREENING_REGIONS = [['ON', 'Ontario'], ['QC', 'Quebec'], ['other_ca', 'Elsewhere in Canada'], ['outside_ca', 'Outside Canada']] as const;

export type ScreeningStatus = 'draft' | 'uploading' | 'queued' | 'processing' | 'needs_answers' | 'ready_preview' | 'inconclusive' | 'failed';
export interface ScreeningContact { name: string; email: string; postalCode: string; phone?: string; address?: string; }
export interface ScreeningDetails {
  areas: string[]; concerns: string[]; statement?: string; propertyType: string; region: string; contact?: ScreeningContact;
}
export interface ScreeningMedia {
  id: string; name: string; kind: 'image' | 'video';
  status: 'quarantined' | 'validated' | 'processing' | 'ready' | 'rejected' | 'failed';
  rejectionReason?: string | null; sizeBytes: number; mime?: string;
  url?: string; previewUrl?: string; durationMs?: number; width?: number; height?: number; area?: string | null;
}
export interface ScreeningUpload {
  id: string; fingerprint: string; name?: string; receivedBytes: number; declaredSize: number;
  status: 'open' | 'completed' | 'aborted' | 'expired'; expiresAt: string; mime?: string; area?: string | null; assetId?: string | null;
}
export interface ScreeningLimits { maxFiles: number; maxUploadBytes: number; maxVideoSeconds: number; chunkBytes: number; }
export interface ScreeningConfig { limits: ScreeningLimits; ai: { provider: string; configured: boolean; isDemo: boolean }; }
export interface Screening {
  id: string; reference: string; status: ScreeningStatus; phase?: { step: number; label: string };
  details: ScreeningDetails | null; media: ScreeningMedia[]; uploads?: ScreeningUpload[];
  reportAvailable: boolean; linkedRequestId?: string | null; createdAt?: string; updatedAt?: string;
  lastErrorCode?: string | null; lastError?: string | null;
  review?: 'none' | 'running' | 'done' | 'failed'; limits?: ScreeningLimits;
}
export interface ScreeningQuestion {
  id: string; text: string; help?: string; kind: 'single' | 'multi'; optional?: boolean;
  options: { value: string; label: string }[];
}
export interface ScreeningQuestions { status: ScreeningStatus; open: ScreeningQuestion[]; total: number; answered: number; }
export interface ScreeningEvidence { type: string; id: string; label: string; frameId?: string; timestampMs?: number; }
export interface ScreeningFinding {
  id: string; kind: string; statement: string; strength: string | null; evidenceRefs: ScreeningEvidence[];
  alternatives: string[]; missing: string[];
}
export type ScreeningStepTiming = 'now' | 'next' | 'ongoing';
export interface ScreeningCheck {
  id: string; label: string;
  status: 'seen' | 'reviewed' | 'reported' | 'not_measured' | 'not_reported';
  finding: string; needs: string;
}
export interface ScreeningProfessionalOutlook {
  inspectionFocus: { area: string; items: string[] }[];
  typicalWork: { step: string; detail: string }[];
  quoteChecklist: string[];
  costNote: string;
}
export interface ScreeningReport {
  schemaVersion?: string; reportType: string; reference: string; generatedAt: string;
  outcome: 'qualified' | 'limited' | 'inconclusive'; outcomeReasons: string[];
  priority: 'routine' | 'soon' | 'prompt'; priorityReasons: string[];
  property: { region: string; type: string }; method: string; summary: { headline: string; points: string[] };
  customerContext: { label: string; value: string; evidenceRef?: ScreeningEvidence }[];
  areas: { area: string; label: string; findings: ScreeningFinding[] }[]; evidenceGallery: ScreeningEvidence[];
  highlights: {
    observationId: string; frameId: string; sourceLabel: string; timestampMs: number | null; area: string;
    category: string; location: string; description: string; strength: string;
    region: { x: number; y: number; width: number; height: number } | null;
  }[];
  unknowns: string[];
  safetyGuidance: { id: string; title: string; text: string; source?: { publisher?: string; url?: string }; reviewStatus?: string }[];
  recommendations: { id: string; when?: ScreeningStepTiming; text: string; rationale: string; evidenceRefs?: ScreeningEvidence[] }[];
  /** report-v2+. Older reports omit these sections. */
  checks?: ScreeningCheck[];
  professional?: ScreeningProfessionalOutlook;
  checklist: string[]; limitations: string[]; disclosure: string;
  provenance: { modelProvider: string; model: string; isMock: boolean; summaryModel?: string; promptVersion?: string; ruleVersion?: string; policyVersion?: string; questionBankVersion?: string; inputSnapshotHash?: string };
}
export interface ScreeningReportResponse {
  report: ScreeningReport; media: ScreeningMedia[];
  frames: { id: string; url: string; timestampMs?: number | null; assetId?: string }[];
  validation: { passed: boolean }; isDemo: boolean; version?: number;
}
