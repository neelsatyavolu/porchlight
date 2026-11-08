import type { Status, TrackEvent, TrackResult } from "../../types.js";

/** Joins the non-empty parts of a place ("Oakland, CA, US"), or null when there are none. */
export function place(...parts: unknown[]): string | null {
  const text = parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join(", ");
  return text || null;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/;

/** The calendar date a carrier value names, or null when it is not a date. */
function datePart(value: string): string | null {
  if (CALENDAR_DATE.test(value)) return value;
  return LOCAL_TIME.exec(value)?.[1] ?? null;
}

/**
 * Splits carrier ETA values into the API's two forms. All instants (with an
 * offset or Z) stay instants. Anything else (a bare date, or a local time with
 * no offset, which names no instant) makes the ETA date-only, and every value
 * keeps just the date the carrier wrote.
 */
function normalizeEta(start: string | null, end: string | null): Pick<TrackResult, "etaStart" | "etaEnd" | "etaDateOnly"> {
  const known = [start, end].filter((v): v is string => v !== null && datePart(v) !== null);
  if (known.length === 0) return { etaStart: null, etaEnd: null, etaDateOnly: false };
  const keep = (v: string | null) => (v !== null && datePart(v) !== null ? v : null);
  if (known.every((v) => INSTANT.test(v))) return { etaStart: keep(start), etaEnd: keep(end), etaDateOnly: false };
  const asDate = (v: string | null) => (v === null ? null : datePart(v));
  return { etaStart: asDate(start), etaEnd: asDate(end), etaDateOnly: true };
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
 * the ETA is either date-only or instants (normalizeEta), a one-sided ETA is
 * a single point (start = end), the ETA is dropped once delivered, and
 * deliveredAt is set only when delivered, falling back to the newest
 * delivered event.
 */
export function finishResult(parts: ResultParts): TrackResult {
  const delivered = parts.status === "delivered";
  const eta = normalizeEta(parts.etaStart, parts.etaEnd);
  const etaStart = delivered ? null : (eta.etaStart ?? eta.etaEnd);
  const etaEnd = delivered ? null : (eta.etaEnd ?? eta.etaStart);
  const deliveredAt = delivered
    ? (parts.deliveredAt ?? parts.events.find((e) => e.status === "delivered")?.occurredAt ?? null)
    : null;
  return {
    status: parts.status,
    statusDetail: parts.statusDetail.trim(),
    etaStart,
    etaEnd,
    etaDateOnly: etaStart !== null && eta.etaDateOnly,
    deliveredAt,
    events: parts.events,
  };
}
