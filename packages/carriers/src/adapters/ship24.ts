import type { CarrierEnv, Status, TrackContext, TrackEvent, TrackResult } from "../types.js";
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
    etaStart: strOrNull(courierEta.from),
    etaEnd: strOrNull(courierEta.to),
    deliveredAt: strOrNull(obj(obj(t.statistics).timestamps).deliveredDatetime),
    events,
  });
}

/**
 * Uses `POST /trackers/track` (create-or-get, then fetch now). The body holds only
 * the number so it is deterministic: any other field change creates a new, billed
 * tracker. Courier codes are left to Ship24's auto-detect until we have its list.
 */
export function createShip24Adapter(): RegisteredAdapter {
  return {
    id: ID,
    source: "aggregator",
    // Amazon Logistics (TBA) is billed per number and usually not found; its status comes from the device's Amazon import.
    supports: (carrier) => carrier !== "amazon",
    isConfigured: (env: CarrierEnv) => Boolean(env.AGGREGATOR_API_KEY),
    async track(number: string, _carrier, ctx: TrackContext) {
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
          body: JSON.stringify({ trackingNumber: number }),
        },
        classify,
      );
      return parse(reply.body);
    },
  };
}

export const ship24Adapter = createShip24Adapter();
