// DHL API terms: the events of a package read through the DHL API are deleted
// DHL_RETENTION_DAYS after delivery. The package row stays. updated_at moves
// so the next sync sends the package with no events and clients drop theirs
// (sync replaces a package's events wholesale).
import { DHL_RETENTION_DAYS } from "@porchlight/carriers";
import type { Env } from "../env.js";
import { NEXT_UPDATED_AT } from "../routes/packages.js";

/** Most packages purged per cron run; the rest wait for the next run. */
export const PURGE_BATCH_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

interface PurgeRow {
  id: string;
  user_id: string;
}

/** Deletes the events of DHL-API packages delivered over DHL_RETENTION_DAYS ago. Returns how many packages. */
export async function purgeDhlEvents(env: Env, nowMs: number, limit = PURGE_BATCH_LIMIT): Promise<number> {
  const cutoff = nowMs - DHL_RETENTION_DAYS * DAY_MS;
  const { results } = await env.DB.prepare(
    `SELECT id, user_id FROM packages
     WHERE carrier IN ('dhl', 'dhl_ecommerce') AND last_source = 'api' AND delivered_at IS NOT NULL AND events_purged_at IS NULL
       AND delivered_at <= ?
     ORDER BY delivered_at, id
     LIMIT ?`,
  )
    .bind(cutoff, limit)
    .all<PurgeRow>();

  for (const row of results) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM events WHERE package_id = ?").bind(row.id),
      env.DB.prepare(
        `UPDATE packages SET events_purged_at = ?1, updated_at = ${NEXT_UPDATED_AT} WHERE id = ?3 AND user_id = ?2`,
      ).bind(nowMs, row.user_id, row.id),
    ]);
  }
  return results.length;
}
