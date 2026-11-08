// Arrival-day grouping and ETA wording (DESIGN.md §6). Pure: every function
// takes `now` and the time zone, so tests pin both.
import type { Package } from "../api/types";
import {
  clockTime,
  dayNumberOf,
  daysFromToday,
  etaDayNumber,
  isDateOnly,
  monthDay,
  weekdayMonthDay,
  weekdayName,
  weekdayShort,
} from "./time";

export type GroupId = "today" | "tomorrow" | "week" | "later" | "delivered";

export const GROUP_ORDER: readonly GroupId[] = ["today", "tomorrow", "week", "later", "delivered"];

export const GROUP_LABELS: Record<GroupId, string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  week: "This week",
  later: "Later",
  delivered: "Delivered",
};

export interface ArrivalGroup {
  id: GroupId;
  label: string;
  packages: Package[];
}

/** The ISO value that decides a package's day: the end of the window, else its start. */
export function etaOf(pkg: Package): string | null {
  return pkg.etaEnd ?? pkg.etaStart;
}

function isOut(pkg: Package): boolean {
  return pkg.status === "out_for_delivery" || pkg.status === "available_for_pickup";
}

/** Days from today to the package's ETA day, or null with no ETA. */
function etaOffset(pkg: Package, now: Date, timeZone: string): number | null {
  const eta = etaOf(pkg);
  return eta === null ? null : daysFromToday(etaDayNumber(eta, timeZone), now, timeZone);
}

export function groupOf(pkg: Package, now: Date, timeZone: string): GroupId {
  if (pkg.status === "delivered") return "delivered";
  if (isOut(pkg)) return "today";
  const offset = etaOffset(pkg, now, timeZone);
  if (offset === null) return "later";
  if (offset <= 0) return "today"; // due today, or late and not delivered
  if (offset === 1) return "tomorrow";
  if (offset <= 6) return "week";
  return "later";
}

function time(iso: string | null): number {
  return iso === null ? Number.NaN : Date.parse(iso);
}

/**
 * Order inside an open group: problems pinned first, then out for delivery,
 * then soonest ETA (no ETA last), then most recently updated.
 */
function compareOpen(a: Package, b: Package): number {
  const problem = Number(b.status === "exception") - Number(a.status === "exception");
  if (problem !== 0) return problem;
  const out = Number(isOut(b)) - Number(isOut(a));
  if (out !== 0) return out;
  const ea = time(etaOf(a));
  const eb = time(etaOf(b));
  if (Number.isNaN(ea) !== Number.isNaN(eb)) return Number.isNaN(ea) ? 1 : -1;
  if (!Number.isNaN(ea) && ea !== eb) return ea - eb;
  return time(b.updatedAt) - time(a.updatedAt);
}

function compareDelivered(a: Package, b: Package): number {
  const da = time(a.deliveredAt ?? a.updatedAt);
  const db = time(b.deliveredAt ?? b.updatedAt);
  return db - da;
}

/** Groups in display order; empty groups are left out. */
export function groupPackages(packages: readonly Package[], now: Date, timeZone: string): ArrivalGroup[] {
  const buckets = new Map<GroupId, Package[]>(GROUP_ORDER.map((id) => [id, []]));
  for (const pkg of packages) buckets.get(groupOf(pkg, now, timeZone))?.push(pkg);
  return GROUP_ORDER.flatMap((id) => {
    const list = buckets.get(id) ?? [];
    if (list.length === 0) return [];
    const sorted = [...list].sort(id === "delivered" ? compareDelivered : compareOpen);
    return [{ id, label: GROUP_LABELS[id], packages: sorted }];
  });
}

export interface EtaPhrase {
  text: string;
  /** Shown in --mute: no date, or overdue. */
  muted: boolean;
}

/** "Delivered 2:14 PM" today, "Delivered Tue" this week, else "Delivered Nov 3". */
function deliveredPhrase(pkg: Package, now: Date, timeZone: string): string {
  if (pkg.deliveredAt === null) return "Delivered";
  const day = dayNumberOf(new Date(pkg.deliveredAt), timeZone);
  const offset = daysFromToday(day, now, timeZone);
  if (offset === 0) return `Delivered ${clockTime(pkg.deliveredAt, timeZone)}`;
  if (offset < 0 && offset >= -6) return `Delivered ${weekdayShort(day)}`;
  return `Delivered ${monthDay(day, dayNumberOf(now, timeZone))}`;
}

