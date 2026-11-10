// UPS public tracking page, server attempt (docs/research/scraping.md "UPS").
// Any sign of the bot wall (401/403/428, a challenge page, a missing XSRF
// cookie, a timeout) throws device_required so the poller hands the package
// to the native app.
//
// The session flow (page cookies, X-XSRF-TOKEN from X-XSRF-TOKEN-ST,
// GetStatus body), the actCode and progressBarType maps and the year rule for
// the scheduled date are ported from Universal Parcel Scraper
// (https://github.com/plhery/universal-parcel-scraper, Apache-2.0),
// carriers/ups/adapter.ts and status.ts, adapted to Porchlight's status set.
// See THIRD_PARTY_NOTICES.md.

import type { Status, TrackContext, TrackEvent, TrackResult } from "../../types.js";
import { CarrierError } from "../../types.js";
import { arr, obj, str, type Json } from "../shared/json.js";
import { finishResult } from "../shared/result.js";
import { formatAtOffset, parseOffset } from "../shared/time.js";
import type { RegisteredAdapter } from "../shared/types.js";
import {
  browserHeaders,
  BROWSER_USER_AGENT,
  fetchWeb,
  looksLikeChallenge,
  malformed,
  notFound,
  parseJson,
  sameNumber,
  unexpectedReply,
  type WebReply,
} from "../shared/web.js";

const ID = "web:ups";
const STATUS_API = "https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US";
const BLOCKED = new Set([401, 403, 419, 428]);

export function upsPageUrl(number: string): string {
  return `https://www.ups.com/track?loc=en_US&tracknum=${encodeURIComponent(number)}&requester=ST/trackdetails`;
}

const PROGRESS: Record<string, Status> = {
  manifestupload: "label_created",
  firstupspossession: "in_transit",
  intransit: "in_transit",
  outfordelivery: "out_for_delivery",
  delivered: "delivered",
  exception: "exception",
};

const ACT_CODES: Record<string, Status> = {};
for (const [codes, status] of [
  [["MP"], "label_created"],
  [["OF", "OT"], "out_for_delivery"],
  [["9E", "FS", "KB", "KD", "KE", "2W", "YC"], "delivered"],
  [["2Q", "ZP", "5G", "S7"], "available_for_pickup"],
  [["48", "49", "G3", "5R", "AD"], "exception"],
] as [string[], Status][]) {
  for (const code of codes) ACT_CODES[code] = status;
}

/** Maps a scan's actCode; anything unlisted is in transit. */
export function mapUpsActCode(code: string): Status {
  return ACT_CODES[code.trim().toUpperCase()] ?? "in_transit";
}

function blocked(why: string): CarrierError {
  return new CarrierError("device_required", ID, `web:ups: ${why}`);
}

/** Classifies a UPS reply before it is read: the bot wall is device_required. */
function check(reply: WebReply, step: string, now: Date): void {
  if (BLOCKED.has(reply.status)) throw blocked(`${step} returned HTTP ${reply.status}`);
  if (looksLikeChallenge(reply.text)) throw blocked(`${step} returned a bot challenge`);
  if (reply.status < 200 || reply.status >= 300) throw unexpectedReply(ID, reply, now);
}

/** name=value pairs from Set-Cookie headers. */
export function readCookies(headers: Headers): Map<string, string> {
  const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""];
  const cookies = new Map<string, string>();
  for (const line of lines) {
    const pair = line.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  return cookies;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** gmtDate "YYYYMMDD" + gmtTime "HH:MM:SS" is GMT; gmtOffset is the local offset to show it in. */
function scanTime(a: Json): string {
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(str(a.gmtDate));
  const t = /^(\d{2}):(\d{2}):(\d{2})$/.exec(str(a.gmtTime));
  if (d && t) {
    const ms = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), Number(t[3]));
    const offset = parseOffset(str(a.gmtOffset));
    return formatAtOffset(ms, offset ?? 0);
  }
  const local = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(str(a.date));
  return local ? `${local[3]}-${local[1]}-${local[2]}` : "";
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** monthCMSKey "cms.stapp.dec" + dayNum. No year: this year, unless that is over 7 days past. */
export function upsScheduledDate(detail: unknown, now: Date): string | null {
  const d = obj(detail);
  const month = MONTHS[str(d.monthCMSKey).split(".").pop()?.toLowerCase() ?? ""];
  const day = Number(str(d.dayNum));
  if (!month || !Number.isInteger(day) || day < 1 || day > 31) return null;
  const build = (year: number) => {
    const ms = Date.UTC(year, month - 1, day);
    const date = new Date(ms);
    return date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
  };
  const year = now.getUTCFullYear();
  const candidate = build(year);
  if (!candidate) return null;
  const today = Date.UTC(year, now.getUTCMonth(), now.getUTCDate());
  return Date.parse(candidate) < today - 7 * 86_400_000 ? build(year + 1) : candidate;
}

function packageStatus(detail: Json, events: TrackEvent[]): Status {
  const text = str(detail.packageStatus);
  if (arr(detail.returnNumbers).length > 0 || /\breturn/i.test(text)) return "returned";
  const progress = PROGRESS[str(detail.progressBarType).toLowerCase()];
  if (progress === "delivered" && detail.isDeliveredToUAP === true) return "available_for_pickup";
  return progress ?? events[0]?.status ?? "unknown";
}

