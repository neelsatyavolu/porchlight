// Sign in with Apple: verifies an identity token (RS256 JWT) against Apple's
// JWKS. `fetch` is injectable so tests never call Apple.
import { sha256Hex } from "./auth.js";
import { base64UrlDecode, base64UrlDecodeText } from "./crypto.js";

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SEC = 60;

export interface AppleIdentity {
  sub: string;
  /** Present only when Apple marked it verified. */
  email: string | null;
}

export interface VerifyOptions {
  audiences: readonly string[];
  /** Raw nonce; the token's `nonce` claim must be its SHA-256 hex. */
  nonce: string;
  nowMs: number;
}

/** Thrown for any token that fails verification; routes map it to 401. */
export class AppleTokenError extends Error {
  override readonly name = "AppleTokenError";
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

let fetchImpl: typeof fetch = (input, init) => fetch(input, init);
let jwksCache: { keys: Jwk[]; at: number } | null = null;

/** Test hook: replaces the fetch used for the JWKS and clears the key cache. */
export function setAppleFetch(impl: typeof fetch): void {
  fetchImpl = impl;
  jwksCache = null;
}

async function loadKeys(nowMs: number, force: boolean): Promise<Jwk[]> {
  if (!force && jwksCache && nowMs - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetchImpl(APPLE_JWKS_URL);
  if (!res.ok) throw new Error(`Apple JWKS returned ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache = { keys, at: nowMs };
  return keys;
}

async function findKey(kid: string, nowMs: number): Promise<Jwk> {
  const cached = (await loadKeys(nowMs, false)).find((k) => k.kid === kid);
  if (cached) return cached;
  // Apple rotates keys; refetch once before giving up.
  const fresh = (await loadKeys(nowMs, true)).find((k) => k.kid === kid);
  if (!fresh) throw new AppleTokenError("Unknown signing key");
  return fresh;
}

function parseJson(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(base64UrlDecodeText(segment));
    if (value && typeof value === "object") return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AppleTokenError("Malformed token");
}

async function checkSignature(parts: readonly string[], jwk: Jwk): Promise<void> {
  const [h, p, s] = parts as [string, string, string];
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let sig: Uint8Array;
  try {
    sig = base64UrlDecode(s);
  } catch {
    throw new AppleTokenError("Malformed signature");
  }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new AppleTokenError("Bad signature");
}

async function checkClaims(claims: Record<string, unknown>, opts: VerifyOptions): Promise<AppleIdentity> {
  const nowSec = opts.nowMs / 1000;
  if (claims.iss !== APPLE_ISSUER) throw new AppleTokenError("Wrong issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === "string" && opts.audiences.includes(a))) {
    throw new AppleTokenError("Wrong audience");
  }
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SEC < nowSec) throw new AppleTokenError("Expired");
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SEC > nowSec) throw new AppleTokenError("Issued in the future");
  if (claims.nonce !== (await sha256Hex(opts.nonce))) throw new AppleTokenError("Nonce mismatch");
  if (typeof claims.sub !== "string" || claims.sub.length === 0) throw new AppleTokenError("Missing subject");
  // Apple sends email_verified as a boolean or as the string "true".
  const verified = claims.email_verified === true || claims.email_verified === "true";
  const email = verified && typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  return { sub: claims.sub, email };
}

export async function verifyAppleIdentityToken(token: string, opts: VerifyOptions): Promise<AppleIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AppleTokenError("Malformed token");
  const header = parseJson(parts[0] as string);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AppleTokenError("Unsupported token header");
  const jwk = await findKey(header.kid, opts.nowMs);
  await checkSignature(parts, jwk);
  return checkClaims(parseJson(parts[1] as string), opts);
}
