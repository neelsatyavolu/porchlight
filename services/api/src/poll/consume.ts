import { CarrierError, resolveAdapters, type CarrierAdapter, type CarrierId, type TrackResult } from "@porchlight/carriers";
import type { Env } from "../env.js";
import { notifyPackageChange, type PackageChange } from "../lib/apns.js";
import { takeToken, type BucketSpec, type RateDecision } from "../lib/rate.js";
import { nextCheckAt, noAdapterRetryAt } from "./interval.js";
import { applyTracking, loadPackage, type PackageRow } from "./store.js";
import type { TrackJob } from "./types.js";

/** Queue deliveries per message before the poller gives up until the next scheduled check. */
export const MAX_ATTEMPTS = 3;
/** Per-adapter KV token bucket ("carrier:<adapter id>"). Approximate, as KV is. */
export const CARRIER_BUCKET: BucketSpec = { capacity: 10, refillPerSec: 1 };
const BASE_RETRY_SEC = 60;
const MAX_RETRY_SEC = 15 * 60;
const MIN_BUCKET_WAIT_MS = 60_000;

export interface ConsumeDeps {
  adaptersFor(carrier: CarrierId, env: Env): readonly CarrierAdapter[];
  takeToken(env: Env, key: string, spec: BucketSpec, nowMs: number): Promise<RateDecision>;
  fetch: typeof fetch;
  now(): number;
  notify(env: Env, change: PackageChange): Promise<unknown>;
}

export const defaultDeps: ConsumeDeps = {
  adaptersFor: (carrier, env) => resolveAdapters(carrier, env),
  takeToken,
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  notify: (env, change) => notifyPackageChange(env, change),
};

export type JobOutcome = { kind: "done" } | { kind: "retry"; delaySec: number };

type TrackAttempt =
  | { kind: "result"; result: TrackResult }
  | { kind: "bucket_empty"; retryAfterSec: number }
  | { kind: "retry"; retryAfterSec: number | null }
  | { kind: "no_data"; checked: boolean };

/** Tries adapters in order; falls through to the next only on a non-retryable error. */
async function track(pkg: PackageRow, env: Env, deps: ConsumeDeps): Promise<TrackAttempt> {
  const carrier = pkg.carrier as CarrierId;
  const ctx = { fetch: deps.fetch, env, now: () => new Date(deps.now()) };
  let checked = false;
  for (const adapter of deps.adaptersFor(carrier, env)) {
    const bucket = await deps.takeToken(env, `carrier:${adapter.id}`, CARRIER_BUCKET, deps.now());
    if (!bucket.allowed) return { kind: "bucket_empty", retryAfterSec: bucket.retryAfterSec };
    try {
      return { kind: "result", result: await adapter.track(pkg.tracking_number, carrier, ctx) };
    } catch (err) {
      if (!(err instanceof CarrierError)) {
        console.warn("poll: adapter threw", adapter.id, err);
        return { kind: "retry", retryAfterSec: null };
      }
      if (err.retryable) return { kind: "retry", retryAfterSec: err.retryAfterSec };
      console.warn("poll: adapter failed", adapter.id, err.kind, err.message);
      if (err.kind === "not_found") checked = true;
    }
  }
  return { kind: "no_data", checked };
}

async function setNextCheck(db: D1Database, pkg: PackageRow, next: number | null, lastCheckedAt: number | null): Promise<void> {
  await db
    .prepare("UPDATE packages SET next_check_at = ?, last_checked_at = ? WHERE id = ? AND user_id = ?")
    .bind(next, lastCheckedAt, pkg.id, pkg.user_id)
    .run();
}

/** The package to track, or null when the job no longer applies. */
async function target(job: TrackJob, env: Env): Promise<PackageRow | null> {
  const pkg = await loadPackage(env.DB, job.packageId, job.userId);
  if (!pkg || pkg.deleted_at !== null) return null;
  const finished = pkg.archived_at !== null || pkg.status === "delivered";
  return job.reason === "scheduled" && finished ? null : pkg;
}

/** Reschedules after the last failed delivery so the cron picks the package up again. */
export async function giveUpForNow(job: TrackJob, env: Env, deps: ConsumeDeps): Promise<void> {
  const pkg = await target(job, env);
  if (!pkg) return;
  const now = deps.now();
  await setNextCheck(env.DB, pkg, nextCheckAt(pkg.status, now, pkg.updated_at), pkg.last_checked_at);
}

/** Tracks one package and stores what the carrier said. */
export async function processJob(job: TrackJob, env: Env, deps: ConsumeDeps, attempts = 1): Promise<JobOutcome> {
  const pkg = await target(job, env);
  if (!pkg) return { kind: "done" };
  const now = deps.now();
  const attempt = await track(pkg, env, deps);

  switch (attempt.kind) {
    case "retry": {
      const backoff = Math.min(BASE_RETRY_SEC * 2 ** (attempts - 1), MAX_RETRY_SEC);
      return { kind: "retry", delaySec: attempt.retryAfterSec ?? backoff };
    }
    case "bucket_empty":
      await setNextCheck(env.DB, pkg, now + Math.max(attempt.retryAfterSec * 1000, MIN_BUCKET_WAIT_MS), pkg.last_checked_at);
      return { kind: "done" };
    case "no_data": {
      const next = attempt.checked ? nextCheckAt(pkg.status, now, pkg.updated_at) : noAdapterRetryAt(now, pkg.updated_at);
      await setNextCheck(env.DB, pkg, next, attempt.checked ? now : pkg.last_checked_at);
      return { kind: "done" };
    }
    case "result": {
      const r = attempt.result;
      const outcome = await applyTracking(env.DB, pkg, { ...r, checkedAtMs: now }, now);
      if (outcome.changed) {
        const change = {
          userId: pkg.user_id,
          packageId: pkg.id,
          title: pkg.title,
          status: r.status,
          statusDetail: r.statusDetail,
          statusChanged: outcome.statusChanged,
        };
        await deps.notify(env, change).catch((err: unknown) => console.error("poll: push failed", pkg.id, err));
      }
      return { kind: "done" };
    }
  }
}

/** Handles a queue batch one message at a time (carrier rate limits favour serial calls). */
export async function consumeBatch(batch: MessageBatch<TrackJob>, env: Env, deps: ConsumeDeps): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const outcome = await processJob(msg.body, env, deps, msg.attempts);
      if (outcome.kind === "done") msg.ack();
      else if (msg.attempts < MAX_ATTEMPTS) msg.retry({ delaySeconds: outcome.delaySec });
      else {
        await giveUpForNow(msg.body, env, deps);
        msg.ack();
      }
    } catch (err) {
      console.error("poll: job failed", msg.body.packageId, err);
      msg.retry();
    }
  }
}

/**
 * Queue consumer: track each package through its adapters, store new events,
 * set next_check_at, and send push when the status changes.
 */
export async function consume(batch: MessageBatch<TrackJob>, env: Env, _ctx: ExecutionContext): Promise<void> {
  await consumeBatch(batch, env, defaultDeps);
}
