import type { Package } from "../../api/types";
import { CarrierBadge, Row, StatusDot } from "../../components";
import { etaPhrase } from "../../packages/arrival";
import { rowTitle, statusLine } from "../../packages/format";
import { ago, fullDateTime } from "../../packages/time";

export interface PackageRowProps {
  pkg: Package;
  now: Date;
  timeZone: string;
}

/** One package in the list (DESIGN.md §6 "Package row"). */
export function PackageRow({ pkg, now, timeZone }: PackageRowProps) {
  const eta = etaPhrase(pkg, now, timeZone);
  const checked = pkg.lastCheckedAt;
  return (
    <Row
      to={`/app/p/${pkg.id}`}
      leading={<StatusDot status={pkg.status} />}
      title={rowTitle(pkg)}
      trailing={<span className={eta.muted ? "list__eta list__eta--muted" : "list__eta"}>{eta.text}</span>}
      meta={statusLine(pkg)}
      trailingMeta={
        <span className="list__row-end">
          <span className="list__checked num" title={checked ? fullDateTime(checked, timeZone) : undefined}>
            {checked ? `Checked ${ago(checked, now)}` : "Not checked yet"}
          </span>
          <CarrierBadge carrier={pkg.carrier} />
        </span>
      }
    />
  );
}
