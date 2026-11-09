// OnTrac / LaserShip public tracking feed (docs/research/scraping.md "OnTrac / LaserShip").
//
// Status codes and number format ported from Universal Parcel Scraper
// (https://github.com/plhery/universal-parcel-scraper, Apache-2.0),
// carriers/ontrac/status.ts and carriers/ontrac/parser.ts, adapted to
// Porchlight's status set. See THIRD_PARTY_NOTICES.md.

import type { Status, TrackContext, TrackEvent, TrackResult } from "../../types.js";
import { arr, obj, str, type Json } from "../shared/json.js";
import { finishResult, place } from "../shared/result.js";
import { hasOffset } from "../shared/time.js";
import type { RegisteredAdapter } from "../shared/types.js";
import { browserHeaders, fetchWeb, malformed, notFound, parseJson, sameNumber, unexpectedReply } from "../shared/web.js";

const ID = "web:ontrac";
const ENDPOINT = "https://webtrack.ontrac.com/PackageServices/tracking/";

/** OnTrac C/D numbers, LaserShip L?-numbers and 1LS… numbers. */
const NUMBER = /^(?:[CD]\d{14}|L[AIEHNX]\d{8}|1LS[A-Z0-9]{12,14})$/;

const CODES: Record<string, Status> = {};
function add(codes: string[], status: Status): void {
  for (const code of codes) CODES[code] = status;
}
add(["XX", "OVRC", "AUTO", "EXRL", "INRL"], "label_created");
// NFRP is the hand-off to another carrier: in transit, not delivered.
add(["PKUP", "PU", "RL", "ALPK", "ARRD", "ORIG", "RCVD", "OS", "FCTF", "SFCT", "LOAD", "NFRP"], "in_transit");
add(["OFDL", "OD"], "out_for_delivery");
add(["DN", "DLVD", "CL", "DM", "DW", "OK", "DD"], "delivered");
add(["BCLD", "UTLV", "NH", "ACSS", "NDMI", "RFDM", "LOST", "MSPK", "UD", "ONHD"], "exception");
add(["RETD", "RETN", "RS"], "returned");

/** Maps an OnTrac EventCode; unlisted codes are `unknown` and keep their text. */
export function mapOntracCode(code: string): Status {
  return CODES[code.trim().toUpperCase()] ?? "unknown";
}

/** A clock with an offset stays an instant; a wall clock without one is kept as local time. */
function eventTime(value: unknown): string {
  const text = str(value);
  return hasOffset(text) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? text : "";
}

/** UtcExpectedDeliveryDateTime is UTC; midnight means a date with no time. */
function eta(value: unknown): string | null {
  const text = str(value);
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(text);
  if (!m) return null;
  const midnight = /^00:00(?::00)?$/.test(m[2] ?? "");
  if (midnight && (!m[3] || m[3].toUpperCase() === "Z")) return m[1] ?? null;
  return m[3] ? text : `${text}Z`;
}

function toEvent(e: Json): TrackEvent | null {
  const description = str(e.EventShortDescription) || str(e.Status);
  if (!description) return null;
  return {
    occurredAt: eventTime(e.ZonedEventDateTime) || eventTime(e.UtcEventDateTime),
    status: mapOntracCode(str(e.EventCode)),
    description,
    location: place(e.City, e.State),
  };
}

/** Reads only tracking fields; Consignee, PodText and photo fields hold personal data and are ignored. */
export function parseOntrac(body: unknown, number: string): TrackResult {
  const packages = obj(body).Packages;
  if (!Array.isArray(packages)) throw malformed(ID, "reply has no Packages list");
  const matches = packages.map(obj).filter((p) => sameNumber(p.Tracking, number));
  if (matches.length !== 1) throw notFound(ID, `expected one matching package, got ${matches.length}`);
  const pkg = matches[0] as Json;
  if (!Array.isArray(pkg.Events)) throw malformed(ID, "package has no Events list");
  const seen = new Set<string>();
  const events: TrackEvent[] = [];
  for (const raw of arr(pkg.Events).map(obj)) {
    const event = toEvent(raw);
    if (!event) continue;
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (events.length === 0) throw notFound(ID, "package has no scans yet");
  const latest = events[0] as TrackEvent;
  const expected = eta(pkg.UtcExpectedDeliveryDateTime);
  return finishResult({
    status: latest.status,
    statusDetail: latest.description,
    etaStart: expected,
    etaEnd: expected,
    deliveredAt: null,
    events,
  });
}

export function createOntracWebAdapter(): RegisteredAdapter {
  return {
    id: ID,
    source: "web",
    supports: (carrier) => carrier === "ontrac" || carrier === "lasership",
    isConfigured: () => true,
    async track(number: string, _carrier, ctx: TrackContext) {
      const n = number.toUpperCase().replace(/[\s.-]/g, "");
      if (!NUMBER.test(n)) throw notFound(ID, "not an OnTrac or LaserShip number");
      const reply = await fetchWeb(ctx, ID, `${ENDPOINT}${encodeURIComponent(n)}`, { method: "GET", headers: browserHeaders() });
      const body = parseJson(reply.text);
      if (reply.status === 404) {
        // The problem-details body means "no such package" only for a valid number (checked above).
        const b = obj(body);
        if (Number(b.Status) === 404 && str(b.Title) === "Not Found") throw notFound(ID, "OnTrac has no package with this number");
        throw unexpectedReply(ID, reply, ctx.now());
      }
      if (reply.status !== 200) throw unexpectedReply(ID, reply, ctx.now());
      if (body === undefined) throw malformed(ID, "reply is not JSON");
      return parseOntrac(body, n);
    },
  };
}

export const ontracWebAdapter = createOntracWebAdapter();
