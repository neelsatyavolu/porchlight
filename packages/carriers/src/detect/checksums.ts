// Check-digit algorithms used by the detection rules. Ported from the
// checksum definitions in jkeen/tracking_number_data (MIT, (c) 2017 Jeff Keen),
// pinned at commit 03af203 (v2.0.0). See docs/research/number-formats.md.

/** Digit value; letters use the UPS map (A=2 ... H=9, I=0 ...). */
function charValue(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  return (code - 3) % 10;
}

/**
 * jkeen "mod10": positions counted from 0, even positions times evenMul and odd
 * positions times oddMul, optionally over the reversed sequence.
 */
export function mod10(seq: string, evenMul: number, oddMul: number, reverse = false): number {
  const chars = reverse ? [...seq].reverse() : [...seq];
  let total = 0;
  chars.forEach((c, i) => {
    total += charValue(c) * (i % 2 === 0 ? evenMul : oddMul);
  });
  return (10 - (total % 10)) % 10;
}

/** jkeen "sum_product_with_weightings_and_modulo" with modulo1 11, modulo2 10. */
export function weighted11(seq: string, weights: readonly number[]): number {
  return (weighted(seq, weights) % 11) % 10;
}

const S10_WEIGHTS = [8, 6, 4, 2, 3, 5, 9, 7] as const;

/** UPU S10 check digit over the 8-digit serial. */
export function s10(serial8: string): number {
  const r = weighted(serial8, S10_WEIGHTS) % 11;
  const c = 11 - r;
  if (c === 10) return 0;
  if (c === 11) return 5;
  return c;
}

/** DHL Express: the number before the check digit, mod 7. */
export function mod7(seq: string): number {
  let r = 0;
  for (const c of seq) r = (r * 10 + charValue(c)) % 7;
  return r;
}

function weighted(seq: string, weights: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < seq.length; i++) total += charValue(seq[i]!) * (weights[i] ?? 0);
  return total;
}
