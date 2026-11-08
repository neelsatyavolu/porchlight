// Carrier display names (DESIGN.md §5 "Carrier badge").
import type { CarrierId } from "@porchlight/carriers";

const NAMES: Record<CarrierId, string> = {
  usps: "USPS",
  ups: "UPS",
  fedex: "FedEx",
  dhl: "DHL",
  dhl_ecommerce: "DHL eCommerce",
  amazon: "Amazon",
  ontrac: "OnTrac",
  lasership: "LaserShip",
  uniuni: "UniUni",
  jitsu: "Jitsu",
  other: "Other carrier",
};

export function carrierName(carrier: CarrierId): string {
  return NAMES[carrier];
}
