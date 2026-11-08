import type { CarrierId } from "@porchlight/carriers";
import { carrierName } from "../lib/carriers";
import "./CarrierBadge.css";

export interface CarrierBadgeProps {
  carrier: CarrierId;
}

/** The carrier's name as quiet text in a hairline chip. No logos, no carrier colors. */
export function CarrierBadge({ carrier }: CarrierBadgeProps) {
  return <span className="carrier-badge">{carrierName(carrier)}</span>;
}
