// Jitsu / AxleHire recipient tracking feed (docs/research/scraping.md "Jitsu / AxleHire").
//
// The signal map, the notices that move nothing, the not-found body check,
// the challenge markers and the delivery-window rules are ported from
// Universal Parcel Scraper (https://github.com/plhery/universal-parcel-scraper,
// Apache-2.0), carriers/jitsu/status.ts, parser.ts and adapter.ts, adapted to
// Porchlight's status set. See THIRD_PARTY_NOTICES.md.

import type { Status, TrackContext, TrackEvent, TrackResult } from "../../types.js";
import { CarrierError } from "../../types.js";
import { arr, obj, str, type Json } from "../shared/json.js";
import { finishResult } from "../shared/result.js";
import { hasOffset, instantInZone, isZone } from "../shared/time.js";
import type { RegisteredAdapter } from "../shared/types.js";
import { browserHeaders, fetchWeb, looksLikeChallenge, malformed, notFound, parseJson, unexpectedReply } from "../shared/web.js";

const ID = "web:jitsu";
const ENDPOINT = "https://api.recipient.gojitsu.com/delivery/";
/**
 * Codes from tracking.gojitsu.com/{code} links are 12 or 16 letters and
 * digits, but Jitsu also tracks some shippers' own numbers as they are
 * (SCD… and JT… numbers, from old axlehire.com links). The service matches
 * any case, and its own 404 body says when a code is unknown.
 */
const CODE = /^[a-z0-9]{4,40}$/;

const SIGNALS: Record<string, Status> = {
  "PLANNING.CREATED": "label_created",
  "PLANNING.GEOCODED": "label_created",
  "PLANNING.UNSERVICEABLE": "exception",
  "OTHER.IN_TRANSIT": "in_transit",
  "INBOUND.RECEIVED_OK": "in_transit",
  "INBOUND.FIRST_SCAN": "in_transit",
  "INBOUND.PRESORT_SCAN": "in_transit",
  "INBOUND.REGIONAL_SCAN": "in_transit",
  "INBOUND.INFERRED_SCAN": "in_transit",
  "INBOUND.RECEIVED_DAMAGED": "exception",
  "INBOUND.DAMAGED": "exception",
  "INBOUND.LOST": "exception",
  "OUTBOUND.PICKUP_SCHEDULED": "in_transit",
  "OUTBOUND.PICKUP_SUCCEEDED": "out_for_delivery",
  "OUTBOUND.DROPOFF_EN_ROUTE": "out_for_delivery",
  "OUTBOUND.DROPOFF_READY": "out_for_delivery",
  "OUTBOUND.DROPOFF_REATTEMPTING": "out_for_delivery",
  "OUTBOUND.DROPOFF_SUCCEEDED": "delivered",
  "OUTBOUND.DROPOFF_FAILED": "exception",
  "OUTBOUND.RETURN_SUCCEEDED": "in_transit",
  "OUTBOUND.RETURN_FAILED": "exception",
  "OUTBOUND.RETURN_DAMAGED": "exception",
  "OUTBOUND.UNDELIVERABLE": "exception",
  "OUTBOUND.DISPOSABLE": "exception",
};

/** Notices, not movements: they keep the status of the scan before them. */
const QUIET = new Set([
  "INBOUND.MISSING",
  "INBOUND.NOT_RECEIVED",
  "INBOUND.MANIFEST_NOT_RECEIVED",
  "INBOUND.NO_ACTIVITY",
  "INBOUND.SHIPMENT_ROLLED",
  "OUTBOUND.PICKUP_DELAY",
  "OUTBOUND.DRIVER_DELAY",
  "OUTBOUND.DROPOFF_DELAY",
  "OUTBOUND.PICKUP_FAILED",
]);

/** Maps `type.signal`; null for a notice that keeps the previous status. */
export function mapJitsuSignal(code: string): Status | null {
  if (QUIET.has(code)) return null;
  return SIGNALS[code] ?? "unknown";
}

/** The service's own 404 body for a code it doesn't know. */
export function isJitsuNotFound(body: unknown, code: string): boolean {
  const b = obj(body);
  return str(b.servlet) === "jersey" && str(b.message) === "Not Found" && String(b.status) === "404" && str(b.url).toLowerCase() === `/delivery/${code}`;
}

interface Scan {
  event: TrackEvent;
  at: number;
  code: string;
}

