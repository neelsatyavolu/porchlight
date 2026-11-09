// Ship24 monthly budget (docs/API.md "Aggregator budget"). The free plan
// covers AGGREGATOR_MONTHLY_LIMIT new trackers per calendar month (UTC). A KV
// counter under `aggregator:<YYYY-MM>` holds how many were registered. KV is
// eventually consistent, so two Workers racing can overspend by one; Ship24
// then answers with a quota error, which the adapter reports as rate_limited.
import type { Env } from "../env.js";

export const DEFAULT_AGGREGATOR_MONTHLY_LIMIT = 10;
/** The counter outlives its month by a few days, then KV drops it. */
const COUNTER_TTL_SEC = 35 * 24 * 60 * 60;

export function budgetKey(nowMs: number): string {
  return `aggregator:${new Date(nowMs).toISOString().slice(0, 7)}`;
}

/** AGGREGATOR_MONTHLY_LIMIT as a whole number >= 0; the default when unset or malformed. */
export function monthlyLimit(env: Pick<Env, "AGGREGATOR_MONTHLY_LIMIT">): number {
  const raw = env.AGGREGATOR_MONTHLY_LIMIT?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_AGGREGATOR_MONTHLY_LIMIT;
  return Number(raw);
}

/** Trackers registered this month. */
export async function aggregatorUsed(env: Env, nowMs: number): Promise<number> {
  const n = Number(await env.RATE.get(budgetKey(nowMs)));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Spends one registration if the month has room. Returns false when the
 * budget is spent, or when KV fails: an unknown count must not spend more.
 */
export async function reserveAggregator(env: Env, nowMs: number): Promise<boolean> {
  try {
    const used = await aggregatorUsed(env, nowMs);
    if (used >= monthlyLimit(env)) return false;
    await env.RATE.put(budgetKey(nowMs), String(used + 1), { expirationTtl: COUNTER_TTL_SEC });
    return true;
  } catch (err) {
    console.warn("budget: KV unavailable, not using the aggregator", err);
    return false;
  }
}
