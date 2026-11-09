// Time helpers for feeds that give wall clocks plus a zone, or epoch values.
// Uses Intl only, so it runs the same in Workers and Node.

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");

/** "+02:00" style offset for a number of minutes east of UTC. */
export function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  return `${sign}${pad(Math.trunc(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/** The instant written as local time at a fixed offset: "2026-11-08T09:12:04-08:00". */
export function formatAtOffset(epochMs: number, offsetMinutes: number): string {
  const d = new Date(epochMs + offsetMinutes * 60_000);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${date}T${time}${offsetText(offsetMinutes)}`;
}

/** Parses "+02:00", "-0500" or "Z"; null when malformed. */
export function parseOffset(value: string): number | null {
  if (value === "Z" || value === "z") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return minutes > 14 * 60 ? null : (m[1] === "-" ? -minutes : minutes);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's UTC offset in minutes at an instant, or null for an unknown zone. */
export function zoneOffsetMinutes(epochMs: number, zone: string): number | null {
  let fmt = formatters.get(zone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
    } catch {
      return null;
    }
    formatters.set(zone, fmt);
  }
  const name = fmt.formatToParts(new Date(epochMs)).find((p) => p.type === "timeZoneName")?.value ?? "";
  if (name === "GMT") return 0;
  return parseOffset(name.replace(/^GMT/, ""));
}

/** True when the zone is a valid IANA name. */
export function isZone(zone: string): boolean {
  return zoneOffsetMinutes(0, zone) !== null;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/**
 * A wall clock ("2026-11-08T09:12:04") read in an IANA zone, as an ISO string
 * with that zone's offset. Null when the clock or zone is invalid.
 */
export function wallClockInZone(wall: string, zone: string): string | null {
  const m = WALL.exec(wall.trim());
  if (!m) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  if (Number.isNaN(asUtc)) return null;
  const first = zoneOffsetMinutes(asUtc, zone);
  if (first === null) return null;
  // Two passes settle the offset across a DST change.
  const second = zoneOffsetMinutes(asUtc - first * 60_000, zone) ?? first;
  return formatAtOffset(asUtc - second * 60_000, second);
}

/** An instant shown in an IANA zone's local time with its offset; UTC ("Z" offset) when the zone is unknown. */
export function instantInZone(epochMs: number, zone: string | null): string {
  const offset = zone ? zoneOffsetMinutes(epochMs, zone) : null;
  return formatAtOffset(epochMs, offset ?? 0);
}

/** True for an ISO 8601 date-time that names an instant (has an offset or Z). */
export function hasOffset(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
}
