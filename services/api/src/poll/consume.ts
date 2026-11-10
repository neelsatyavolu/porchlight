import {
  CarrierError,
  isDeviceCarrier,
  resolveAdapters,
  type AdapterSource,
  type CarrierAdapter,
  type CarrierId,
  type TrackResult,
} from "@porchlight/carriers";
import type { Env } from "../env.js";
import { notifyPackageChange, type PackageChange } from "../lib/apns.js";
import { reserveAggregator } from "../lib/budget.js";
import { takeToken, type BucketSpec, type RateDecision } from "../lib/rate.js";
import type { DeviceJobReason } from "../types/api.js";
import { cadenceFor, checkBackoffMs, deviceCadence, nextCheckAt, noAdapterRetryAt } from "./interval.js";
import { applyTracking, loadPackage, type PackageRow } from "./store.js";
import type { TrackJob } from "./types.js";

/** Queue deliveries per message before the poller gives up until the next scheduled check. */
export const MAX_ATTEMPTS = 3;
/** Per-adapter KV token bucket ("carrier:<adapter id>"). Approximate, as KV is. */
export const CARRIER_BUCKET: BucketSpec = { capacity: 10, refillPerSec: 1 };
/**
 * Web adapters read carriers' public pages: about 20 requests per carrier an
 * hour from one IP (scraping.md "Polling limits"), with a burst of 5.
 */
export const WEB_BUCKET: BucketSpec = { capacity: 5, refillPerSec: 20 / 3600 };

/** The token bucket an adapter draws from. */
export function bucketFor(adapter: Pick<CarrierAdapter, "source">): BucketSpec {
  return adapter.source === "web" ? WEB_BUCKET : CARRIER_BUCKET;
}
/** Consecutive web/API misses (not_found or permanent failure) before the aggregator may be asked. */
export const AGGREGATOR_AFTER_MISSES = 2;
const BASE_RETRY_SEC = 60;
const MAX_RETRY_SEC = 15 * 60;
const MIN_BUCKET_WAIT_MS = 60_000;

export interface ConsumeDeps {
  adaptersFor(carrier: CarrierId, env: Env): readonly CarrierAdapter[];
  takeToken(env: Env, key: string, spec: BucketSpec, nowMs: number): Promise<RateDecision>;
  /** Spends one of the month's aggregator registrations; false when none is left. */
  reserveAggregator(env: Env, nowMs: number): Promise<boolean>;
  fetch: typeof fetch;
  now(): number;
  notify(env: Env, change: PackageChange): Promise<unknown>;
}

export const defaultDeps: ConsumeDeps = {
  adaptersFor: (carrier, env) => resolveAdapters(carrier, env),
  takeToken,
  reserveAggregator,
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  notify: (env, change) => notifyPackageChange(env, change),
};

export type JobOutcome = { kind: "done" } | { kind: "retry"; delaySec: number };

type TrackAttempt =
  | { kind: "result"; result: TrackResult; source: AdapterSource; misses: number }
  | { kind: "bucket_empty"; retryAfterSec: number }
  | { kind: "retry"; retryAfterSec: number | null }
  /** `blocked`: a server read of a device carrier threw device_required. */
  | { kind: "no_data"; checked: boolean; misses: number; blocked: boolean };

/** Errors that say this adapter will not answer for this number: they count toward web_misses. */
const MISS_KINDS = new Set(["not_found", "auth", "device_required"]);

/**
 * Whether the aggregator may be asked (docs/API.md "Aggregator budget"):
 * for device carriers only once a device read failed (FedEx's bot wall turns
 * the device away too) or the number is already registered; for the rest only
 * when no API or web adapter exists or those missed twice in a row.
 * Amazon never reaches here: pickAdapters leaves the aggregator out.
 */
function aggregatorAllowed(pkg: PackageRow, primaries: number, misses: number): boolean {
  if (isDeviceCarrier(pkg.carrier as CarrierId)) return pkg.device_failures > 0 || pkg.aggregator_registered_at !== null;
  return primaries === 0 || pkg.web_misses + misses >= AGGREGATOR_AFTER_MISSES;
}

/** Spends the budget on a number's first registration; later reads are free. */
async function mayRegister(pkg: PackageRow, env: Env, deps: ConsumeDeps, now: number): Promise<boolean> {
  if (pkg.aggregator_registered_at !== null) return true;
  if (!(await deps.reserveAggregator(env, now))) {
    console.info("poll: aggregator budget spent this month", pkg.id);
    return false;
  }
  await env.DB.prepare("UPDATE packages SET aggregator_registered_at = ? WHERE id = ? AND user_id = ?")
    .bind(now, pkg.id, pkg.user_id)
    .run();
  return true;
}

/**
 * Tries adapters in order (pickAdapters: API, then web, then aggregator);
 * falls through to the next only on a non-retryable error. device_required
 * on a device carrier stops the run: the device reads it instead.
 */
