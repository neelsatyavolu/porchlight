/** Longest input we bother normalizing; real tracking numbers are at most 40 chars. */
export const MAX_RAW_LENGTH = 200;

const SEPARATORS = /[\s\-.‐-―−]/g;
// LaserShip 1LS7 (18) ends in a meaningful "-1"; drop it and keep the base number.
const LASERSHIP_SUFFIX = /^(1LS7[12]\d{2}01[1-4]\d{6})-1$/;

export function normalize(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const compact = raw.slice(0, MAX_RAW_LENGTH).toUpperCase().replace(/\s/g, "");
  const base = compact.replace(LASERSHIP_SUFFIX, "$1");
  return base.replace(SEPARATORS, "");
}
