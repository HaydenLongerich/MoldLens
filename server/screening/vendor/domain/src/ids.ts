import { randomBytes, randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

// Human-friendly case reference, no ambiguous characters. Not a secret.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newCaseReference(prefix = "ML"): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `${prefix}-${out.slice(0, 4)}-${out.slice(4)}`;
}
