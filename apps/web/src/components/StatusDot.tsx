import type { Status } from "@porchlight/carriers";
import { isPending, statusLabel, statusTone } from "../lib/status";
import "./StatusDot.css";

export interface StatusDotProps {
  status: Status;
  /** Show the status label next to the dot. Without it the dot carries an accessible name. */
  withLabel?: boolean;
}

export function StatusDot({ status, withLabel = false }: StatusDotProps) {
  const tone = statusTone(status);
  const label = statusLabel(status);
  const dot = (
    <span
      className={`status-dot status-dot--${tone}${isPending(status) ? " status-dot--hollow" : ""}`}
      data-tone={tone}
      role={withLabel ? undefined : "img"}
      aria-label={withLabel ? undefined : label}
      aria-hidden={withLabel ? true : undefined}
    />
  );
  if (!withLabel) return dot;
  return (
    <span className="status">
      {dot}
      <span className="status__label">{label}</span>
    </span>
  );
}
