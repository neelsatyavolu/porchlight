import type { Env } from "../env.js";
import { sendWake, type ApnsDeps } from "../lib/apns.js";

// Some packages only a signed-in device can read: Amazon retail orders
// (track.amazon.com answers TRACKING_ID_NOT_FOUND for them; the app reads Your
// Orders) and USPS/UPS/FedEx pages the server handed to a device. iOS runs the
// app in the background only now and then, so the server wakes the iPhones of
// people waiting on such packages with a silent push; the app reads, posts what
// changed, and the usual alert push goes out (docs/API.md "Background checks").

const MIN = 60_000;
/** Out for delivery, due within the day, or a device read the server is waiting on. */
export const WAKE_HOT_MS = 20 * MIN;
/** Anything else still on its way. */
export const WAKE_WARM_MS = 60 * MIN;
/** A package nothing has touched in this long no longer wakes anyone. */
export const WAKE_STALE_MS = 14 * 24 * 60 * MIN;
/** "Due within the day": an ETA that starts before this much from now. */
const SOON_MS = 18 * 60 * MIN;
/** Cron runs drift by seconds; don't skip a wake for that. */
const SLACK_MS = MIN;
/** Most users woken per cron run. */
const WAKE_LIMIT = 200;

interface WakeRow {
  user_id: string;
  hot: number;
  wake_sent_at: number | null;
}

/** Sends due wake pushes. Returns how many users were woken. */
export async function wakeDevices(env: Env, nowMs: number, deps?: ApnsDeps): Promise<number> {
  if (!env.APNS_TEAM_ID || !env.APNS_KEY_ID || !env.APNS_PRIVATE_KEY || !env.APNS_TOPIC) return 0;
  const { results } = await env.DB.prepare(
    `SELECT p.user_id,
            MAX(CASE WHEN p.status = 'out_for_delivery' OR p.device_needed_at IS NOT NULL
                       OR (p.eta_start IS NOT NULL AND p.eta_start <= ?2) THEN 1 ELSE 0 END) AS hot,
            u.wake_sent_at
     FROM packages p JOIN users u ON u.id = p.user_id
     WHERE p.deleted_at IS NULL AND p.archived_at IS NULL
       AND p.status NOT IN ('delivered', 'returned')
       AND p.updated_at >= ?3
       AND (p.source = 'amazon' OR p.carrier = 'amazon' OR p.device_needed_at IS NOT NULL)
     GROUP BY p.user_id
     LIMIT ?4`,
  )
    .bind(nowMs, nowMs + SOON_MS, nowMs - WAKE_STALE_MS, WAKE_LIMIT)
    .all<WakeRow>();

  let woken = 0;
  for (const row of results) {
    const every = row.hot ? WAKE_HOT_MS : WAKE_WARM_MS;
    if (row.wake_sent_at !== null && nowMs - row.wake_sent_at < every - SLACK_MS) continue;
    await env.DB.prepare("UPDATE users SET wake_sent_at = ? WHERE id = ?").bind(nowMs, row.user_id).run();
    if ((await sendWake(env, row.user_id, deps)) > 0) woken += 1;
  }
  return woken;
}
