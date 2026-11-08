// Turns pasted text into tracking numbers with carrier candidates (DESIGN.md §7 "Add").
import { detectCarrier, normalizeNumber, type Candidate, type CarrierId } from "@porchlight/carriers";

/** Matches the server's limit in detectCarrier; longer strings are not tracking numbers. */
export const MAX_NUMBER_LENGTH = 40;

export interface ParsedNumber {
  /** Normalized: no spaces or dashes, uppercase. */
  number: string;
  candidates: Candidate[];
  /** Picked without asking: a single high-confidence match. */
  preselected: CarrierId | null;
  /** True when the user has to choose between carriers. */
  ambiguous: boolean;
  tooLong: boolean;
}

/** One number per line; blank lines and repeats are dropped. */
export function parseNumbers(text: string): ParsedNumber[] {
  const seen = new Set<string>();
  const out: ParsedNumber[] = [];
  for (const line of text.split(/\r?\n/)) {
    const number = normalizeNumber(line);
    if (number === "" || seen.has(number)) continue;
    seen.add(number);
    const candidates = detectCarrier(number);
    const only = candidates.length === 1 ? candidates[0] : undefined;
    out.push({
      number,
      candidates,
      preselected: only && only.confidence === "high" ? only.carrier : null,
      ambiguous: candidates.length > 1,
      tooLong: number.length > MAX_NUMBER_LENGTH,
    });
  }
  return out;
}
