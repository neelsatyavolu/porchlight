// GET /v1/device-tracking/due and POST /v1/packages/:id/observed
// (docs/API.md "Device tracking"). The native apps read usps, fedex and
// (when web:ups is blocked) ups tracking pages in a hidden web view and post
// what they saw. The poller sets device_needed_at (poll/consume.ts).
import { DEVICE_CARRIERS, STATUSES, isDeviceCarrier, type CarrierId } from "@porchlight/carriers";
import { z } from "zod";
import type { Env } from "../env.js";
import { notifyPackageChange, type PackageChange } from "../lib/apns.js";
import { requireUser } from "../lib/auth.js";
import { isUuid, toIso } from "../lib/crypto.js";
import { etaToMs } from "../lib/eta.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { enforce, type Limit } from "../lib/ratelimit.js";
import type { RouteContext, Router } from "../lib/router.js";
import { deviceBackoffMs, deviceCadence, nextCheckAt } from "../poll/interval.js";
import { applyTracking, type PackageRow } from "../poll/store.js";
import type { DeviceJob, DeviceJobReason, DeviceJobsResponse, DeviceObservedResponse } from "../types/api.js";

/** Most jobs per GET /v1/device-tracking/due. */
export const DUE_LIMIT = 10;
/** docs/API.md "Rate limits": POST /v1/packages/:id/observed per user. */
export const OBSERVED_LIMIT: Limit = { max: 60, windowSec: 60 };
/** Observations dated further ahead than this are refused (clock skew allowance). */
const MAX_FUTURE_MS = 5 * 60_000;

export interface DeviceDeps {
  notify(env: Env, change: PackageChange): Promise<unknown>;
  now(): number;
}

export const defaultDeviceDeps: DeviceDeps = {
  notify: (env, change) => notifyPackageChange(env, change),
  now: () => Date.now(),
};

const isoDate = z.iso.datetime({ offset: true });
/** Trimmed text; an empty string reads as null. */
const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().transform((v) => (v === null || v === "" ? null : v));

const Event = z.object({
  occurredAt: isoDate,
  status: z.enum(STATUSES),
  description: z.string().trim().min(1).max(500),
  location: optionalText(200),
});

const Observation = z
  .object({
    observedAt: isoDate,
    source: z.literal("device"),
    outcome: z.enum(["ok", "not_found", "challenged", "failed"]),
    status: z.enum(STATUSES),
    statusDetail: optionalText(500),
    // Checked against etaDateOnly below: "YYYY-MM-DD" when true, an instant when false.
    etaStart: z.union([z.iso.date(), isoDate]).nullable(),
    etaEnd: z.union([z.iso.date(), isoDate]).nullable(),
    etaDateOnly: z.boolean(),
    deliveredAt: isoDate.nullable(),
    events: z.array(Event).max(200),
  })
  .superRefine((o, ctx) => {
    for (const key of ["etaStart", "etaEnd"] as const) {
      const value = o[key];
      if (value !== null && etaToMs(value, o.etaDateOnly) === null) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: o.etaDateOnly ? "must be YYYY-MM-DD when etaDateOnly is true" : "must be an ISO 8601 date-time when etaDateOnly is false",
        });
      }
    }
  });
type Observation = z.output<typeof Observation>;

interface DueRow {
  id: string;
  carrier: string;
  tracking_number: string;
  device_reason: DeviceJobReason | null;
}

