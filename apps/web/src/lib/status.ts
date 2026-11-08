// Display rules for package status (DESIGN.md §5 "Status").
import type { Status } from "@porchlight/carriers";

/** Which color a status gets. Only delivered, exception and out-for-delivery are colored. */
export type StatusTone = "out" | "delivered" | "exception" | "neutral";

const LABELS: Record<Status, string> = {
  label_created: "Label created",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  available_for_pickup: "Ready for pickup",
  delivered: "Delivered",
  exception: "Problem",
  returned: "Returned to sender",
  unknown: "No update yet",
};

const TONES: Record<Status, StatusTone> = {
  label_created: "neutral",
  in_transit: "neutral",
  out_for_delivery: "out",
  available_for_pickup: "out",
  delivered: "delivered",
  exception: "exception",
  returned: "exception",
  unknown: "neutral",
};

export function statusLabel(status: Status): string {
  return LABELS[status];
}

export function statusTone(status: Status): StatusTone {
  return TONES[status];
}

/** Statuses whose dot is hollow: nothing has moved yet. */
export function isPending(status: Status): boolean {
  return status === "label_created" || status === "unknown";
}
