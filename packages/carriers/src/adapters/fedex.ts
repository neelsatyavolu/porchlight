import type { CarrierEnv, Status, TrackContext, TrackEvent, TrackResult } from "../types.js";
import { CarrierError } from "../types.js";
import { errorMessage, requestJson } from "./shared/http.js";
import { arr, obj, str, strOrNull, type Json } from "./shared/json.js";
import { memoryTokenCache, OAuthTokens, type TokenCache } from "./shared/oauth.js";
import { finishResult, place } from "./shared/result.js";
import type { RegisteredAdapter } from "./shared/types.js";

// FedEx Basic Integrated Visibility (Track API v1). See docs/research/carrier-apis.md §3.
const ID = "fedex";
const BASE = "https://apis.fedex.com";
/** FedEx answers OAuth over-use with 403 for 10 minutes. */
const TOKEN_PENALTY_SEC = 600;

const CODES: Record<string, Status> = {
  OC: "label_created", IN: "label_created",
  PU: "in_transit", DO: "in_transit", AR: "in_transit", DP: "in_transit", IT: "in_transit",
  AF: "in_transit", FD: "in_transit", PX: "in_transit", IX: "in_transit", CC: "in_transit",
  CP: "in_transit", AE: "in_transit", AO: "in_transit",
  OD: "out_for_delivery",
  HP: "available_for_pickup", HL: "available_for_pickup",
  DL: "delivered",
  DE: "exception", SE: "exception", DD: "exception", DY: "exception", CD: "exception", PD: "exception",
  RS: "returned",
};

/** Maps a derived status code. `CA` (cancelled) and unknown codes become `unknown`. */
export function mapFedexCode(code: string): Status {
  return CODES[code.trim().toUpperCase()] ?? "unknown";
}

function toEvent(raw: unknown): TrackEvent {
  const e = obj(raw);
  const loc = obj(e.scanLocation);
  return {
    occurredAt: str(e.date),
    status: mapFedexCode(str(e.derivedStatusCode) || str(e.eventType)),
    description: str(e.eventDescription) || str(e.derivedStatus),
    location: place(loc.city, loc.stateOrProvinceCode, loc.countryCode),
  };
}

function dateOf(track: Json, type: string): string | null {
  const entry = arr(track.dateAndTimes).map(obj).find((d) => str(d.type) === type);
  return strOrNull(entry?.dateTime);
}

/**
 * ESTIMATED_DELIVERY often carries only a date, written as local midnight
 * ("2026-11-05T00:00:00-08:00"). That midnight is not a delivery time, so it
 * becomes the bare date.
 */
function estimateOf(dateTime: string | null): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(dateTime ?? "");
  return m?.[1] ?? dateTime;
}

function parse(body: unknown): TrackResult {
  const complete = obj(arr(obj(obj(body).output).completeTrackResults)[0]);
  const track = obj(arr(complete.trackResults)[0]);
  const error = obj(track.error);
  if (str(error.code) || Object.keys(track).length === 0) {
    // NOTFOUND, invalid number, or Authenticated Delivery: this adapter can't give a status.
    throw new CarrierError("not_found", ID, `fedex: ${str(error.code) || "no track result"} ${str(error.message)}`.trim());
  }
  const latest = obj(track.latestStatusDetail);
  const window = obj(obj(track.estimatedDeliveryTimeWindow).window);
  const estimated = estimateOf(dateOf(track, "ESTIMATED_DELIVERY"));
  // standardTransitTimeWindow is a service standard, not a prediction: never used (SPEC goal 4).
  const hasWindow = Boolean(str(window.begins) || str(window.ends));
  return finishResult({
    status: mapFedexCode(str(latest.derivedCode) || str(latest.code)),
    statusDetail: str(latest.statusByLocale) || str(latest.description),
    etaStart: hasWindow ? strOrNull(window.begins) : estimated,
    etaEnd: hasWindow ? strOrNull(window.ends) : estimated,
    deliveredAt: dateOf(track, "ACTUAL_DELIVERY"),
    events: arr(track.scanEvents).map(toEvent),
  });
}

export function createFedexAdapter(options: { tokenCache?: TokenCache } = {}): RegisteredAdapter {
  const tokens = new OAuthTokens(ID, options.tokenCache ?? memoryTokenCache(), async (ctx) => {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: ctx.env.FEDEX_CLIENT_ID ?? "",
      client_secret: ctx.env.FEDEX_CLIENT_SECRET ?? "",
    });
    const reply = await requestJson(
      ctx,
      ID,
      `${BASE}/oauth/token`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() },
      (r) =>
        r.status === 403
          ? new CarrierError("rate_limited", ID, `fedex token refused (403): ${errorMessage(r.body)}`, {
              retryAfterSec: TOKEN_PENALTY_SEC,
            })
          : undefined,
    );
    const body = obj(reply.body);
    return { accessToken: str(body.access_token), expiresInSec: Number(body.expires_in) };
  });

  return {
    id: ID,
    source: "api",
    supports: (carrier) => carrier === "fedex",
    isConfigured: (env: CarrierEnv) => Boolean(env.FEDEX_CLIENT_ID && env.FEDEX_CLIENT_SECRET),
    async track(number: string, _carrier, ctx: TrackContext) {
      const reply = await tokens.withToken(ctx, `${ID}:${ctx.env.FEDEX_CLIENT_ID}`, (token) =>
        requestJson(ctx, ID, `${BASE}/track/v1/trackingnumbers`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-locale": "en_US",
          },
          body: JSON.stringify({
            includeDetailedScans: true,
            trackingInfo: [{ trackingNumberInfo: { trackingNumber: number } }],
          }),
        }),
      );
      return parse(reply.body);
    },
  };
}

export const fedexAdapter = createFedexAdapter();
