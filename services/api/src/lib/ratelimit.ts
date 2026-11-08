// Request rate limits for auth, pairing and refresh (docs/API.md §Rate limits).
// A token bucket per key, stored in KV (RATE). KV is eventually consistent,
// so limits are approximate, which the contract allows.
import type { Env } from "../env.js";
import { HttpError } from "./http.js";

export interface Limit {
  /** Requests allowed per window (also the burst size). */
  max: number;
  windowSec: number;
}

export const LIMITS = {
  authPerIp: { max: 10, windowSec: 60 },
  emailStartPerEmail: { max: 3, windowSec: 15 * 60 },
  emailVerifyPerEmail: { max: 5, windowSec: 15 * 60 },
  pairingClaimPerIp: { max: 5, windowSec: 10 * 60 },
} as const satisfies Record<string, Limit>;

interface Bucket {
  tokens: number;
  at: number;
}

/** KV refuses expirationTtl below 60 seconds. */
const MIN_KV_TTL_SEC = 60;

function readBucket(raw: string | null, limit: Limit, nowMs: number): number {
  if (!raw) return limit.max;
  try {
    const b = JSON.parse(raw) as Bucket;
    const refill = ((nowMs - b.at) / 1000) * (limit.max / limit.windowSec);
    return Math.min(limit.max, b.tokens + Math.max(0, refill));
  } catch {
    return limit.max;
  }
}

/** Takes one token from bucket `key`. Returns 0 when allowed, else seconds to wait. */
export async function take(env: Env, key: string, limit: Limit, nowMs: number): Promise<number> {
  const kvKey = `rl:${key}`;
  const tokens = readBucket(await env.RATE.get(kvKey), limit, nowMs);
  if (tokens < 1) {
    const perSec = limit.max / limit.windowSec;
    return Math.max(1, Math.ceil((1 - tokens) / perSec));
  }
  const next: Bucket = { tokens: tokens - 1, at: nowMs };
  await env.RATE.put(kvKey, JSON.stringify(next), { expirationTtl: Math.max(MIN_KV_TTL_SEC, limit.windowSec) });
  return 0;
}

/** Like `take`, but throws a 429 HttpError with Retry-After when over the limit. */
export async function enforce(env: Env, key: string, limit: Limit, nowMs: number): Promise<void> {
  const wait = await take(env, key, limit, nowMs);
  if (wait > 0) throw rateLimited(wait);
}

export function rateLimited(retryAfterSec: number): HttpError {
  return new HttpError(429, "rate_limited", "Too many requests, try again later", {
    "retry-after": String(retryAfterSec),
  });
}

/** The caller's IP as Cloudflare reports it; "unknown" in local tests. */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}
