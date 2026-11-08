import type { Candidate, Confidence } from "./types.js";
import { normalize } from "./detect/normalize.js";
import { RULES } from "./detect/rules.js";

/** No real tracking number is longer than this after normalization. */
const MAX_NUMBER_LENGTH = 40;
const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * Canonical form of a pasted tracking number: trims, drops spaces and dashes,
 * uppercases. Detection and storage both use this form.
 */
export function normalizeNumber(raw: string): string {
  return normalize(raw);
}

/**
 * Pure format + checksum detection (SPEC §5, docs/research/number-formats.md).
 * Returns every plausible carrier, highest confidence first; [] when none.
 * Normalizes its input, and never throws.
 */
export function detectCarrier(number: string): Candidate[] {
  const n = normalize(number);
  if (n.length === 0 || n.length > MAX_NUMBER_LENGTH) return [];

  const best = new Map<Candidate["carrier"], Confidence>();
  for (const rule of RULES) {
    const m = rule.pattern.exec(n);
    const conf = m ? rule.grade(m) : null;
    if (conf === null) continue;
    const prev = best.get(rule.carrier);
    if (prev === undefined || RANK[conf] < RANK[prev]) best.set(rule.carrier, conf);
  }
  // Map keeps rule order; the sort is stable, so ties stay in rule order.
  return [...best]
    .map(([carrier, confidence]) => ({ carrier, confidence }))
    .sort((a, b) => RANK[a.confidence] - RANK[b.confidence]);
}
