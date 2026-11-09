// Where a package's status came from, and what to say when a device has to
// read it (docs/API.md "Data source" and "Device tracking"). Pure functions;
// the Swift copy is PorchKit/Presentation/SourceText.swift.
import { isDeviceCarrier, type CarrierId } from "@porchlight/carriers";
import type { Package } from "../api/types";
import { carrierName } from "../lib/carriers";
import { ago } from "./time";

/** A device carrier with no read for this long gets the "open the app" hint. */
export const DEVICE_STALE_MS = 3 * 60 * 60 * 1000;

const DEVICES = "your Mac or iPhone";

function pageOwner(carrier: CarrierId): string {
  return carrier === "other" ? "the carrier's" : `${carrierName(carrier)}'s`;
}

/** "From UPS's tracking page, checked on your Mac or iPhone 12 min ago." or null before any read. */
export function sourceLine(
  pkg: Pick<Package, "carrier" | "dataSource" | "lastCheckedAt">,
  now: Date,
): string | null {
  const when = pkg.lastCheckedAt ? ` ${ago(pkg.lastCheckedAt, now)}` : "";
  switch (pkg.dataSource) {
    case "device":
      return `From ${pageOwner(pkg.carrier)} tracking page, checked on ${DEVICES}${when}.`;
    case "web":
      return `From ${pageOwner(pkg.carrier)} tracking page, checked by Porchlight${when}.`;
    case "api":
      return `From ${pageOwner(pkg.carrier)} tracking API, checked${when}.`;
    case "aggregator":
      return `From Ship24, checked${when}.`;
    case "amazon":
      return `From your Amazon orders, checked on ${DEVICES}${when}.`;
    default:
      return null;
  }
}

/** True when the next read of this package belongs to a native app, not the server. */
export function readsOnDevice(pkg: Pick<Package, "carrier" | "dataSource">): boolean {
  if (pkg.carrier === "ups") return pkg.dataSource === "device";
  return isDeviceCarrier(pkg.carrier);
}

/** Shown for a live USPS, UPS or FedEx package that no device has read lately. */
export function deviceHint(
  pkg: Pick<Package, "carrier" | "status" | "archivedAt" | "lastCheckedAt">,
  now: Date,
): string | null {
  if (!isDeviceCarrier(pkg.carrier) || pkg.status === "delivered" || pkg.archivedAt !== null) return null;
  const fresh = pkg.lastCheckedAt !== null && now.getTime() - Date.parse(pkg.lastCheckedAt) < DEVICE_STALE_MS;
  return fresh ? null : `Open Porchlight on your Mac or iPhone to update ${carrierName(pkg.carrier)} packages.`;
}

/** The note after a refresh was queued. */
export function refreshText(pkg: Pick<Package, "carrier" | "dataSource">): string {
  const carrier = carrierName(pkg.carrier);
  return readsOnDevice(pkg)
    ? `Asked ${DEVICES} to check ${carrier}. The update shows up here once Porchlight is open on one of them.`
    : `Asked ${carrier} for an update. New scans show up here within a minute or two.`;
}

/** The empty timeline's message. */
export function noScansText(pkg: Pick<Package, "carrier" | "dataSource">): string {
  const carrier = carrierName(pkg.carrier);
  return readsOnDevice(pkg)
    ? `${carrier} hasn't reported this number yet. Your Mac or iPhone checks it while Porchlight is open.`
    : `${carrier} hasn't reported this number. Porchlight checks again within the hour.`;
}
