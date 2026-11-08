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
}

export interface TrackContext {
  /** Injected so tests can replay recorded responses. Never call global fetch directly. */
  fetch: typeof fetch;
  env: CarrierEnv;
  now: () => Date;
}

export interface CarrierAdapter {
  /** Stable adapter name, e.g. "usps", "fedex", "aggregator". */
  readonly id: string;
  /** True when this adapter can track numbers of the given carrier. */
  supports(carrier: CarrierId): boolean;
  /** Throws CarrierError on failure. */
  track(number: string, carrier: CarrierId, ctx: TrackContext): Promise<TrackResult>;
}

export type CarrierErrorKind = "rate_limited" | "not_found" | "auth" | "transient";

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
