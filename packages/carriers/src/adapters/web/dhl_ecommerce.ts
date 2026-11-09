// DHL eCommerce US anonymous Webtrack feed (docs/research/scraping.md "DHL eCommerce US").
//
// Parsing rules (one package, identity echo, EN ROUTE rows, duplicate rows,
// zone labels) and the wording rules in mapDhlEcommerceDescription are ported
// from Universal Parcel Scraper (https://github.com/plhery/universal-parcel-scraper,
// Apache-2.0), carriers/dhl-ecommerce/adapter.ts and status.ts, adapted to
// Porchlight's status set. See THIRD_PARTY_NOTICES.md.

import type { Status, TrackContext, TrackEvent, TrackResult } from "../../types.js";
import { arr, obj, str, type Json } from "../shared/json.js";
import { finishResult } from "../shared/result.js";
import { formatAtOffset, wallClockInZone } from "../shared/time.js";
import type { RegisteredAdapter } from "../shared/types.js";
import { browserHeaders, fetchWeb, malformed, notFound, parseJson, sameNumber, unexpectedReply } from "../shared/web.js";

const ID = "web:dhl_ecommerce";
const ENDPOINT = "https://api.dhlecs.com/webtrack/v4/tracking";

/** Webtrack's clock labels. US labels name a zone; fixed abbreviations name an offset. */
const ZONES: Record<string, string> = {
  ET: "America/New_York",
  CT: "America/Chicago",
  MT: "America/Denver",
  PT: "America/Los_Angeles",
  AKT: "America/Anchorage",
  HT: "Pacific/Honolulu",
};
const FIXED: Record<string, number> = { EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420 };

/** Maps a Webtrack `primaryEventDescription` (or the package `status`). */
export function mapDhlEcommerceDescription(description: string): Status {
  const text = description.trim().toLowerCase();
  if (!text) return "unknown";
  if (/return(?:ed|ing)? to (?:the )?sender/.test(text)) return "returned";
  if (/not delivered|unable to deliver|delivery attempt|delivery failed|carrier exception|shipment exception|delivery exception|damaged|refused|address (?:incorrect|incomplete|unknown)|lost in transit/.test(text)) {
    return "exception";
  }
  if (/ready for (?:pickup|collection)|available for (?:pickup|collection)/.test(text)) return "available_for_pickup";
  if (/out for delivery/.test(text)) return "out_for_delivery";
  if (/^delivered\b/.test(text)) return "delivered";
  if (/label created|manifest data received|en route to dhl ecommerce|awaiting processing|currently awaiting shipment|information received/.test(text)) {
    return "label_created";
  }
  if (/processed|departure|arrival|tendered|accepted|customs|clearance|received|picked up|en route|in transit|sorted|close bag|scanned into/.test(text)) {
    return "in_transit";
  }
  return "unknown";
}

function eventTime(e: Json): string | null {
  const date = str(e.date);
  const time = str(e.time);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(time)) return null;
  const wall = `${date}T${time.length === 5 ? `${time}:00` : time.slice(0, 8)}`;
  const label = str(e.timeZone).toUpperCase();
  const zone = ZONES[label];
  if (zone) return wallClockInZone(wall, zone);
  const fixed = FIXED[label];
  if (fixed !== undefined) {
    const asUtc = Date.parse(`${wall}Z`);
    return formatAtOffset(asUtc - fixed * 60_000, fixed);
  }
  // LT ("the place's own time") or an unknown label: a wall clock with no offset.
  return wall;
}

function toEvents(rows: Json[]): TrackEvent[] {
  const events: TrackEvent[] = [];
  const seen = new Set<string>();
  for (const e of rows) {
    const description = str(e.primaryEventDescription);
    const location = str(e.location);
    const occurredAt = eventTime(e);
    if (!description || !occurredAt) continue;
    // An EN ROUTE row with no place is stamped with the request time: an echo of the status, not a scan.
    if (description.toUpperCase() === "EN ROUTE" && !location) continue;
    const key = [str(e.primaryEventId), str(e.date), str(e.time), str(e.timeZone), description].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ occurredAt, status: mapDhlEcommerceDescription(description), description, location: location || null });
  }
  return events;
}

/** Requires exactly one package that echoes the number. Sender and recipient fields are ignored. */
export function parseDhlEcommerce(body: unknown, number: string): TrackResult {
  const b = obj(body);
  if (!Array.isArray(b.packages) || typeof b.total !== "number") throw malformed(ID, "reply has no packages list");
  if (b.total === 0 && b.packages.length === 0) throw notFound(ID, "Webtrack has no package with this number");
  if (b.packages.length !== 1) throw notFound(ID, `expected one package, got ${b.packages.length}`);
  const pkg = obj(b.packages[0]);
  const ids = [pkg.trackedValue, pkg.trackingId, pkg.packageId, pkg.dhlPackageId, pkg.deliveryConfirmationNumber];
  if (!ids.some((id) => sameNumber(id, number))) throw notFound(ID, "Webtrack answered with a different package");
  if (!Array.isArray(pkg.events)) throw malformed(ID, "package has no events list");
  const events = toEvents(arr(pkg.events).map(obj));
  const summary = str(pkg.status);
  const summaryStatus = mapDhlEcommerceDescription(summary);
  // Delivered and returned summaries are final; otherwise the newest scan is more precise.
  const status = summaryStatus === "delivered" || summaryStatus === "returned" ? summaryStatus : (events[0]?.status ?? summaryStatus);
  if (events.length === 0 && status === "unknown") throw notFound(ID, "package has no scans yet");
  const estimate = /^\d{4}-\d{2}-\d{2}$/.test(str(pkg.estimatedDeliveryDate)) ? str(pkg.estimatedDeliveryDate) : null;
  return finishResult({
    status,
    statusDetail: events[0]?.description ?? summary,
    etaStart: estimate,
    etaEnd: estimate,
    deliveredAt: null,
    events,
  });
}

export function createDhlEcommerceWebAdapter(): RegisteredAdapter {
  return {
    id: ID,
    source: "web",
    supports: (carrier) => carrier === "dhl_ecommerce",
    isConfigured: () => true,
    async track(number: string, _carrier, ctx: TrackContext) {
      const reply = await fetchWeb(ctx, ID, ENDPOINT, {
        method: "POST",
        headers: browserHeaders({
          "content-type": "application/json",
          origin: "https://webtrack.dhlecs.com",
          referer: "https://webtrack.dhlecs.com/",
        }),
        body: JSON.stringify({ trackedValue: number, offset: 0, locale: "en-US" }),
      });
      if (reply.status !== 200) throw unexpectedReply(ID, reply, ctx.now());
      const body = parseJson(reply.text);
      if (body === undefined) throw malformed(ID, "reply is not JSON");
      return parseDhlEcommerce(body, number);
    },
  };
}

export const dhlEcommerceWebAdapter = createDhlEcommerceWebAdapter();
