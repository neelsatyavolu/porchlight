// CONTRACT: shared carrier types used by services/api, apps/web and mirrored in
// Swift (PorchKit). Changing anything here is a cross-team change: update
// docs/API.md and the Swift models in the same change.

/** Every carrier Porchlight knows by name. Anything else is `other`. */
export const CARRIER_IDS = [
  "usps",
  "ups",
  "fedex",
  "dhl",
  "dhl_ecommerce",
  "amazon",
  "ontrac",
  "lasership",
  "uniuni",
  "jitsu",
  "other",
] as const;
export type CarrierId = (typeof CARRIER_IDS)[number];

/** Normalized package status (SPEC §4). */
export const STATUSES = [
  "label_created",
  "in_transit",
  "out_for_delivery",
  "available_for_pickup",
  "delivered",
  "exception",
  "returned",
  "unknown",
] as const;
export type Status = (typeof STATUSES)[number];

export type Confidence = "high" | "medium" | "low";

/** One possible carrier for a tracking number. detectCarrier sorts high first. */
export interface Candidate {
  carrier: CarrierId;
  confidence: Confidence;
}

export interface TrackEvent {
  /** ISO 8601 timestamp with offset, as reported by the carrier. */
  occurredAt: string;
  status: Status;
  description: string;
  /** Human-readable place ("Oakland, CA, US"), or null when the carrier gives none. */
  location: string | null;
}

export interface TrackResult {
  status: Status;
  /** The carrier's own wording for the latest status. */
  statusDetail: string;
  /**
   * ETA window. Only what the carrier said; never computed. When
   * `etaDateOnly` is true both are calendar dates ("2026-11-10", the
   * carrier's local delivery date). When false they are ISO 8601 instants
   * with a UTC offset or Z.
   */
  etaStart: string | null;
  etaEnd: string | null;
  /** True when the ETA is a date with no time. False when there is no ETA. */
  etaDateOnly: boolean;
  /** ISO 8601, set only when status is `delivered`. */
  deliveredAt: string | null;
  /** Newest first. */
  events: TrackEvent[];
}

/**
 * Secrets an adapter may read. services/api's Env is a superset of this.
 * All optional: a missing key means that adapter is not configured and the
 * registry falls back to the aggregator.
 */
export interface CarrierEnv {
  AGGREGATOR_API_KEY?: string;
  USPS_CLIENT_ID?: string;
  USPS_CLIENT_SECRET?: string;
  UPS_CLIENT_ID?: string;
  UPS_CLIENT_SECRET?: string;
  FEDEX_CLIENT_ID?: string;
  FEDEX_CLIENT_SECRET?: string;
  DHL_API_KEY?: string;
  /**
   * Public site key from UniUni's tracking page JS (docs/research/scraping.md
   * "UniUni"). Not a secret; web:uniuni falls back to its built-in default.
   */
  UNIUNI_SITE_KEY?: string;
}

export interface TrackContext {
  /** Injected so tests can replay recorded responses. Never call global fetch directly. */
  fetch: typeof fetch;
  env: CarrierEnv;
  now: () => Date;
}

/**
 * How an adapter reads its data:
 * - `api`: a carrier's official API with our key (dhl, and usps/ups/fedex when keys exist).
 * - `web`: the carrier's public tracking feed, read by the Worker (adapters/web/).
 * - `aggregator`: Ship24, which spends the monthly budget (AGGREGATOR_MONTHLY_LIMIT).
 */
export type AdapterSource = "api" | "web" | "aggregator";

/**
 * Where a package's current status came from (`packages.last_source`,
 * `dataSource` in the package JSON). `device` is a native app reading the
 * carrier page in a hidden web view; `amazon` is the Amazon import's
 * `observed` block. null in the API means nothing has been read yet.
 */
export type DataSource = AdapterSource | "device" | "amazon";
export const DATA_SOURCES = ["api", "web", "aggregator", "device", "amazon"] as const satisfies readonly DataSource[];

/*
 * Registry contract (adapters/index.ts). `pickAdapters(carrier, env)` keeps
 * its signature and returns the server adapters to try, in order:
 *   configured direct API (source "api") → web adapter ("web") → aggregator.
 * - amazon: never includes the aggregator.
 * - usps, fedex: no server web adapter; the device is the primary path, so
 *   the list holds only a configured API (none today) and the aggregator.
 * - ups: web:ups first (it throws device_required when blocked), then the aggregator.
 * The poller (services/api) decides whether the aggregator may be used
 * (monthly budget, web_misses >= 2, no device path); pickAdapters only lists it.
 */