/** Reads only status, scans and the scheduled date; receivedBy, addresses, signature and photo links are ignored. */
const CLOCK = /^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$/i;

/** "1:30 P.M." → minutes after midnight; null when it isn't a clock time. */
function clockMinutes(text: string): number | null {
  const m = CLOCK.exec(text.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  return ((hour % 12) + (m[3]!.toUpperCase() === "P" ? 12 : 0)) * 60 + minute;
}

/**
 * packageStatusTime "1:30 P.M. - 3:30 P.M." on `date` ("YYYY-MM-DD") at
 * `offset` minutes east of UTC, as [start, end]. Null for anything else
 * ("End of Day", empty) or when the offset is unknown: the date stands alone.
 */
export function upsDeliveryWindow(date: string, text: string, offset: number | null): [string, string] | null {
  if (offset === null) return null;
  const parts = text.split(/\s+-\s+/);
  if (parts.length !== 2) return null;
  const [start, end] = parts.map(clockMinutes);
  if (start == null || end == null || end < start) return null;
  const at = (minutes: number) => formatAtOffset(Date.parse(`${date}T00:00:00Z`) + minutes * 60_000 - offset * 60_000, offset);
  return [at(start), at(end)];
}

export function parseUpsStatus(body: unknown, number: string, now: Date): TrackResult {
  const b = obj(body);
  if (str(b.statusCode) !== "200" && b.statusCode !== 200) throw malformed(ID, `GetStatus statusCode ${str(b.statusCode) || "missing"}`);
  if (!Array.isArray(b.trackDetails)) throw malformed(ID, "reply has no trackDetails");
  const details = arr(b.trackDetails).map(obj).filter((d) => sameNumber(d.trackingNumber, number) || sameNumber(d.requestedTrackingNumber, number));
  if (details.length !== 1) throw notFound(ID, `expected one matching package, got ${details.length}`);
  const detail = details[0] as Json;
  if (str(detail.errorCode)) throw notFound(ID, `UPS: ${str(detail.errorText) || `error ${str(detail.errorCode)}`}`);
  const events: TrackEvent[] = arr(detail.shipmentProgressActivities)
    .map(obj)
    .filter((a) => str(a.activityScan))
    .map((a) => ({
      occurredAt: scanTime(a),
      status: mapUpsActCode(str(a.actCode)),
      description: str(a.activityScan),
      location: str(a.location) || null,
    }));
  if (events.length === 0) throw notFound(ID, "UPS has no scans for this number");
  const status = packageStatus(detail, events);
  const scheduled = upsScheduledDate(detail.scheduledDeliveryDateDetail, now);
  // The window is a wall clock where the package is headed; the newest scan's offset stands in for that zone.
  const offset = arr(detail.shipmentProgressActivities).map((a) => parseOffset(str(obj(a).gmtOffset))).find((o) => o !== null) ?? null;
  const window = scheduled ? upsDeliveryWindow(scheduled, str(detail.packageStatusTime), offset) : null;
  return finishResult({
    status,
    statusDetail: str(detail.packageStatus) || (events[0] as TrackEvent).description,
    etaStart: window?.[0] ?? scheduled,
    etaEnd: window?.[1] ?? scheduled,
    deliveredAt: null,
    events,
  });
}

export function createUpsWebAdapter(): RegisteredAdapter {
  return {
    id: ID,
    source: "web",
    supports: (carrier) => carrier === "ups",
    isConfigured: () => true,
    async track(number: string, _carrier, ctx: TrackContext) {
      const pageUrl = upsPageUrl(number);
      const page = await fetchWeb(
        ctx,
        ID,
        pageUrl,
        {
          method: "GET",
          headers: {
            "user-agent": BROWSER_USER_AGENT,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "none",
            "upgrade-insecure-requests": "1",
          },
        },
        { onTimeout: "device_required" },
      );
      check(page, "tracking page", ctx.now());
      const cookies = readCookies(page.headers);
      const xsrf = decode(cookies.get("X-XSRF-TOKEN-ST") ?? "");
      if (!xsrf) throw blocked("tracking page set no X-XSRF-TOKEN-ST cookie");
      const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      const reply = await fetchWeb(
        ctx,
        ID,
        STATUS_API,
        {
          method: "POST",
          headers: browserHeaders({
            "content-type": "application/json",
            origin: "https://www.ups.com",
            referer: pageUrl,
            cookie: cookieHeader,
            "x-xsrf-token": xsrf,
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-site",
          }),
          body: JSON.stringify({
            Locale: "en_US",
            TrackingNumber: [number.toLowerCase()],
            Requester: "st/trackdetails",
            returnToValue: "",
          }),
        },
        { onTimeout: "device_required" },
      );
      check(reply, "GetStatus", ctx.now());
      const body = parseJson(reply.text);
      // A 200 that isn't JSON is the bot wall's interstitial in another form.
      if (body === undefined) throw blocked("GetStatus reply is not JSON");
      return parseUpsStatus(body, number, ctx.now());
    },
  };
}

export const upsWebAdapter = createUpsWebAdapter();