async function track(pkg: PackageRow, env: Env, deps: ConsumeDeps): Promise<TrackAttempt> {
  const carrier = pkg.carrier as CarrierId;
  const ctx = { fetch: deps.fetch, env, now: () => new Date(deps.now()) };
  const adapters = deps.adaptersFor(carrier, env);
  const primaries = adapters.filter((a) => a.source !== "aggregator").length;
  let checked = false;
  let misses = 0;
  for (const adapter of adapters) {
    const isAggregator = adapter.source === "aggregator";
    if (isAggregator && !aggregatorAllowed(pkg, primaries, misses)) continue;
    const bucket = await deps.takeToken(env, `carrier:${adapter.id}`, bucketFor(adapter), deps.now());
    if (!bucket.allowed) return { kind: "bucket_empty", retryAfterSec: bucket.retryAfterSec };
    if (isAggregator && !(await mayRegister(pkg, env, deps, deps.now()))) continue;
    try {
      const result = await adapter.track(pkg.tracking_number, carrier, ctx);
      return { kind: "result", result, source: adapter.source, misses };
    } catch (err) {
      if (!(err instanceof CarrierError)) {
        console.warn("poll: adapter threw", adapter.id, err);
        return { kind: "retry", retryAfterSec: null };
      }
      if (err.retryable) return { kind: "retry", retryAfterSec: err.retryAfterSec };
      console.warn("poll: adapter failed", adapter.id, err.kind, err.message);
      if (err.kind === "device_required" && isDeviceCarrier(carrier)) return { kind: "no_data", checked, misses, blocked: true };
      if (err.kind === "not_found") checked = true;
      if (!isAggregator && MISS_KINDS.has(err.kind)) misses++;
    }
  }
  return { kind: "no_data", checked, misses, blocked: false };
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

/**
 * Reschedules after the last failed delivery so the cron picks the package up
 * again: server feeds back off 15 min, doubling, up to 2 h (scraping.md
 * "Polling limits"). Still stops once the package has been quiet 30 days.
 */
export async function giveUpForNow(job: TrackJob, env: Env, deps: ConsumeDeps): Promise<void> {
  const pkg = await target(job, env);
  if (!pkg) return;
  const now = deps.now();
  const failures = pkg.check_failures + 1;
  const regular = nextCheckAt(pkg.status, now, pkg.updated_at);
  const next = regular === null ? null : now + checkBackoffMs(failures);
  await env.DB.prepare("UPDATE packages SET next_check_at = ?, check_failures = ? WHERE id = ? AND user_id = ?")
    .bind(next, failures, pkg.id, pkg.user_id)
    .run();
}

function deviceReason(job: TrackJob, pkg: PackageRow, blocked: boolean): DeviceJobReason {
  if (job.reason === "manual") return "manual";
  if (blocked) return "server_blocked";
  return pkg.last_checked_at === null ? "new" : "scheduled";
}

/**
 * Asks the user's device to read the carrier page: sets device_needed_at
 * (kept when already set, so a backoff or an older request stands; a manual
 * refresh makes it now) and schedules the next look at the device cadence.
 */
export async function handOffToDevice(env: Env, pkg: PackageRow, reason: DeviceJobReason, now: number): Promise<void> {
  const next = nextCheckAt(pkg.status, now, pkg.updated_at, deviceCadence(pkg.carrier));
  const manual = reason === "manual" ? 1 : 0;
  await env.DB.prepare(
    `UPDATE packages SET
       device_needed_at = CASE WHEN ?1 THEN ?2 ELSE COALESCE(device_needed_at, ?2) END,
       device_reason = CASE WHEN ?1 OR device_needed_at IS NULL THEN ?3 ELSE device_reason END,
       next_check_at = ?4
     WHERE id = ?5 AND user_id = ?6`,
  )
    .bind(manual, now, reason, next, pkg.id, pkg.user_id)
    .run();
}

async function storeResult(env: Env, pkg: PackageRow, attempt: Extract<TrackAttempt, { kind: "result" }>, now: number, deps: ConsumeDeps) {
  const r = attempt.result;
  const cadence = cadenceFor(pkg.carrier, attempt.source);
  const outcome = await applyTracking(env.DB, pkg, { ...r, checkedAtMs: now, source: attempt.source, cadence }, now);
  // A server read answers what a device read was wanted for.
  const webMisses = attempt.source === "aggregator" ? pkg.web_misses + attempt.misses : 0;
  await env.DB.prepare(
    `UPDATE packages SET check_failures = 0, web_misses = ?, device_needed_at = NULL, device_reason = NULL
     WHERE id = ? AND user_id = ?`,
  )
    .bind(webMisses, pkg.id, pkg.user_id)
    .run();
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
}

async function storeNoData(env: Env, job: TrackJob, pkg: PackageRow, attempt: Extract<TrackAttempt, { kind: "no_data" }>, now: number) {
  await env.DB.prepare("UPDATE packages SET web_misses = web_misses + ?, check_failures = 0 WHERE id = ? AND user_id = ?")
    .bind(attempt.misses, pkg.id, pkg.user_id)
    .run();
  if (isDeviceCarrier(pkg.carrier as CarrierId)) {
    await handOffToDevice(env, pkg, deviceReason(job, pkg, attempt.blocked), now);
    return;
  }
  const next = attempt.checked ? nextCheckAt(pkg.status, now, pkg.updated_at) : noAdapterRetryAt(now, pkg.updated_at);
  await setNextCheck(env.DB, pkg, next, attempt.checked ? now : pkg.last_checked_at);
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
    case "no_data":
      await storeNoData(env, job, pkg, attempt, now);
      return { kind: "done" };
    case "result":
      await storeResult(env, pkg, attempt, now, deps);
      return { kind: "done" };
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
