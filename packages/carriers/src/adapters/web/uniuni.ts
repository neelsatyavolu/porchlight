// UniUni public tracking feed (docs/research/scraping.md "UniUni").
//
// State codes, the "on its way to UniUni" rule for 202, the one-parcel checks
// and the estimate parsing are ported from Universal Parcel Scraper
// (https://github.com/plhery/universal-parcel-scraper, Apache-2.0),
// carriers/uniuni/status.ts, parser.ts and estimate.ts, adapted to
// Porchlight's status set. See THIRD_PARTY_NOTICES.md.

import type { Status, TrackContext, TrackEvent, TrackResult } from "../../types.js";
import { CarrierError } from "../../types.js";
import { arr, obj, str, type Json } from "../shared/json.js";
import { finishResult, place } from "../shared/result.js";
import { formatAtOffset, isZone, wallClockInZone } from "../shared/time.js";
import type { RegisteredAdapter } from "../shared/types.js";
import { browserHeaders, fetchWeb, malformed, notFound, parseJson, sameNumber, unexpectedReply } from "../shared/web.js";

const ID = "web:uniuni";
const ENDPOINT = "https://tracking-service-api.uniuni.ca/tracking/trackinguniuninew";
const EDD_ENDPOINT = "https://sj.uniexpress.ca/version2/orders/edd_information";
/** Public constant from UniUni's tracking page JS, not a secret. CarrierEnv.UNIUNI_SITE_KEY overrides it. */
export const UNIUNI_DEFAULT_SITE_KEY = "SMq45nJhQuNR3WHsJA6N";
/** The estimate is optional, so it gets a short budget of its own. */
const EDD_TIMEOUT_MS = 4_000;

const STATES = new Map<number, Status>([
  [190, "label_created"],
  [1870, "label_created"],
  ...[199, 1910, 4010, 195, 255, 218, 219, 200, 204, 217].map((s) => [s, "in_transit"] as [number, Status]),
  [202, "out_for_delivery"],
  [211, "exception"],
  ...[203, 216, 228].map((s) => [s, "delivered"] as [number, Status]),
  ...[206, 207, 209, 215, 222, 229, 235].map((s) => [s, "exception"] as [number, Status]),
  [230, "returned"],
]);

/** A cross-border shipper's notice that its data reached UniUni; UniUni doesn't have the parcel yet. */
const SHIPPER_NOTICE = /on its way to uniuni/i;

export function mapUniuniState(state: number, description: string): Status {
  if (state === 202 && SHIPPER_NOTICE.test(description)) return "label_created";
  return STATES.get(state) ?? "unknown";
}

/** dateTime.ts is epoch seconds; offsetByGMT (seconds) gives the local offset. */
function scanTime(value: unknown): string {
  const d = obj(value);
  if (typeof d.ts === "number" && Number.isFinite(d.ts) && d.ts > 1_000_000_000) {
    const offset = typeof d.offsetByGMT === "number" && Math.abs(d.offsetByGMT) <= 14 * 3600 ? Math.round(d.offsetByGMT / 60) : 0;
    return formatAtOffset(d.ts * 1000, offset);
  }
  const local = str(d.localTime).replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(local)) return "";
  const zone = str(d.timezone);
  return (zone && isZone(zone) ? wallClockInZone(local, zone) : null) ?? local;
}

