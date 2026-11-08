// D1 access shared by the poller and the import routes: load a package,
// store carrier events (deduped by raw_hash), and apply a tracking update.
import { STATUSES, type Status, type TrackEvent } from "@porchlight/carriers";
import { sha256Hex } from "../lib/auth.js";
import { etaToMs } from "../lib/eta.js";
import { NEXT_UPDATED_AT } from "../routes/packages.js";
import { nextCheckAt } from "./interval.js";

export interface PackageRow {
  id: string;
  user_id: string;
  carrier: string;
  tracking_number: string;
  title: string | null;
  merchant: string | null;
  order_id: string | null;
  source: string;
  status: Status;
  status_detail: string | null;
  eta_start: number | null;
  eta_end: number | null;
  /** 1: eta_start/eta_end are calendar dates at 00:00 UTC (lib/eta.ts). */
  eta_date_only: number;
  delivered_at: number | null;
  last_checked_at: number | null;
  next_check_at: number | null;
  archived_at: number | null;
  deleted_at: number | null;
  updated_at: number;
}

export function isoToMs(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export async function loadPackage(db: D1Database, id: string, userId: string): Promise<PackageRow | null> {
  return db.prepare("SELECT * FROM packages WHERE id = ? AND user_id = ?").bind(id, userId).first<PackageRow>();
}

/** Inserts events not already stored for the package. Returns how many were new. */
export async function insertEvents(db: D1Database, packageId: string, events: readonly TrackEvent[]): Promise<number> {
  const stmts: D1PreparedStatement[] = [];
  for (const e of events) {
    const occurredAt = isoToMs(e.occurredAt);
    if (occurredAt === null) continue;
    const status: Status = STATUSES.includes(e.status) ? e.status : "unknown";
    const location = e.location ?? null;
    const rawHash = await sha256Hex(`${occurredAt}|${status}|${e.description}|${location ?? ""}`);
    stmts.push(
      db
        .prepare(
          `INSERT INTO events (id, package_id, occurred_at, status, description, location, raw_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (package_id, raw_hash) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), packageId, occurredAt, status, e.description, location, rawHash),
    );
  }
  if (stmts.length === 0) return 0;
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

export interface TrackingUpdate {
  status: Status;
  statusDetail: string | null;
  /** undefined, or both null, keeps the stored ETA (only what a source said). */
  etaStart?: string | null;
  etaEnd?: string | null;
  /** Applies with a new ETA: true when etaStart/etaEnd are "YYYY-MM-DD" dates. */
  etaDateOnly?: boolean;
  deliveredAt: string | null;
  events: readonly TrackEvent[];
  /** Becomes last_checked_at. */
  checkedAtMs: number;
}

export interface ApplyOutcome {
  /** Something a client shows changed (fields or new events); updated_at moved. */
  changed: boolean;
  statusChanged: boolean;
  nextCheckAt: number | null;
}

async function lastEventAt(db: D1Database, packageId: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT MAX(occurred_at) AS t FROM events WHERE package_id = ?")
    .bind(packageId)
    .first<{ t: number | null }>();
  return row?.t ?? null;
}

/** Writes a tracking update to the package and schedules its next check. */
export async function applyTracking(db: D1Database, pkg: PackageRow, u: TrackingUpdate, nowMs: number): Promise<ApplyOutcome> {
  const inserted = await insertEvents(db, pkg.id, u.events);
  const delivered = u.status === "delivered";
  const hasEta = u.etaStart != null || u.etaEnd != null;
  // A delivered package has no ETA; a stored one would outlive the delivery.
  const newDateOnly = u.etaDateOnly === true;
  const etaStart = delivered ? null : hasEta ? etaToMs(u.etaStart, newDateOnly) : pkg.eta_start;
  const etaEnd = delivered ? null : hasEta ? etaToMs(u.etaEnd, newDateOnly) : pkg.eta_end;
  const etaDateOnly = etaStart === null && etaEnd === null ? 0 : hasEta ? Number(newDateOnly) : pkg.eta_date_only;
  const deliveredAt = delivered ? (isoToMs(u.deliveredAt) ?? pkg.delivered_at) : null;

  const statusChanged = u.status !== pkg.status;
  const changed =
    inserted > 0 ||
    statusChanged ||
    u.statusDetail !== pkg.status_detail ||
    etaStart !== pkg.eta_start ||
    etaEnd !== pkg.eta_end ||
    etaDateOnly !== pkg.eta_date_only ||
    deliveredAt !== pkg.delivered_at;

  const movement = statusChanged ? nowMs : ((await lastEventAt(db, pkg.id)) ?? pkg.updated_at);
  const next = nextCheckAt(u.status, nowMs, movement);
  // updated_at moves only on a visible change, via NEXT_UPDATED_AT (?1 = now, ?2 = user id).
  await db
    .prepare(
      `UPDATE packages SET status = ?3, status_detail = ?4, eta_start = ?5, eta_end = ?6, delivered_at = ?7,
         last_checked_at = ?8, next_check_at = ?9, eta_date_only = ?12,
         updated_at = CASE WHEN ?10 THEN ${NEXT_UPDATED_AT} ELSE updated_at END
       WHERE id = ?11 AND user_id = ?2`,
    )
    .bind(nowMs, pkg.user_id, u.status, u.statusDetail, etaStart, etaEnd, deliveredAt, u.checkedAtMs, next, changed ? 1 : 0, pkg.id, etaDateOnly)
    .run();
  return { changed, statusChanged, nextCheckAt: next };
}