/** Reads type, signal, description, ts and the place on facility scans. Driver, remark, photo and customer fields are ignored. */
function toScans(rows: Json[], zone: string | null): Scan[] {
  const scans: Scan[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const code = `${str(row.type)}.${str(row.signal)}`;
    const ts = str(row.ts);
    // An address change made by the recipient moves nothing; a row without a clock is not shown.
    if (code === "OUTBOUND.UPDATE_DROPOFF" || code.startsWith("RECYCLE.") || !hasOffset(ts)) continue;
    const description = str(row.description).replace(/[\s,]+$/, "") || str(row.milestone);
    if (!description) continue;
    const attributes = obj(row.attributes);
    const facility = str(row.type) === "INBOUND" || str(row.type) === "OTHER";
    const location = facility && str(attributes.city) && str(attributes.state) ? `${str(attributes.city)}, ${str(attributes.state)}` : null;
    const at = Date.parse(ts);
    const event: TrackEvent = { occurredAt: instantInZone(at, zone), status: "unknown", description, location };
    const key = `${code}|${JSON.stringify(event)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push({ event, at, code });
  }
  scans.sort((a, b) => b.at - a.at);
  // Oldest first, so a notice keeps the status of the scan before it.
  let previous: Status = "label_created";
  for (const scan of [...scans].reverse()) {
    const mapped = mapJitsuSignal(scan.code);
    scan.event.status = mapped ?? previous;
    if (mapped !== null && mapped !== "unknown") previous = mapped;
  }
  return scans;
}

function truthy(value: unknown): boolean {
  return value === true || value === "true";
}

function window(payload: Json, shipment: Json, status: Status, newest: number, zone: string | null): { start: string | null; end: string | null } {
  const none = { start: null, end: null };
  if (truthy(obj(payload.settings).hide_delivery_datetime)) return none;
  if (!["label_created", "in_transit", "out_for_delivery"].includes(status)) return none;
  const from = str(shipment.dropoff_earliest_ts);
  const to = str(shipment.dropoff_latest_ts);
  if (!hasOffset(from) || !hasOffset(to)) return none;
  const start = Date.parse(from);
  const end = Date.parse(to);
  // A window that ends before the newest scan has passed.
  if (start > end || end < newest) return none;
  return { start: instantInZone(start, zone), end: instantInZone(end, zone) };
}

export function parseJitsu(body: unknown, code: string, now: Date): TrackResult {
  const payload = obj(body);
  const shipment = obj(payload.shipment);
  if (!str(shipment.tracking_code)) throw malformed(ID, "reply has no shipment tracking code");
  if (str(shipment.tracking_code).toLowerCase() !== code) throw notFound(ID, "Jitsu answered with a different shipment");
  if (!Array.isArray(payload.outbound_events ?? [])) throw malformed(ID, "outbound_events is not a list");
  const declared = str(shipment.timezone);
  const zone = declared && isZone(declared) ? declared : null;
  const scans = toScans(arr(payload.outbound_events).map(obj), zone);
  const newest = scans[0];
  if (!newest) throw notFound(ID, "shipment has no scans yet");
  const status: Status = truthy(shipment.returnShipment) ? "returned" : newest.event.status;
  const eta = window(payload, shipment, status, Math.max(newest.at, now.getTime()), zone);
  return finishResult({
    status,
    statusDetail: newest.event.description,
    etaStart: eta.start,
    etaEnd: eta.end,
    deliveredAt: null,
    events: scans.map((s) => s.event),
  });
}

export function createJitsuWebAdapter(): RegisteredAdapter {
  return {
    id: ID,
    source: "web",
    supports: (carrier) => carrier === "jitsu",
    isConfigured: () => true,
    async track(number: string, _carrier, ctx: TrackContext) {
      const code = number.trim().toLowerCase();
      if (!CODE.test(code)) throw notFound(ID, "not a Jitsu tracking code");
      const reply = await fetchWeb(ctx, ID, `${ENDPOINT}${code}`, { method: "GET", headers: browserHeaders(), redirect: "manual" });
      if (looksLikeChallenge(reply.text)) throw new CarrierError("transient", ID, "web:jitsu answered with a Cloudflare challenge");
      const body = parseJson(reply.text);
      if (reply.status === 404 && isJitsuNotFound(body, code)) throw notFound(ID, "Jitsu has no delivery with this code");
      if (reply.status !== 200) throw unexpectedReply(ID, reply, ctx.now());
      if (body === undefined) throw malformed(ID, "reply is not JSON");
      return parseJitsu(body, code, ctx.now());
    },
  };
}

export const jitsuWebAdapter = createJitsuWebAdapter();