export function parseUniuni(body: unknown, number: string): TrackResult {
  const b = obj(body);
  const data = obj(b.data);
  if (str(b.status) !== "SUCCESS" || !Array.isArray(data.valid_tno)) throw malformed(ID, "unexpected reply");
  const valid = arr(data.valid_tno).map(obj);
  const invalid = str(data.invalid_tno).split(",").map((v) => v.trim()).filter(Boolean);
  // Old numbers look the same as invalid ones: both come back under invalid_tno.
  if (valid.length === 0) throw notFound(ID, "UniUni has no parcel with this number (or it has expired)");
  if (valid.length !== 1 || invalid.length > 0 || !sameNumber(valid[0]?.tno, number)) {
    throw notFound(ID, "UniUni did not return one matching parcel");
  }
  const item = valid[0] as Json;
  if (!Array.isArray(item.spath_list)) throw malformed(ID, "parcel has no spath_list");
  const events: TrackEvent[] = [];
  const seen = new Set<string>();
  // spath_list is oldest first. Only the English summary, city and province are read;
  // pathInfo, addresses, coordinates and operators can hold personal data.
  for (const scan of [...arr(item.spath_list)].reverse().map(obj)) {
    const description = str(scan.description_en);
    if (!description) continue;
    const state = typeof scan.state === "number" ? scan.state : Number.NaN;
    const event: TrackEvent = {
      occurredAt: scanTime(scan.dateTime),
      status: mapUniuniState(state, description),
      description,
      location: place(scan.city, scan.province),
    };
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (events.length === 0) throw notFound(ID, "parcel has no scans yet");
  const latest = events[0] as TrackEvent;
  return finishResult({ status: latest.status, statusDetail: latest.description, etaStart: null, etaEnd: null, deliveredAt: null, events });
}

export interface UniuniEstimate {
  start: string | null;
  end: string | null;
}

/** The EDD reply: a bare date is date-only; start, end and a zone together are a timed window. */
export function parseUniuniEstimate(body: unknown, number: string): UniuniEstimate | null {
  const b = obj(body);
  const data = arr(b.data).map(obj);
  if (str(b.status) !== "SUCCESS" || data.length !== 1 || !sameNumber(data[0]?.tno, number)) return null;
  const item = data[0] as Json;
  if (item.edd_enabled !== true) return null;
  const est = obj(item.delivery_estimate);
  const day = str(est.estimated_delivery_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
  const from = str(est.estimated_delivery_time_start);
  const to = str(est.estimated_delivery_time_end);
  const zone = str(est.timezone);
  if (clock.test(from) && clock.test(to) && from < to && zone && isZone(zone)) {
    const start = wallClockInZone(`${day}T${from}`, zone);
    const end = wallClockInZone(`${day}T${to}`, zone);
    if (start && end) return { start, end };
  }
  return { start: day, end: day };
}

async function fetchEstimate(ctx: TrackContext, number: string): Promise<UniuniEstimate | null> {
  try {
    const reply = await fetchWeb(
      ctx,
      ID,
      EDD_ENDPOINT,
      { method: "POST", headers: browserHeaders({ "content-type": "application/json" }), body: JSON.stringify({ tnos: [number] }) },
      { timeoutMs: EDD_TIMEOUT_MS },
    );
    return reply.status === 200 ? parseUniuniEstimate(parseJson(reply.text), number) : null;
  } catch (error) {
    // The estimate is optional; a failure must not discard the history we already have.
    if (error instanceof CarrierError) return null;
    throw error;
  }
}

export function createUniuniWebAdapter(): RegisteredAdapter {
  return {
    id: ID,
    source: "web",
    supports: (carrier) => carrier === "uniuni",
    isConfigured: () => true,
    async track(number: string, _carrier, ctx: TrackContext) {
      const key = ctx.env.UNIUNI_SITE_KEY || UNIUNI_DEFAULT_SITE_KEY;
      const query = new URLSearchParams({ id: number, key, source: "web" });
      const reply = await fetchWeb(ctx, ID, `${ENDPOINT}?${query}`, { method: "GET", headers: browserHeaders() });
      if (reply.status !== 200) throw unexpectedReply(ID, reply, ctx.now());
      const body = parseJson(reply.text);
      if (body === undefined) throw malformed(ID, "reply is not JSON");
      const result = parseUniuni(body, number);
      if (result.status === "delivered" || result.status === "returned") return result;
      const estimate = await fetchEstimate(ctx, number);
      if (!estimate) return result;
      return finishResult({ ...result, etaStart: estimate.start, etaEnd: estimate.end });
    },
  };
}

export const uniuniWebAdapter = createUniuniWebAdapter();