async function due({ req, env }: RouteContext, deps: DeviceDeps): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const carriers = DEVICE_CARRIERS.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, carrier, tracking_number, device_reason FROM packages
     WHERE user_id = ? AND device_needed_at IS NOT NULL AND device_needed_at <= ?
       AND deleted_at IS NULL AND status != 'delivered' AND carrier IN (${carriers})
     ORDER BY device_needed_at, id
     LIMIT ?`,
  )
    .bind(session.userId, deps.now(), ...DEVICE_CARRIERS, DUE_LIMIT)
    .all<DueRow>();
  const jobs: DeviceJob[] = results.map((r) => ({
    packageId: r.id,
    carrier: r.carrier as DeviceJob["carrier"],
    trackingNumber: r.tracking_number,
    reason: r.device_reason ?? "scheduled",
  }));
  return json<DeviceJobsResponse>({ jobs });
}

/** ok: applies the read when newer than the last check. Returns whether it applied. */
async function applyOk(env: Env, pkg: PackageRow, o: Observation, observedAt: number, now: number, deps: DeviceDeps): Promise<boolean> {
  if (observedAt <= (pkg.last_checked_at ?? -Infinity)) return false;
  const update = {
    status: o.status,
    statusDetail: o.statusDetail,
    etaStart: o.etaStart,
    etaEnd: o.etaEnd,
    etaDateOnly: o.etaDateOnly,
    deliveredAt: o.deliveredAt,
    events: o.events,
  };
  const outcome = await applyTracking(
    env.DB,
    pkg,
    { ...update, checkedAtMs: observedAt, source: "device", cadence: deviceCadence(pkg.carrier), onlyIfNewer: true },
    now,
  );
  if (outcome.changed) {
    // Same push the poller sends (poll/consume.ts).
    const change: PackageChange = {
      userId: pkg.user_id,
      packageId: pkg.id,
      title: pkg.title,
      status: o.status,
      statusDetail: o.statusDetail,
      statusChanged: outcome.statusChanged,
    };
    await deps.notify(env, change).catch((err: unknown) => console.error("device: push failed", pkg.id, err));
  }
  return outcome.applied;
}

const CLEAR_DEVICE = "device_needed_at = NULL, device_reason = NULL, device_failures = 0";

async function observed({ req, env, params }: RouteContext, deps: DeviceDeps): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const id = (params.id ?? "").toLowerCase();
  if (!isUuid(id)) throw new HttpError(400, "bad_request", "id: must be a UUID");
  const now = deps.now();
  await enforce(env, `observed:${session.userId}`, OBSERVED_LIMIT, now);
  const o = await readJson(req, Observation);
  const observedAt = Date.parse(o.observedAt);
  if (observedAt > now + MAX_FUTURE_MS) throw new HttpError(400, "bad_request", "observedAt: in the future");

  const pkg = await env.DB.prepare("SELECT * FROM packages WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .bind(id, session.userId)
    .first<PackageRow>();
  if (!pkg) throw new HttpError(404, "not_found", "No such package");
  if (!isDeviceCarrier(pkg.carrier as CarrierId)) {
    throw new HttpError(400, "bad_request", "This package's carrier is not read on the device");
  }

  let applied = false;
  const db = env.DB;
  switch (o.outcome) {
    case "ok":
      applied = await applyOk(env, pkg, o, observedAt, now, deps);
      await db.prepare(`UPDATE packages SET ${CLEAR_DEVICE} WHERE id = ? AND user_id = ?`).bind(id, pkg.user_id).run();
      break;
    case "not_found": {
      // A completed check: the next look follows the device cadence.
      const next = nextCheckAt(pkg.status, now, pkg.updated_at, deviceCadence(pkg.carrier));
      await db
        .prepare(
          `UPDATE packages SET ${CLEAR_DEVICE}, next_check_at = ?, last_checked_at = MAX(COALESCE(last_checked_at, 0), ?)
           WHERE id = ? AND user_id = ?`,
        )
        .bind(next, observedAt, id, pkg.user_id)
        .run();
      break;
    }
    case "challenged":
    case "failed": {
      const failures = pkg.device_failures + 1;
      // next_check_at = now: the server looks again on the next cron, and may ask the aggregator (poll/consume.ts).
      await db
        .prepare(
          `UPDATE packages SET device_failures = ?, device_needed_at = ?, device_reason = COALESCE(device_reason, 'scheduled'),
             next_check_at = ?
           WHERE id = ? AND user_id = ?`,
        )
        .bind(failures, now + deviceBackoffMs(failures), now, id, pkg.user_id)
        .run();
      break;
    }
  }
  const after = await db.prepare("SELECT device_needed_at FROM packages WHERE id = ?").bind(id).first<{ device_needed_at: number | null }>();
  const neededAt = after?.device_needed_at ?? null;
  return json<DeviceObservedResponse>({ applied, deviceNeededAt: neededAt === null ? null : toIso(neededAt) });
}

/** Owns: GET /v1/device-tracking/due, POST /v1/packages/:id/observed (docs/API.md). */
export function register(router: Router, deps: DeviceDeps = defaultDeviceDeps): void {
  router
    .on("GET", "/v1/device-tracking/due", (ctx) => due(ctx, deps))
    .on("POST", "/v1/packages/:id/observed", (ctx) => observed(ctx, deps));
}
