// Amazon Logistics public tracker, by TBA (docs/research/scraping.md "Amazon Logistics").
//
// The nested-JSON handling, the not-found and expired error codes, the clock
// rule (a time without an offset is UTC) and the fallback wording rules in
// classifyAmazon are ported from Universal Parcel Scraper
// (https://github.com/plhery/universal-parcel-scraper, Apache-2.0),
// carriers/amazon-shipping/adapter.ts and status.ts, adapted to Porchlight's
// status set. See THIRD_PARTY_NOTICES.md.

import type { Status, TrackContext, TrackEvent, TrackResult } from "../../types.js";
import { CarrierError } from "../../types.js";
import { arr, obj, str, type Json } from "../shared/json.js";
import { finishResult } from "../shared/result.js";
import { hasOffset, instantInZone } from "../shared/time.js";
import type { RegisteredAdapter } from "../shared/types.js";
import { browserHeaders, fetchWeb, looksLikeChallenge, malformed, notFound, parseJson, sameNumber, unexpectedReply } from "../shared/web.js";

const ID = "web:amazon";
const ENDPOINT = "https://track.amazon.com/api/tracker/";
const TBA = /^TB[ACM]\d{12}$/;

/** scraping.md's eventCode table. */
const CODES: Record<string, Status> = {
  CreationConfirmed: "label_created",
  LabelCreated: "label_created",
  PickupDone: "in_transit",
  Received: "in_transit",
  InTransit: "in_transit",
  Departed: "in_transit",
  ArrivedAtSortCenter: "in_transit",
  ArrivedAtDeliveryCenter: "in_transit",
  Sorted: "in_transit",
  Transferred: "in_transit",
  InTransitToCustomer: "in_transit",
  OutForDelivery: "out_for_delivery",
  Delivered: "delivered",
  DeliveryAttempted: "exception",
  AttemptFail: "exception",
  Undeliverable: "exception",
  Exception: "exception",
  Refused: "returned",
  Returned: "returned",
  OutForReturn: "returned",
  ReturnReceived: "returned",
};

const DESCRIPTIONS: Record<string, string> = {
  CreationConfirmed: "Shipment information received",
  LabelCreated: "Label created",
  PickupDone: "Picked up",
  Received: "Package received",
  Departed: "Departed facility",
  ArrivedAtSortCenter: "Arrived at sort center",
  ArrivedAtDeliveryCenter: "Arrived at delivery station",
  InTransitToCustomer: "On the way",
  OutForDelivery: "Out for delivery",
  Delivered: "Delivered",
  DeliveryAttempted: "Delivery attempted",
  Held: "Held",
};

const key = (value: unknown) => (typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]+/g, "") : "");
const any = (k: string, words: string[]) => words.some((w) => k.includes(w));

/** Wording rules for codes and string ids the table doesn't list; first match wins. */
export function classifyAmazon(...signals: unknown[]): Status {
  const k = signals.map(key).filter(Boolean).join(" ");
  if (!k) return "unknown";
  if (any(k, ["returnedto", "returntosender", "returningtosender", "refused"])) return "returned";
  if (any(k, ["deliveryattempted", "failedattempt", "attemptfail", "unabletodeliver", "undeliverable", "damaged", "lost", "addressproblem", "exception"])) {
    return "exception";
  }
  if (any(k, ["delivered"])) return "delivered";
  if (any(k, ["readyforpickup", "awaitingcustomerpickup", "holdforpickup"])) return "available_for_pickup";
  if (any(k, ["outfordelivery", "swarexofd"])) return "out_for_delivery";
  if (any(k, ["creationconfirmed", "labelcreated", "shipmentcreated", "informationreceived"])) return "label_created";
  if (any(k, ["intransit", "pickupdone", "pickedup", "received", "departed", "arrived", "sortcenter", "deliverycenter", "sorted", "transferred"])) {
    return "in_transit";
  }
  return "unknown";
}

/** `Held` is a pickup only when a pickup location is named; otherwise it needs attention. */
export function mapAmazonEvent(code: string, stringId: string, pickupNamed: boolean): Status {
  if (code === "Held") return pickupNamed ? "available_for_pickup" : "exception";
  return CODES[code] ?? classifyAmazon(code, stringId);
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Amazon mixes ISO strings and "Aug 11, 2026, 4:31:56 PM". A time with no
 * offset is UTC on every host (the tracker promises US deliveries for 3 AM UTC,
 * the evening before in every US zone). A bare date stays a date.
 */
export function amazonTime(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (hasOffset(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) return `${text}Z`;
  const m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))? ?([AP]M)$/i.exec(text);
  if (!m) return null;
  const month = MONTHS[(m[1] ?? "").toLowerCase()];
  if (!month) return null;
  let hour = Number(m[4]) % 12;
  if ((m[7] ?? "").toUpperCase() === "PM") hour += 12;
  const ms = Date.UTC(Number(m[3]), month - 1, Number(m[2]), hour, Number(m[5]), Number(m[6] ?? 0));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace(".000Z", "Z");
}

/**
 * The ETA: an instant only when Amazon gave an offset (scraping.md). A clock
 * without one (UTC by the rule above, often 3 AM for "by end of day") names
 * the delivery day, read in US Eastern time so 03:00 UTC stays the evening before.
 */
