// ETA encoding (docs/API.md "Packages", migrations/0002_eta_date_only.sql).
// A date-only ETA is stored as milliseconds at 00:00 UTC of the calendar date
// and sent as "YYYY-MM-DD". A timed ETA is an instant, sent as ISO 8601 UTC.
import { toIso } from "./crypto.js";

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Storage value for an ETA bound, or null when it is missing or not in the form the flag says. */
export function etaToMs(value: string | null | undefined, dateOnly: boolean): number | null {
  if (value == null) return null;
  if (dateOnly) {
    const m = CALENDAR_DATE.exec(value);
    if (!m) return null;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    // Rejects dates like 2026-02-31 that Date.UTC would roll over.
    return new Date(ms).toISOString().startsWith(value) ? ms : null;
  }
  if (CALENDAR_DATE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Wire value for a stored ETA bound. */
export function etaToWire(ms: number | null, dateOnly: boolean): string | null {
  if (ms === null) return null;
  return dateOnly ? new Date(ms).toISOString().slice(0, 10) : toIso(ms);
}
