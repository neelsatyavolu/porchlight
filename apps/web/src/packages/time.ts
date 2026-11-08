// Calendar-day math in an explicit IANA time zone. Every function takes the
// zone as an argument so tests can pin it; the app passes the browser's zone.
//
// A "day number" is whole days since 1970-01-01 for a calendar date, with no
// time zone attached. Subtracting two of them gives a calendar-day difference
// that DST can't skew.

const MS_PER_DAY = 86_400_000;
const LOCALE = "en-US";

/** Carriers' date-only ETAs reach us as midnight UTC (DESIGN.md §6). */
const DATE_ONLY = /T00:00:00(?:\.000)?Z$/;

const partsCache = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, { timeZone, year: "numeric", month: "numeric", day: "numeric" });
    partsCache.set(timeZone, f);
  }
  return f;
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** True for an ISO timestamp that is really a date with no time (midnight UTC). */
export function isDateOnly(iso: string): boolean {
  return DATE_ONLY.test(iso);
}

/** The calendar day of an instant as seen in `timeZone`. */
export function dayNumberOf(date: Date, timeZone: string): number {
  let y = 0;
  let m = 0;
  let d = 0;
  for (const p of dayFormatter(timeZone).formatToParts(date)) {
    if (p.type === "year") y = Number(p.value);
    else if (p.type === "month") m = Number(p.value);
    else if (p.type === "day") d = Number(p.value);
  }
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

/**
 * The calendar day an ETA names. Date-only values are read by their UTC date,
 * so "Nov 10" stays Nov 10 west of Greenwich; anything with a time is local.
 */
export function etaDayNumber(iso: string, timeZone: string): number {
  if (isDateOnly(iso)) return Math.floor(Date.parse(iso) / MS_PER_DAY);
  return dayNumberOf(new Date(iso), timeZone);
}

/** Calendar days from today to the given day (0 today, 1 tomorrow, -1 yesterday). */
export function daysFromToday(dayNumber: number, now: Date, timeZone: string): number {
  return dayNumber - dayNumberOf(now, timeZone);
}

function formatDay(dayNumber: number, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: "UTC" }).format(new Date(dayNumber * MS_PER_DAY));
}

/** "Thursday" */
export function weekdayName(dayNumber: number): string {
  return formatDay(dayNumber, { weekday: "long" });
}

/** "Tue" */
export function weekdayShort(dayNumber: number): string {
  return formatDay(dayNumber, { weekday: "short" });
}

/** "Nov 21", or "Jan 3, 2027" when the year differs from `today`'s. */
export function monthDay(dayNumber: number, todayDayNumber: number): string {
  const sameYear = formatDay(dayNumber, { year: "numeric" }) === formatDay(todayDayNumber, { year: "numeric" });
  return formatDay(dayNumber, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "Thursday, Nov 12" */
export function weekdayMonthDay(dayNumber: number, todayDayNumber: number): string {
  return `${weekdayName(dayNumber)}, ${monthDay(dayNumber, todayDayNumber)}`;
}

/** "Sun, Nov 8" (timeline day headers). */
export function shortDayHeader(dayNumber: number, todayDayNumber: number): string {
  return `${weekdayShort(dayNumber)}, ${monthDay(dayNumber, todayDayNumber)}`;
}

/** "2:14 PM" in `timeZone`. */
export function clockTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** "Nov 8, 2026, 9:41 AM" for tooltips. */
export function fullDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

/**
 * "just now", "14 min ago", "3 h ago", "2 days ago". Never rounds into a vaguer
 * word (DESIGN.md §1, honest status). A time slightly in the future (clock
 * skew) reads as "just now".
 */
export function ago(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
