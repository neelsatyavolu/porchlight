// Display text for packages (DESIGN.md §3, §6). Pure functions.
import type { CarrierId } from "@porchlight/carriers";
import type { Package, PackageEvent, PackageSource } from "../api/types";
import { carrierName } from "../lib/carriers";
import { statusLabel } from "../lib/status";
import { clockTime, dayNumberOf, shortDayHeader } from "./time";

/** `title`, else `merchant`, else "UPS ···4784". */
export function rowTitle(pkg: Pick<Package, "title" | "merchant" | "carrier" | "trackingNumber">): string {
  const title = pkg.title?.trim();
  if (title) return title;
  const merchant = pkg.merchant?.trim();
  if (merchant) return merchant;
  return `${carrierName(pkg.carrier)} ···${pkg.trackingNumber.slice(-4)}`;
}

/** Our status label, then the carrier's own words when present. */
export function statusLine(pkg: Pick<Package, "status" | "statusDetail">): string {
  const label = statusLabel(pkg.status);
  const detail = pkg.statusDetail?.trim();
  return detail && detail.toLowerCase() !== label.toLowerCase() ? `${label} · ${detail}` : label;
}

const SOURCE_LABELS: Record<PackageSource, string> = {
  manual: "Added by hand",
  amazon: "From Amazon",
  flint: "From Flint",
  share: "Shared",
};

export function sourceLabel(source: PackageSource): string {
  return SOURCE_LABELS[source];
}

/**
 * Public tracking pages, for the "Track on …" link. Carriers missing here
 * have no stable public URL we know of; the link is then left out.
 */
const TRACKING_URLS: Partial<Record<CarrierId, (n: string) => string>> = {
  usps: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  ups: (n) => `https://www.ups.com/track?tracknum=${n}`,
  fedex: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  dhl: (n) => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}&submit=1`,
  amazon: (n) => `https://track.amazon.com/tracking/${n}`,
  ontrac: (n) => `https://www.ontrac.com/tracking/?number=${n}`,
  lasership: (n) => `https://www.ontrac.com/tracking/?number=${n}`,
};

export function carrierTrackingUrl(carrier: CarrierId, trackingNumber: string): string | null {
  const build = TRACKING_URLS[carrier];
  return build ? build(encodeURIComponent(trackingNumber)) : null;
}

/** Case-insensitive match on the fields a person would type to find a package. */
export function matchesQuery(pkg: Package, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const compactQ = q.replace(/[\s-]/g, "");
  const fields = [pkg.title, pkg.merchant, pkg.statusDetail, carrierName(pkg.carrier), statusLabel(pkg.status), pkg.orderId];
  if (fields.some((f) => f?.toLowerCase().includes(q))) return true;
  if (pkg.items.some((item) => item.name.toLowerCase().includes(q))) return true;
  return compactQ !== "" && pkg.trackingNumber.toLowerCase().includes(compactQ);
}

export interface TimelineDay {
  /** Day number in the viewer's zone, used as a React key. */
  day: number;
  label: string;
  events: Array<PackageEvent & { time: string }>;
}

/** Events (already newest first) grouped by local day with "Sun, Nov 8" headers. */
export function timelineDays(events: readonly PackageEvent[], now: Date, timeZone: string): TimelineDay[] {
  const today = dayNumberOf(now, timeZone);
  const days: TimelineDay[] = [];
  for (const e of events) {
    const day = dayNumberOf(new Date(e.occurredAt), timeZone);
    const entry = { ...e, time: clockTime(e.occurredAt, timeZone) };
    const last = days[days.length - 1];
    if (last && last.day === day) last.events.push(entry);
    else days.push({ day, label: shortDayHeader(day, today), events: [entry] });
  }
  return days;
}

/** "Try again in 2 min" wording from a Retry-After in seconds. */
export function retryWait(seconds: number | null): string {
  const minutes = Math.max(1, Math.ceil((seconds ?? 120) / 60));
  return `${minutes} min`;
}
