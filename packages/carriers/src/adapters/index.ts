import type { CarrierEnv, CarrierId } from "../types.js";
import { dhlAdapter } from "./dhl.js";
import { fedexAdapter } from "./fedex.js";
import { ship24Adapter } from "./ship24.js";
import type { RegisteredAdapter } from "./shared/types.js";
import { upsAdapter } from "./ups.js";
import { uspsAdapter } from "./usps.js";
import { amazonWebAdapter } from "./web/amazon.js";
import { dhlEcommerceWebAdapter } from "./web/dhl_ecommerce.js";
import { jitsuWebAdapter } from "./web/jitsu.js";
import { ontracWebAdapter } from "./web/ontrac.js";
import { uniuniWebAdapter } from "./web/uniuni.js";
import { upsWebAdapter } from "./web/ups.js";

export type { RegisteredAdapter } from "./shared/types.js";
export { memoryTokenCache, type TokenCache, type CachedToken } from "./shared/oauth.js";

/**
 * Registered adapters in priority order (types.ts "Registry contract"):
 * direct carrier APIs, then the web adapters, then the aggregator. No web
 * adapter serves usps or fedex (their feed is read on the device), and the
 * aggregator never serves amazon.
 */
export const ADAPTERS: readonly RegisteredAdapter[] = [
  uspsAdapter,
  upsAdapter,
  fedexAdapter,
  dhlAdapter,
  amazonWebAdapter,
  dhlEcommerceWebAdapter,
  ontracWebAdapter,
  uniuniWebAdapter,
  jitsuWebAdapter,
  upsWebAdapter,
  ship24Adapter,
];

const RANK = { api: 0, web: 1, aggregator: 2 } as const;

/**
 * Adapters to try for a carrier, in order: a configured direct API, then the
 * web adapter, then the aggregator when its key is set. The web adapters need
 * no secrets, so they are always configured. The poller tries the first and
 * falls back to the next on a non-retryable CarrierError; it alone decides
 * whether the aggregator's monthly budget allows using it.
 */
export function pickAdapters(carrier: CarrierId, env: CarrierEnv): RegisteredAdapter[] {
  return ADAPTERS.filter((adapter) => adapter.supports(carrier) && adapter.isConfigured(env)).sort(
    (a, b) => RANK[a.source] - RANK[b.source],
  );
}

/** Same as pickAdapters; kept for callers written against the scaffold. */
export const resolveAdapters = pickAdapters;
