import type { Env } from "../env.js";
import type { TrackJob } from "./types.js";

/** Most packages queued per cron run. */
export const SCHEDULE_BATCH_LIMIT = 500;
/** Queue.sendBatch takes at most 100 messages. */
const SEND_CHUNK = 100;
/**
 * After queueing, next_check_at moves this far ahead so the next cron run
 * does not queue the package again; the consumer sets the real value.
 */
export const LEASE_MS = 15 * 60_000;

interface DueRow {
  id: string;
  user_id: string;
}

/** Queues a TrackJob for each due package. Returns how many were queued. */
export async function enqueueDue(env: Env, nowMs: number, limit = SCHEDULE_BATCH_LIMIT): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id FROM packages
     WHERE next_check_at IS NOT NULL AND next_check_at <= ?
       AND deleted_at IS NULL AND archived_at IS NULL AND status != 'delivered'
     ORDER BY next_check_at, id
     LIMIT ?`,
  )
    .bind(nowMs, limit)
    .all<DueRow>();

  for (let i = 0; i < results.length; i += SEND_CHUNK) {
    const chunk = results.slice(i, i + SEND_CHUNK);
    const messages = chunk.map((row) => ({
      body: { packageId: row.id, userId: row.user_id, reason: "scheduled", enqueuedAt: nowMs } satisfies TrackJob,
    }));
    await env.TRACK_QUEUE.sendBatch(messages);
    await env.DB.batch(
      chunk.map((row) => env.DB.prepare("UPDATE packages SET next_check_at = ? WHERE id = ?").bind(nowMs + LEASE_MS, row.id)),
    );
  }
  return results.length;
}

/**
 * Cron (every 5 min): queue a TrackJob for each package whose next_check_at
 * has passed (SPEC §5 Polling).
 */
export async function schedule(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const queued = await enqueueDue(env, controller.scheduledTime);
  if (queued > 0) console.info("poll: queued", queued);
}
