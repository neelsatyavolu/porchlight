// CONTRACT: token-bucket rate limiting in KV (RATE binding).
import type { Env } from "../env.js";
import { take } from "./ratelimit.js";

export interface BucketSpec {
  /** Max tokens in the bucket. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export interface RateDecision {
  allowed: boolean;
  /** Seconds until one token is available; 0 when allowed. */
  retryAfterSec: number;
}

/**
 * Takes one token from bucket `key` (e.g. "carrier:ups", "imports:<userId>").
 * KV is eventually consistent, so limits are approximate. A KV failure (for
 * example its one-write-per-second-per-key limit) fails open: these buckets
 * protect carriers and imports, and a lost token is cheaper than a dropped job.
 */
export async function takeToken(env: Env, key: string, spec: BucketSpec, nowMs: number): Promise<RateDecision> {
  try {
    const wait = await take(env, key, { max: spec.capacity, windowSec: spec.capacity / spec.refillPerSec }, nowMs);
    return { allowed: wait === 0, retryAfterSec: wait };
  } catch (err) {
    console.warn("rate: KV bucket unavailable, allowing", key, err);
    return { allowed: true, retryAfterSec: 0 };
  }
}
