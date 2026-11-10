import type { CarrierEnv, CarrierId, Status, TrackContext, TrackEvent, TrackResult } from "../types.js";
import { CarrierError } from "../types.js";
import { errorMessage, requestJson, type HttpReply } from "./shared/http.js";
import { arr, obj, str, strOrNull, type Json } from "./shared/json.js";
import { finishResult } from "./shared/result.js";
import type { RegisteredAdapter } from "./shared/types.js";

// Ship24 Tracking API, the aggregator chosen in docs/research/aggregators.md §6.
const ID = "aggregator";
const URL_TRACK = "https://api.ship24.com/public/v1/trackers/track";

const MILESTONES: Record<string, Status> = {
  pending: "unknown",
  info_received: "label_created",
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  available_for_pickup: "available_for_pickup",
  delivered: "delivered",
  // SPEC has no "attempted" status; a failed attempt needs attention, so amber.
  failed_attempt: "exception",
  exception: "exception",
};

/** Maps `statusMilestone`, using `statusCode` to tell returns apart from other exceptions. */
export function mapShip24Milestone(milestone: string | null, statusCode: string | null): Status {
  const status = MILESTONES[str(milestone)] ?? "unknown";
  if (status === "exception" && str(statusCode).startsWith("exception_return")) return "returned";
  return status;
}

function toEvent(e: Json): TrackEvent {
  return {
    occurredAt: str(e.occurrenceDatetime),
    status: mapShip24Milestone(str(e.statusMilestone), str(e.statusCode)),
    description: str(e.status),
    location: strOrNull(e.location),
  };
}

/** Ship24 writes a day-only estimate as midnight UTC ("2026-11-17T00:00:00.000Z"): read it as that date. */
function etaValue(value: unknown): string | null {
  const v = strOrNull(value);
  const midnight = v === null ? null : /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|[+-]00:?00)$/.exec(v);
  return midnight ? midnight[1]! : v;
}

/** Newest first by Ship24's `order`; events without one keep their position at the end. */
function sortEvents(events: Json[]): Json[] {
  const rank = (e: Json) => (typeof e.order === "number" ? e.order : -Infinity);
  return [...events].sort((a, b) => rank(b) - rank(a));
}

/** Ship24 reports an exhausted plan quota as a 4xx with a quota code: retry later, not a key problem. */
function classify(reply: HttpReply): CarrierError | undefined {
  const code = str(obj(arr(obj(reply.body).errors)[0]).code);
  if (/quota/.test(code)) return new CarrierError("rate_limited", ID, `ship24 quota reached: ${errorMessage(reply.body)}`);
  return undefined;
}

function parse(body: unknown): TrackResult {
  const tracking = arr(obj(obj(body).data).trackings)[0];
  if (tracking === undefined) throw new CarrierError("not_found", ID, "ship24: no tracking in response");
  const t = obj(tracking);
  const shipment = obj(t.shipment);
  const events = sortEvents(arr(t.events).map(obj)).map(toEvent);
  // Only the courier's own estimate; Ship24's estimatedDeliveryDate may be its own guess (SPEC goal 4).
  const courierEta = obj(obj(shipment.delivery).courierEstimatedDeliveryDate);
  return finishResult({
    status: mapShip24Milestone(str(shipment.statusMilestone), str(shipment.statusCode)),
    statusDetail: events[0]?.description ?? "",
    etaStart: etaValue(courierEta.from),
    etaEnd: etaValue(courierEta.to),
    deliveredAt: strOrNull(obj(obj(t.statistics).timestamps).deliveredDatetime),
    events,
  });
}

/**
 * Ship24's courier codes (GET /public/v1/couriers). Its auto-detect left a
 * 12-digit FedEx number pending with no courier, so the carrier we detected is
 * passed along. `other` and DHL eCommerce stay on auto-detect.
 */
const COURIER_CODES: Partial<Record<CarrierId, string>> = {
  usps: "us-post",
  ups: "ups",
  fedex: "fedex",
  dhl: "dhl",
  ontrac: "ontrac",
  lasership: "lasership",
  uniuni: "uniuni",
  jitsu: "jitsu",
};

/**
 * Uses `POST /trackers/track` (create-or-get, then fetch now). The body is the
 * number and the carrier's courier code, both fixed per package, so it is
 * deterministic: any other field change creates a new, billed tracker.
 */
export function createShip24Adapter(): RegisteredAdapter {
  return {
    id: ID,
    source: "aggregator",
    // Amazon Logistics (TBA) is billed per number and usually not found; its status comes from the device's Amazon import.
    supports: (carrier) => carrier !== "amazon",
    isConfigured: (env: CarrierEnv) => Boolean(env.AGGREGATOR_API_KEY),
    async track(number: string, carrier, ctx: TrackContext) {
      const courier = COURIER_CODES[carrier];
      const reply = await requestJson(
        ctx,
        ID,
        URL_TRACK,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${ctx.env.AGGREGATOR_API_KEY ?? ""}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(courier ? { trackingNumber: number, courierCode: [courier] } : { trackingNumber: number }),
        },
        classify,
      );
      return parse(reply.body);
    },
  };
}

export const ship24Adapter = createShip24Adapter();
