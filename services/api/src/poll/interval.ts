import { isDhlApiData, type CarrierId, type DataSource, type Status } from "@porchlight/carriers";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Stop polling a package whose last movement is older than this. */
export const GIVE_UP_MS = 30 * DAY;

/** How long to wait when no adapter can track the carrier yet. */
export const NO_ADAPTER_RETRY_MS = DAY;

/**
 * Which polling table applies (docs/research/scraping.md "Polling limits"):
 * - `server`: feeds the Worker reads (web adapters, the aggregator).
 * - `dhl_api`: the free DHL API (250 calls a day).
 * - `device_usps`, `device`: a native app reads the page (UPS and FedEx for `device`).
 */
export type Cadence = "server" | "dhl_api" | "device_usps" | "device";

type Intervals = Readonly<Record<Exclude<Status, "unknown">, number | null>>;

/** Fixed intervals per status (SPEC §5 Polling). null = stop polling. */
const SERVER_MS: Intervals = {
  out_for_delivery: 15 * MIN,
  in_transit: 90 * MIN,
  label_created: 6 * HOUR,
  available_for_pickup: 6 * HOUR,
  exception: 2 * HOUR,
  returned: 12 * HOUR,
  delivered: null,
};

/** USPS on the device and the DHL API: 30 min out for delivery, 2 h in transit. */
const SLOW_MS: Intervals = { ...SERVER_MS, out_for_delivery: 30 * MIN, in_transit: 2 * HOUR };

const INTERVALS: Readonly<Record<Cadence, Intervals>> = {
  server: SERVER_MS,
  dhl_api: SLOW_MS,
  device_usps: SLOW_MS,
  // UPS and FedEx pages: 20 to 30 min out for delivery; the low end.
  device: { ...SLOW_MS, out_for_delivery: 20 * MIN },
};

/** The device table for a carrier whose page the app reads. */
export function deviceCadence(carrier: CarrierId | string): Cadence {
  return carrier === "usps" ? "device_usps" : "device";
}

/** The table for a package whose status came from `source`. */
export function cadenceFor(carrier: CarrierId | string, source: DataSource | null): Cadence {
  if (source === "device") return deviceCadence(carrier);
  if (isDhlApiData(carrier, source)) return "dhl_api";
  return "server";
}

/** Unknown packages back off as they stay quiet: 6 h, then 12 h, then daily. */
function unknownInterval(quietMs: number): number {
  if (quietMs < DAY) return 6 * HOUR;
  if (quietMs < 7 * DAY) return 12 * HOUR;
  return DAY;
}

/**
 * When to check a package next, or null to stop: delivered, or no movement
 * for GIVE_UP_MS. `lastMovementMs` is the newest event or status change.
 */
export function nextCheckAt(status: Status, nowMs: number, lastMovementMs: number, cadence: Cadence = "server"): number | null {
  const quietMs = Math.max(0, nowMs - lastMovementMs);
  if (quietMs > GIVE_UP_MS) return null;
  const interval = status === "unknown" ? unknownInterval(quietMs) : INTERVALS[cadence][status];
  return interval === null ? null : nowMs + interval;
}

/** When to look again after no adapter could answer, or null once quiet past GIVE_UP_MS. */
export function noAdapterRetryAt(nowMs: number, lastMovementMs: number): number | null {
  return nowMs - lastMovementMs > GIVE_UP_MS ? null : nowMs + NO_ADAPTER_RETRY_MS;
}

/** Server feeds after a failed check: 15 min, doubling, at most 2 h. `failures` counts this one. */
export function checkBackoffMs(failures: number): number {
  return Math.min(15 * MIN * 2 ** Math.max(0, failures - 1), 2 * HOUR);
}

/** Device reads after a challenged or failed report: 60 min, doubling, at most 8 h. */
export function deviceBackoffMs(failures: number): number {
  return Math.min(HOUR * 2 ** Math.max(0, failures - 1), 8 * HOUR);
}
