// Shared vocabularies. Keep values stable: they are persisted in the database.

export const STAFF_ROLES = ["staff", "manager", "owner", "service_worker"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const ROLES = ["customer", ...STAFF_ROLES] as const;
export type Role = (typeof ROLES)[number];

export const ASSESSMENT_STATUSES = [
  "draft",
  "uploading",
  "queued",
  "processing",
  "needs_answers",
  "ready_preview",
  "inconclusive",
  "failed",
] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

export const MODALITIES = ["video", "images", "mixed", "form_only"] as const;
export type Modality = (typeof MODALITIES)[number];

export const AREAS = [
  { id: "basement", label: "Basement" },
  { id: "bathroom", label: "Bathroom" },
  { id: "kitchen", label: "Kitchen" },
  { id: "laundry", label: "Laundry area" },
  { id: "bedroom", label: "Bedroom" },
  { id: "living", label: "Living area" },
  { id: "attic", label: "Attic" },
  { id: "hvac_vents", label: "Vents / ductwork" },
  { id: "windows", label: "Windows / sills" },
  { id: "exterior", label: "Exterior / foundation" },
  { id: "other", label: "Other" },
] as const;
export type AreaId = (typeof AREAS)[number]["id"];
export const AREA_IDS = AREAS.map((a) => a.id) as [AreaId, ...AreaId[]];

export const CONCERNS = [
  { id: "musty_odor", label: "Musty or earthy smell" },
  { id: "visible_spots", label: "Spots or discoloration" },
  { id: "water_damage", label: "Water damage or stains" },
  { id: "active_leak", label: "Active leak or dripping" },
  { id: "flooding", label: "Recent flooding" },
  { id: "condensation", label: "Condensation / damp surfaces" },
  { id: "peeling_paint", label: "Peeling paint or bubbling" },
  { id: "not_sure", label: "Not sure, something seems off" },
] as const;
export type ConcernId = (typeof CONCERNS)[number]["id"];
export const CONCERN_IDS = CONCERNS.map((c) => c.id) as [ConcernId, ...ConcernId[]];

export const PROPERTY_TYPES = [
  { id: "house", label: "House" },
  { id: "apartment", label: "Apartment / condo" },
  { id: "townhouse", label: "Townhouse" },
  { id: "commercial", label: "Commercial space" },
  { id: "other", label: "Other" },
] as const;
export type PropertyTypeId = (typeof PROPERTY_TYPES)[number]["id"];
export const PROPERTY_TYPE_IDS = PROPERTY_TYPES.map((p) => p.id) as [PropertyTypeId, ...PropertyTypeId[]];

// Approximate region only. Exact address is collected later, encrypted, and only if needed.
export const REGIONS = [
  { id: "ON", label: "Ontario" },
  { id: "QC", label: "Quebec" },
  { id: "other_ca", label: "Elsewhere in Canada" },
  { id: "outside_ca", label: "Outside Canada" },
] as const;
export type RegionId = (typeof REGIONS)[number]["id"];
export const REGION_IDS = REGIONS.map((r) => r.id) as [RegionId, ...RegionId[]];

/**
 * Evidence types are never merged: a customer statement is not a visual observation,
 * and neither is an instrument measurement. Report claims must cite one of these.
 */
export const EVIDENCE_TYPES = [
  "visual_observation", // model-described content of a frame/photo (neutral description)
  "customer_statement", // self-reported by the customer (form/answers)
  "instrument_measurement", // verified technician instrument record (never inferred from consumer media)
  "model_inference", // model reasoning over other evidence; always lower standing than its inputs
  "professional_finding", // finding recorded by a qualified Mold Busters professional
  "reference_guidance", // vetted, versioned knowledge-base excerpt
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const OBSERVATION_CATEGORIES = [
  "discoloration",
  "staining",
  "moisture_indicator",
  "material_damage",
  "ventilation_component",
  "plumbing_component",
  "poor_visibility",
  "context",
] as const;
export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];

export const EVIDENCE_STRENGTH = ["weak", "moderate", "clear"] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTH)[number];

export const MEDIA_KINDS = ["video", "image"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_STATUSES = ["uploading", "quarantined", "validated", "processing", "ready", "rejected", "failed"] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export function labelFor<T extends { id: string; label: string }>(list: readonly T[], id: string): string {
  return list.find((x) => x.id === id)?.label ?? id;
}
