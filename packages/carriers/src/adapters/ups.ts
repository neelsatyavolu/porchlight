import type { CarrierEnv, Status, TrackContext, TrackEvent, TrackResult } from "../types.js";
import { CarrierError } from "../types.js";
import { requestJson } from "./shared/http.js";
import { arr, obj, str, type Json } from "./shared/json.js";
import { memoryTokenCache, OAuthTokens, type TokenCache } from "./shared/oauth.js";
import { finishResult, place } from "./shared/result.js";
import type { RegisteredAdapter } from "./shared/types.js";

// UPS Track API v1. See docs/research/carrier-apis.md §2.
const ID = "ups";
const BASE = "https://onlinetools.ups.com";
const NOT_FOUND_CODES = new Set(["TW0001", "151018", "151044"]);

export interface UpsStatus {
  type?: string;
  code?: string;
  description?: string;
}

/**
 * Maps an activity's `status`. Returns null for `U` (an update, usually a new
 * delivery date), which keeps the status it follows.
 */
export function mapUpsActivity(status: UpsStatus): Status | null {
  const type = str(status.type).toUpperCase();
  const code = str(status.code).toUpperCase();
  const text = str(status.description).toLowerCase();
  if (type === "U") return null;
  if (code === "OT" || /out for delivery|loaded on delivery vehicle|on vehicle for delivery/.test(text)) return "out_for_delivery";
  if (type === "RS" || /return(ing|ed)? to (the )?(sender|shipper)/.test(text)) return "returned";
  if (/access point|awaiting customer pick ?up|ready for (customer )?pick ?up|available for pick ?up/.test(text)) {
    return "available_for_pickup";
  }
  if (type === "D") return "delivered";
  if (type === "X") return "exception";
  if (type === "M" || type === "MV") return "label_created";
  if (type === "I" || type === "P") return "in_transit";
  return "unknown";
}

/** "YYYYMMDD" → "YYYY-MM-DD"; null when malformed. */
function upsDate(value: unknown): string | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(str(value));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** "HHMMSS" or "HH:MM:SS" → "HH:MM:SS"; null when blank or malformed. */
function upsTime(value: unknown): string | null {
  const m = /^(\d{2}):?(\d{2}):?(\d{2})$/.exec(str(value));
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}

function joinDateTime(date: string | null, time: string | null): string | null {
  if (!date) return null;
  return time ? `${date}T${time}` : date;
}

/** Local time with the carrier's GMT offset when given, else GMT, else bare local time. */
function activityTime(a: Json): string {
  const local = joinDateTime(upsDate(a.date), upsTime(a.time));
  const offset = str(a.gmtOffset);
  if (local && local.includes("T") && /^[+-]\d{2}:\d{2}$/.test(offset)) return `${local}${offset}`;
  const gmt = joinDateTime(upsDate(a.gmtDate), upsTime(a.gmtTime));
  if (gmt && gmt.includes("T")) return `${gmt}Z`;
  return local ?? "";
}

/** Activities come newest first; a `U` update inherits the status of the event before it. */
function toEvents(activities: Json[]): TrackEvent[] {
  const events: TrackEvent[] = [];
  let carried: Status = "unknown";
  for (const a of [...activities].reverse()) {
    const status = obj(a.status);
    carried = mapUpsActivity(status) ?? carried;
    const address = obj(obj(a.location).address);
    events.push({
      occurredAt: activityTime(a),
      status: carried,
      description: str(status.description),
      location: place(address.city, address.stateProvince, address.countryCode),
    });
  }
  return events.reverse();
}

function eta(pkg: Json): { start: string | null; end: string | null } {
  const dates = arr(pkg.deliveryDate).map(obj);
  const pick = dates.find((d) => str(d.type) === "RDD") ?? dates.find((d) => str(d.type) === "SDD");
  const date = upsDate(pick?.date);
  if (!date) return { start: null, end: null };
  const window = obj(pkg.deliveryTime);
  const timed = str(window.type) !== "DEL";
  return {
    start: joinDateTime(date, timed ? upsTime(window.startTime) : null),
    end: joinDateTime(date, timed ? upsTime(window.endTime) : null),
  };
}

function parse(body: unknown): TrackResult {
  const shipment = obj(arr(obj(obj(body).trackResponse).shipment)[0]);
  const warning = arr(shipment.warnings).map(obj).find((w) => NOT_FOUND_CODES.has(str(w.code)));
  const pkg = arr(shipment.package)[0];
  if (warning || pkg === undefined) {
    throw new CarrierError("not_found", ID, `ups: ${str(warning?.message) || "no package in response"}`);
  }
  const p = obj(pkg);
  const activities = arr(p.activity).map(obj);
  const events = toEvents(activities);
  const latest = activities.find((a) => str(obj(a.status).type).toUpperCase() !== "U");
  const current = obj(p.currentStatus);
  const { start, end } = eta(p);
  return finishResult({
    status: events[0]?.status ?? mapUpsActivity(current) ?? "unknown",
    statusDetail: str(obj(latest?.status).description) || str(current.description),
    etaStart: start,
    etaEnd: end,
    deliveredAt: null,
    events,
  });
}

export function createUpsAdapter(options: { tokenCache?: TokenCache } = {}): RegisteredAdapter {
  const tokens = new OAuthTokens(ID, options.tokenCache ?? memoryTokenCache(), async (ctx) => {
    const reply = await requestJson(ctx, ID, `${BASE}/security/v1/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${ctx.env.UPS_CLIENT_ID}:${ctx.env.UPS_CLIENT_SECRET}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    const body = obj(reply.body);
    return { accessToken: str(body.access_token), expiresInSec: Number(body.expires_in) };
  });

  return {
    id: ID,
    supports: (carrier) => carrier === "ups",
    isConfigured: (env: CarrierEnv) => Boolean(env.UPS_CLIENT_ID && env.UPS_CLIENT_SECRET),
    async track(number: string, _carrier, ctx: TrackContext) {
      const query = "locale=en_US&returnSignature=false&returnMilestones=false&returnPOD=false";
      const url = `${BASE}/api/track/v1/details/${encodeURIComponent(number)}?${query}`;
      const reply = await tokens.withToken(ctx, `${ID}:${ctx.env.UPS_CLIENT_ID}`, (token) =>
        requestJson(ctx, ID, url, {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            transId: crypto.randomUUID(),
            transactionSrc: "porchlight",
            accept: "application/json",
          },
        }),
      );
      return parse(reply.body);
    },
  };
}

export const upsAdapter = createUpsAdapter();