export function amazonEta(value: unknown): string | null {
  const text = str(value);
  const at = amazonTime(value);
  if (at === null || /^\d{4}-\d{2}-\d{2}$/.test(at) || hasOffset(text)) return at;
  return instantInZone(Date.parse(at), "America/New_York").slice(0, 10);
}

/** Reads a field that is either an object or JSON encoded as a string. */
function nested(value: unknown, field: string): Json | null {
  if (value === null || value === undefined || value === "null" || value === "") return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Json;
  if (typeof value !== "string") throw malformed(ID, `${field} is not JSON`);
  const parsed = parseJson(value);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw malformed(ID, `${field} is not JSON`);
  return parsed as Json;
}

/** City, state and country only; the same object carries the street and postcode. */
function location(value: unknown): string | null {
  const l = obj(value);
  const parts = [l.city, l.stateProvince, l.countryCode].map(str).filter((p) => p && !/^n\/a$/i.test(p));
  return parts.length ? [...new Set(parts)].join(", ") : null;
}

function describe(code: string, status: Status): string {
  if (DESCRIPTIONS[code]) return DESCRIPTIONS[code] as string;
  if (code) return code.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  return status === "unknown" ? "Update" : status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function metadataValue(metadata: Json, field: string): unknown {
  const value = metadata[field];
  if (value === null || typeof value !== "object") return value;
  const v = value as Json;
  return v.stringValue ?? v.date ?? v.value;
}

const NOT_FOUND_ERRORS = /TRACKING_?ID_NOT_FOUND|INVALID_?TRACKING_?ID|INVALID_OFF_AMAZON_ORDER|SHIPMENT_OLDER_THAN/i;

/** Parses the tracker reply. Addresses, recipient, geocode and proof-of-delivery fields are ignored. */
export function parseAmazon(body: unknown, number: string): TrackResult {
  const b = obj(body);
  const progress = nested(b.progressTracker, "progressTracker");
  if (!progress) throw malformed(ID, "reply has no progressTracker");
  const errors = arr(progress.errors).map(obj);
  const codes = errors.map((e) => `${str(e.errorCode)} ${str(e.errorMessage)}`);
  if (codes.some((c) => NOT_FOUND_ERRORS.test(c))) throw notFound(ID, `Amazon does not track this number (${str(errors[0]?.errorCode)})`);
  if (errors.length) throw malformed(ID, `tracker errors: ${codes.join(", ")}`);
  for (const id of [b.trackingId, progress.trackingId]) {
    if (id !== undefined && id !== null && !sameNumber(id, number)) throw notFound(ID, "tracker answered for a different number");
  }
  const history = nested(b.eventHistory, "eventHistory");
  const pickupNamed = b.deliveryLocationDetails !== null && b.deliveryLocationDetails !== undefined && b.deliveryLocationDetails !== "null";
  const seen = new Set<string>();
  const events: { event: TrackEvent; at: number }[] = [];
  for (const row of arr(history?.eventHistory).map(obj)) {
    const code = str(row.eventCode);
    const stringId = str(obj(row.statusSummary).localisedStringId);
    const occurredAt = amazonTime(row.eventTime);
    if (!occurredAt || (!code && !stringId)) continue;
    const status = mapAmazonEvent(code, stringId, pickupNamed);
    const event: TrackEvent = { occurredAt, status, description: describe(code, status), location: location(row.location) };
    const k = JSON.stringify(event);
    if (seen.has(k)) continue;
    seen.add(k);
    events.push({ event, at: Date.parse(occurredAt) });
  }
  events.sort((x, y) => y.at - x.at);
  const summary = obj(progress.summary);
  const metadata = obj(summary.metadata);
  const summaryStatus = classifyAmazon(metadataValue(metadata, "trackingStatus"), summary.status);
  const latest = events[0]?.event;
  if (!latest && summaryStatus === "unknown") throw notFound(ID, "tracker has no history for this number");
  const expected = amazonEta(progress.expectedDeliveryDate) ?? amazonEta(metadataValue(metadata, "expectedDeliveryDate"));
  return finishResult({
    status: latest?.status ?? summaryStatus,
    statusDetail: latest?.description ?? str(summary.status),
    etaStart: expected,
    etaEnd: expected,
    deliveredAt: null,
    events: events.map((e) => e.event),
  });
}

export function createAmazonWebAdapter(): RegisteredAdapter {
  return {
    id: ID,
    source: "web",
    supports: (carrier) => carrier === "amazon",
    isConfigured: () => true,
    async track(number: string, _carrier, ctx: TrackContext) {
      const tba = number.trim().toUpperCase();
      if (!TBA.test(tba)) throw notFound(ID, "not a TBA tracking number");
      const reply = await fetchWeb(ctx, ID, `${ENDPOINT}${tba}`, {
        method: "GET",
        headers: browserHeaders({ referer: "https://track.amazon.com/" }),
      });
      const body = parseJson(reply.text);
      if (body === undefined && looksLikeChallenge(reply.text)) {
        throw new CarrierError("transient", ID, "web:amazon answered with a robot check");
      }
      if (reply.status !== 200) throw unexpectedReply(ID, reply, ctx.now());
      if (body === undefined) throw malformed(ID, "reply is not JSON");
      return parseAmazon(body, tba);
    },
  };
}

export const amazonWebAdapter = createAmazonWebAdapter();
