import type { CarrierEnv, Status, TrackContext, TrackEvent, TrackResult } from "../types.js";
import { CarrierError } from "../types.js";
import { requestJson } from "./shared/http.js";
import { arr, obj, str, strOrNull } from "./shared/json.js";
import { finishResult, place } from "./shared/result.js";
import type { RegisteredAdapter } from "./shared/types.js";

// DHL Shipment Tracking – Unified API. See docs/research/carrier-apis.md §4.
// Terms: show "Delivered by Deutsche Post DHL Group" and purge data 30 days after delivery.
const ID = "dhl";
const URL_BASE = "https://api-eu.dhl.com/track/shipments";

const OUT_FOR_DELIVERY = /out for delivery|out with courier|with delivery courier|being delivered/;
const PICKUP = /ready for pick-?\s?up|available for pick-?\s?up|ready for collection|awaiting collection/;

export interface DhlStatus {
  statusCode?: string;
  status?: string;
  description?: string;
  remark?: string;
}

/**
 * Maps DHL's `statusCode` enum, refined by the per-service `status` code and
 * text where the enum has no value (out for delivery, ready for pickup).
 * Unknown enum values become `unknown`, as DHL advises.
 */
export function mapDhlEvent(event: DhlStatus): Status {
  const text = `${str(event.description)} ${str(event.remark)}`.toLowerCase();
  switch (str(event.statusCode).toLowerCase()) {
    case "pre-transit":
      return "label_created";
    case "transit":
      if (str(event.status).toUpperCase() === "PO" || OUT_FOR_DELIVERY.test(text)) return "out_for_delivery";
      if (PICKUP.test(text)) return "available_for_pickup";
      return "in_transit";
    case "delivered":
      return "delivered";
    case "failure":
      return /return/.test(text) ? "returned" : "exception";
    default:
      return "unknown";
  }
}

function toEvent(raw: unknown): TrackEvent {
  const e = obj(raw);
  const address = obj(obj(e.location).address);
  return {
    occurredAt: str(e.timestamp),
    status: mapDhlEvent(e as DhlStatus),
    description: str(e.description) || str(e.remark) || str(e.status),
    location: place(address.addressLocality, address.countryCode),
  };
}

function parse(body: unknown): TrackResult {
  const shipment = arr(obj(body).shipments)[0];
  if (shipment === undefined) throw new CarrierError("not_found", ID, "dhl: no shipment in response");
  const s = obj(shipment);
  const latest = obj(s.status);
  const frame = obj(s.estimatedDeliveryTimeFrame);
  const point = strOrNull(s.estimatedTimeOfDelivery);
  const hasFrame = Boolean(str(frame.estimatedFrom) || str(frame.estimatedThrough));
  return finishResult({
    status: s.returnFlag === true ? "returned" : mapDhlEvent(latest as DhlStatus),
    statusDetail: str(latest.description) || str(latest.remark),
    etaStart: hasFrame ? strOrNull(frame.estimatedFrom) : point,
    etaEnd: hasFrame ? strOrNull(frame.estimatedThrough) : point,
    deliveredAt: null,
    events: arr(s.events).map(toEvent),
  });
}

export function createDhlAdapter(): RegisteredAdapter {
  return {
    id: ID,
    supports: (carrier) => carrier === "dhl" || carrier === "dhl_ecommerce",
    isConfigured: (env: CarrierEnv) => Boolean(env.DHL_API_KEY),
    async track(number: string, _carrier, ctx: TrackContext) {
      const url = `${URL_BASE}?${new URLSearchParams({ trackingNumber: number })}`;
      const reply = await requestJson(ctx, ID, url, {
        method: "GET",
        headers: { "DHL-API-Key": ctx.env.DHL_API_KEY ?? "", accept: "application/json" },
      });
      return parse(reply.body);
    },
  };
}

export const dhlAdapter = createDhlAdapter();