/** Ids of the server web adapters (packages/carriers/src/adapters/web/<carrier>.ts). */
export const WEB_ADAPTER_IDS = [
  "web:amazon",
  "web:dhl_ecommerce",
  /** Also serves lasership (1LS… numbers use the OnTrac endpoint). */
  "web:ontrac",
  "web:uniuni",
  "web:jitsu",
  /** Server attempt only; throws device_required when blocked. */
  "web:ups",
] as const;
export type WebAdapterId = (typeof WEB_ADAPTER_IDS)[number];

/**
 * Carriers whose primary feed is read on the user's device (hidden web view)
 * and posted to POST /v1/packages/:id/observed. For ups the server tries
 * web:ups first and hands over to the device when it throws device_required.
 */
export const DEVICE_CARRIERS = ["usps", "ups", "fedex"] as const satisfies readonly CarrierId[];
export type DeviceCarrier = (typeof DEVICE_CARRIERS)[number];

export function isDeviceCarrier(carrier: CarrierId): carrier is DeviceCarrier {
  return (DEVICE_CARRIERS as readonly CarrierId[]).includes(carrier);
}

/**
 * DHL API terms: shown in the detail view of a package whose data came from
 * the DHL API (isDhlApiData: dataSource "api", carrier dhl or dhl_ecommerce). The server sends it as the
 * package's `attribution`; clients show the string as given.
 */
export const DHL_ATTRIBUTION = "Delivered by Deutsche Post DHL Group";

/** DHL API terms: events of DHL-API packages are deleted this long after delivery. */
export const DHL_RETENTION_DAYS = 30;

/** Carriers the DHL API adapter (adapters/dhl.ts) reads; it serves DHL eCommerce too. */
export const DHL_API_CARRIERS = ["dhl", "dhl_ecommerce"] as const satisfies readonly CarrierId[];

/**
 * True when a package's data came from the DHL API, so the DHL terms apply
 * (attribution, 30-day purge, the 250-a-day cadence). The DHL adapter is the
 * only `api` source for these carriers.
 */
export function isDhlApiData(carrier: CarrierId | string, source: DataSource | null): boolean {
  return source === "api" && (DHL_API_CARRIERS as readonly string[]).includes(carrier);
}

export interface CarrierAdapter {
  /** Stable adapter name, e.g. "usps", "fedex", "aggregator", "web:ontrac". */
  readonly id: string;
  /** How this adapter reads data; the poller stores it as packages.last_source. */
  readonly source: AdapterSource;
  /** True when this adapter can track numbers of the given carrier. */
  supports(carrier: CarrierId): boolean;
  /** Throws CarrierError on failure. */
  track(number: string, carrier: CarrierId, ctx: TrackContext): Promise<TrackResult>;
}

/**
 * - `rate_limited`, `transient`: retry later (see `retryable`).
 * - `not_found`: the carrier doesn't know the number (yet).
 * - `auth`: our key or token was refused.
 * - `device_required`: the feed can only be read from a real browser on the
 *   user's device (401/403/428, a bot challenge, or a timeout). The poller
 *   sets packages.device_needed_at instead of retrying on the server.
 */
export type CarrierErrorKind = "rate_limited" | "not_found" | "auth" | "transient" | "device_required";

export class CarrierError extends Error {
  readonly kind: CarrierErrorKind;
  readonly adapter: string;
  /** Seconds to wait before retrying, when the carrier said so. */
  readonly retryAfterSec: number | null;

  constructor(
    kind: CarrierErrorKind,
    adapter: string,
    message: string,
    options: { retryAfterSec?: number | null; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CarrierError";
    this.kind = kind;
    this.adapter = adapter;
    this.retryAfterSec = options.retryAfterSec ?? null;
  }

  /** Whether the poller should retry later (rate_limited, transient). */
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "transient";
  }
}

/** One row of fixtures/numbers.json (schema: fixtures/numbers.schema.json). */
export interface NumberFixture {
  number: string;
  carrier: CarrierId;
  /** false = must NOT be detected as `carrier` (negative case). */
  valid: boolean;
  note: string;
}
