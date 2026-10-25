import { z } from "zod/v4";
import { EVIDENCE_STRENGTH, EVIDENCE_TYPES, OBSERVATION_CATEGORIES } from "./enums";

/**
 * Structured output contract for the vision stage (PLAN §7.1 ObserveVisuals).
 * Neutral descriptions only: what is visible, never what it "is" biologically.
 */
export const OBSERVATION_SCHEMA_VERSION = "obs-v1";

export const RegionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Region = z.infer<typeof RegionSchema>;

export const ModelObservationSchema = z.object({
  frameId: z.string().min(1).describe("Exactly one of the frame IDs supplied in the request"),
  category: z.enum(OBSERVATION_CATEGORIES),
  location: z.string().min(1).max(120).describe("Where in the frame / which building component, e.g. 'ceiling vent grille'"),
  neutralDescription: z
    .string()
    .min(1)
    .max(400)
    .describe("Neutral visual description. Do not name mold species, toxicity, or confirm mold."),
  visibility: z.enum(["good", "limited", "poor"]),
  strength: z.enum(EVIDENCE_STRENGTH).describe("How clearly the frame shows this feature"),
  alternativeExplanations: z.array(z.string().max(160)).max(4),
  limitations: z.array(z.string().max(160)).max(4),
  region: RegionSchema.nullable().describe(
    "Approximate bounding box of the feature as fractions of frame width/height (x,y = top-left corner, 0 to 1). Null if it fills the frame or cannot be localised.",
  ),
});

/** Clamp a model-supplied box into the frame; drop degenerate boxes. */
export function sanitizeRegion(r: Region | null | undefined): Region | null {
  if (!r) return null;
  const c = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
  const x = c(r.x);
  const y = c(r.y);
  const width = Math.min(c(r.width), 1 - x);
  const height = Math.min(c(r.height), 1 - y);
  if (width < 0.02 || height < 0.02) return null;
  if (width > 0.95 && height > 0.95) return null; // whole frame: no useful highlight
  return { x, y, width, height };
}
export type ModelObservation = z.infer<typeof ModelObservationSchema>;

export const FrameAssessmentSchema = z.object({
  frameId: z.string(),
  usable: z.boolean(),
  issue: z.string().max(160).nullable(),
  privacyConcern: z.boolean().describe("True if a face, person, document, screen or other personal information is visible"),
});

export const VisionResultSchema = z.object({
  observations: z.array(ModelObservationSchema).max(40),
  frames: z.array(FrameAssessmentSchema),
  overallLimitations: z.array(z.string().max(200)).max(6),
  questionPriority: z
    .array(z.string())
    .max(4)
    .describe("Up to 3 candidate follow-up question IDs whose answers the media cannot show, most useful first"),
});
export type VisionResult = z.infer<typeof VisionResultSchema>;

/** Reference from a report claim to a stored piece of evidence. */
export const EvidenceRefSchema = z.object({
  type: z.enum(EVIDENCE_TYPES),
  /** Database ID of the observation / answer / concern / guidance entry. */
  id: z.string(),
  label: z.string(),
  /** For frame-backed visual evidence: the frame and its source timestamp. */
  frameId: z.string().optional(),
  assetId: z.string().optional(),
  timestampMs: z.number().int().nonnegative().nullable().optional(),
  /** Approximate highlight box within the frame (fractions), when the model localised the feature. */
  region: RegionSchema.nullable().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
