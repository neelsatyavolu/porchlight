// Small crypto and encoding helpers shared by auth, pairing and sync.

/** Crockford base32 alphabet (no I, L, O, U). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Throws on input that is not base64url. */
export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("not base64url");
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function base64UrlEncodeText(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

export function base64UrlDecodeText(value: string): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(base64UrlDecode(value));
}

/** `length` uniformly random decimal digits, e.g. a 6-digit email code. */
export function randomDigits(length: number): string {
  let out = "";
  while (out.length < length) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    // Reject the top sliver so n % 10 stays uniform.
    if (n !== undefined && n < 4_294_967_290) out += String(n % 10);
  }
  return out;
}

/** `length` uniformly random Crockford base32 characters. */
export function randomCrockford(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => CROCKFORD[b & 31]).join("");
}

/**
 * Canonical form of a typed Crockford code: uppercase, no dashes or spaces,
 * with the look-alikes O→0 and I/L→1. Returns null when anything else remains.
 */
export function normalizeCrockford(raw: string, length: number): string | null {
  const code = raw
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (code.length !== length) return null;
  return [...code].every((c) => CROCKFORD.includes(c)) ? code : null;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function toIso(ms: number): string;
export function toIso(ms: number | null): string | null;
export function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
