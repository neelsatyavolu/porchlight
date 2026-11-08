import type { CarrierEnv, Status, TrackContext, TrackEvent, TrackResult } from "../types.js";
import { CarrierError } from "../types.js";
import { requestJson } from "./shared/http.js";
import { arr, obj, str, strOrNull, type Json } from "./shared/json.js";
import { memoryTokenCache, OAuthTokens, type TokenCache } from "./shared/oauth.js";
import { finishResult, place } from "./shared/result.js";
import type { RegisteredAdapter } from "./shared/types.js";

// USPS Tracking API 3.2. See docs/research/carrier-apis.md §1.
const ID = "usps";
const BASE = "https://apis.usps.com";

const CATEGORY: Record<string, Status> = {
  "usps awaiting item": "label_created",
  "pre-shipment": "label_created",
  accepted: "in_transit",
  "on the way": "in_transit",
  "in transit": "in_transit",
  "moving through network": "in_transit",
  "in transit from origin processing": "in_transit",
  "processing at destination": "in_transit",
  "preparing for delivery": "in_transit",
  "international transit": "in_transit",
  "out for delivery": "out_for_delivery",
  "available for pickup": "available_for_pickup",
  "available for agent pickup": "available_for_pickup",
  delivered: "delivered",
  "delivered to agent": "delivered",
  alert: "exception",
  "delivery attempt": "exception",
  "delivery attempt: action needed": "exception",
  "returned to sender": "returned",
  "returned to shipper": "returned",
};

const EVENT_CODE: Record<string, Status> = {
  GX: "label_created", MA: "label_created",
  "03": "in_transit", OA: "in_transit", "07": "in_transit", "10": "in_transit",
  NT: "in_transit", TL: "in_transit", T1: "in_transit", ME: "in_transit",
  OF: "out_for_delivery",
  "14": "available_for_pickup", "16": "available_for_pickup",
  "01": "delivered", OK: "delivered",
  "02": "exception", NH: "exception", "04": "exception", "05": "exception",
  "21": "exception", "22": "exception", "55": "exception", "56": "exception", OH: "exception",
  "09": "returned", H8: "returned",
};

/** Maps a `statusCategory` (PTR2 or legacy wording); null when unrecognized. */
export function mapUspsCategory(category: string): Status | null {
  return CATEGORY[category.trim().toLowerCase()] ?? null;
}

/** Maps a two-character `eventCode`; null when unrecognized. */
export function mapUspsEventCode(code: string): Status | null {
  return EVENT_CODE[code.trim().toUpperCase()] ?? null;
}

function toEvent(raw: unknown): TrackEvent {
  const e = obj(raw);
  const description = str(e.eventType);
  return {
    occurredAt: str(e.eventTimestamp) || str(e.GMTTimestamp),
    status: mapUspsEventCode(str(e.eventCode)) ?? mapUspsCategory(description) ?? "unknown",
    description,
    location: place(e.eventCity, e.eventState, e.eventCountry),
  };
}

/** The response is one item or a batch array; per-item errors arrive inside a 200/207. */
function pickItem(body: unknown, number: string): Json {
  const items = Array.isArray(body) ? body.map(obj) : [obj(body)];
  const item = items.find((i) => str(i.trackingNumber) === number) ?? items[0] ?? {};
  if (item.error !== undefined || items.length === 0) {
    const message = str(obj(item.error).message) || "tracking number not found";
    throw new CarrierError("not_found", ID, `usps: ${message}`);
  }
  return item;
}

function parse(body: unknown, number: string): TrackResult {
  const item = pickItem(body, number);
  const events = arr(item.trackingEvents).map(toEvent);
  const eta = strOrNull(obj(item.deliveryDateExpectation).expectedDeliveryDate);
  return finishResult({
    status: mapUspsCategory(str(item.statusCategory)) ?? events[0]?.status ?? "unknown",
    statusDetail: str(item.status) || (events[0]?.description ?? ""),
    etaStart: eta,
    etaEnd: eta,
    deliveredAt: null,
    events,
  });
}

export function createUspsAdapter(options: { tokenCache?: TokenCache } = {}): RegisteredAdapter {
  const tokens = new OAuthTokens(ID, options.tokenCache ?? memoryTokenCache(), async (ctx) => {
    const reply = await requestJson(ctx, ID, `${BASE}/oauth2/v3/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: ctx.env.USPS_CLIENT_ID,
        client_secret: ctx.env.USPS_CLIENT_SECRET,
      }),
    });
    const body = obj(reply.body);
    return { accessToken: str(body.access_token), expiresInSec: Number(body.expires_in) };
  });

  return {
    id: ID,
    supports: (carrier) => carrier === "usps",
    isConfigured: (env: CarrierEnv) => Boolean(env.USPS_CLIENT_ID && env.USPS_CLIENT_SECRET),
    async track(number: string, _carrier, ctx: TrackContext) {
      const reply = await tokens.withToken(ctx, `${ID}:${ctx.env.USPS_CLIENT_ID}`, (token) =>
        requestJson(ctx, ID, `${BASE}/tracking/v3r2/tracking`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify([{ trackingNumber: number }]),
        }),
      );
      return parse(reply.body, number);
    },
  };
}

export const uspsAdapter = createUspsAdapter();