/** The end of a same-day window with a real time, e.g. for "By 8:00 PM". */
function todayDeadline(pkg: Package, now: Date, timeZone: string): string | null {
  const end = pkg.etaEnd;
  if (end === null || isDateOnly(end)) return null;
  return daysFromToday(etaDayNumber(end, timeZone), now, timeZone) === 0 ? clockTime(end, timeZone) : null;
}

/** The row's trailing ETA phrase (DESIGN.md §6 "Package row"). */
export function etaPhrase(pkg: Package, now: Date, timeZone: string): EtaPhrase {
  if (pkg.status === "delivered") return { text: deliveredPhrase(pkg, now, timeZone), muted: false };
  if (isOut(pkg)) {
    const by = todayDeadline(pkg, now, timeZone);
    return { text: by ? `By ${by}` : "Today", muted: false };
  }
  const eta = etaOf(pkg);
  if (eta === null) return { text: "No date yet", muted: true };
  const day = etaDayNumber(eta, timeZone);
  const today = dayNumberOf(now, timeZone);
  const offset = day - today;
  if (offset < 0) return { text: `Was due ${monthDay(day, today)}`, muted: true };
  if (offset === 0) return { text: "Today", muted: false };
  if (offset === 1) return { text: "Tomorrow", muted: false };
  if (offset <= 6) return { text: weekdayName(day), muted: false };
  return { text: monthDay(day, today), muted: false };
}

/** "today", "tomorrow", "Thursday, Nov 12". */
function dayWords(day: number, today: number): string {
  const offset = day - today;
  if (offset === 0) return "today";
  if (offset === 1) return "tomorrow";
  return weekdayMonthDay(day, today);
}

/** A time-of-day for an ETA bound, or null for date-only values. */
function boundTime(iso: string, timeZone: string): string | null {
  return isDateOnly(iso) ? null : clockTime(iso, timeZone);
}

/**
 * The detail page's ETA sentence (DESIGN.md §6 "Detail"), including the window:
 * "Arriving Thursday, Nov 12", "Arriving between Thursday, Nov 12 and Saturday, Nov 14",
 * "Arriving today, 2:00 PM to 6:00 PM", "Delivered Tuesday at 2:14 PM",
 * "No delivery date from UPS yet".
 */
export function etaSentence(pkg: Package, carrierLabel: string, now: Date, timeZone: string): string {
  const today = dayNumberOf(now, timeZone);

  if (pkg.status === "delivered") {
    if (pkg.deliveredAt === null) return "Delivered";
    const day = dayNumberOf(new Date(pkg.deliveredAt), timeZone);
    const offset = day - today;
    const at = clockTime(pkg.deliveredAt, timeZone);
    if (offset === 0) return `Delivered today at ${at}`;
    if (offset === -1) return `Delivered yesterday at ${at}`;
    if (offset < 0 && offset >= -6) return `Delivered ${weekdayName(day)} at ${at}`;
    return `Delivered ${monthDay(day, today)} at ${at}`;
  }

  if (pkg.status === "available_for_pickup") return "Ready for pickup";

  if (pkg.status === "out_for_delivery") {
    const by = todayDeadline(pkg, now, timeZone);
    return by ? `Arriving today by ${by}` : "Arriving today";
  }

  const start = pkg.etaStart;
  const end = pkg.etaEnd;
  const eta = end ?? start;
  if (eta === null) return `No delivery date from ${carrierLabel} yet`;

  const endDay = etaDayNumber(eta, timeZone);
  if (endDay < today) return `Was due ${weekdayMonthDay(endDay, today)}`;

  if (start !== null && end !== null) {
    const startDay = etaDayNumber(start, timeZone);
    if (startDay !== endDay) {
      return `Arriving between ${dayWords(Math.max(startDay, today), today)} and ${dayWords(endDay, today)}`;
    }
    const from = boundTime(start, timeZone);
    const to = boundTime(end, timeZone);
    if (from && to && from !== to) return `Arriving ${dayWords(endDay, today)}, ${from} to ${to}`;
  }
  return `Arriving ${dayWords(endDay, today)}`;
}
