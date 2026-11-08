import type { Status, TrackEvent, TrackResult } from "../../types.js";

/** Joins the non-empty parts of a place ("Oakland, CA, US"), or null when there are none. */
export function place(...parts: unknown[]): string | null {
  const text = parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join(", ");
  return text || null;
}

export interface ResultParts {
  status: Status;
  statusDetail: string;
  etaStart: string | null;
  etaEnd: string | null;
  deliveredAt: string | null;
  /** Newest first. */
  events: TrackEvent[];
}

/**
 * Applies the rules every adapter shares (docs/research/carrier-apis.md):
 * a one-sided ETA is a single point (start = end), the ETA is dropped once
 * delivered, and deliveredAt is set only when delivered, falling back to the
 * newest delivered event.
 */
export function finishResult(parts: ResultParts): TrackResult {
  const delivered = parts.status === "delivered";
  const etaStart = delivered ? null : (parts.etaStart ?? parts.etaEnd);
  const etaEnd = delivered ? null : (parts.etaEnd ?? parts.etaStart);
  const deliveredAt = delivered
    ? (parts.deliveredAt ?? parts.events.find((e) => e.status === "delivered")?.occurredAt ?? null)
    : null;
  return {
    status: parts.status,
    statusDetail: parts.statusDetail.trim(),
    etaStart,
    etaEnd,
    deliveredAt,
    events: parts.events,
  };
}
