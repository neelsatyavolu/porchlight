import type { Status } from "@porchlight/carriers";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Stop polling a package whose last movement is older than this. */
export const GIVE_UP_MS = 30 * DAY;

/** How long to wait when no adapter can track the carrier yet. */
export const NO_ADAPTER_RETRY_MS = DAY;

/** Fixed intervals per status (SPEC §5 Polling). null = stop polling. */
const INTERVAL_MS: Readonly<Record<Exclude<Status, "unknown">, number | null>> = {
  out_for_delivery: 15 * MIN,
  in_transit: 90 * MIN,
  label_created: 6 * HOUR,
  available_for_pickup: 6 * HOUR,
  exception: 2 * HOUR,
  returned: 12 * HOUR,
  delivered: null,
};

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
export function nextCheckAt(status: Status, nowMs: number, lastMovementMs: number): number | null {
  const quietMs = Math.max(0, nowMs - lastMovementMs);
  if (quietMs > GIVE_UP_MS) return null;
  const interval = status === "unknown" ? unknownInterval(quietMs) : INTERVAL_MS[status];
  return interval === null ? null : nowMs + interval;
}

/** When to look again after no adapter could answer, or null once quiet past GIVE_UP_MS. */
export function noAdapterRetryAt(nowMs: number, lastMovementMs: number): number | null {
  return nowMs - lastMovementMs > GIVE_UP_MS ? null : nowMs + NO_ADAPTER_RETRY_MS;
}
