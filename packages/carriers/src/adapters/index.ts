import type { CarrierEnv, CarrierId } from "../types.js";
import { dhlAdapter } from "./dhl.js";
import { fedexAdapter } from "./fedex.js";
import { ship24Adapter } from "./ship24.js";
import type { RegisteredAdapter } from "./shared/types.js";
import { upsAdapter } from "./ups.js";
import { uspsAdapter } from "./usps.js";

export type { RegisteredAdapter } from "./shared/types.js";
export { memoryTokenCache, type TokenCache, type CachedToken } from "./shared/oauth.js";

/** Registered adapters in priority order: direct carrier adapters first, the aggregator last. */
export const ADAPTERS: readonly RegisteredAdapter[] = [uspsAdapter, upsAdapter, fedexAdapter, dhlAdapter, ship24Adapter];

/**
 * Adapters to try for a carrier, in order: the direct adapter when its secrets
 * are set, then the aggregator when its key is set. Empty when none is
 * configured. The poller tries the first and falls back to the next on a
 * non-retryable CarrierError.
 */
export function pickAdapters(carrier: CarrierId, env: CarrierEnv): RegisteredAdapter[] {
  return ADAPTERS.filter((adapter) => adapter.supports(carrier) && adapter.isConfigured(env));
}

/** Same as pickAdapters; kept for callers written against the scaffold. */
export const resolveAdapters = pickAdapters;
