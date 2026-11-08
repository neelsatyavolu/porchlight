import { CARRIER_IDS, detectCarrier, normalizeNumber, type CarrierId } from "@porchlight/carriers";
import { z } from "zod";
import type { Env } from "../env.js";
import { requireUser } from "../lib/auth.js";
import { isUuid, toIso } from "../lib/crypto.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { rateLimited } from "../lib/ratelimit.js";
import type { RouteContext, Router } from "../lib/router.js";
import type { PackageDeleteResponse, PackageResponse, RefreshResponse } from "../types/api.js";
import { eventsFor, loadPackage, toPackages, type PackageRow } from "./sync.js";

const REFRESH_INTERVAL_MS = 2 * 60 * 1000;

/**
 * SQL for a package's next `updated_at` (binds ?1 = now, ?2 = user id). It is
 * strictly greater than every other updated_at of the user, so a sync cursor
 * never skips a write that commits after a read with a later clock.
 */
export const NEXT_UPDATED_AT =
  "MAX(?1, COALESCE((SELECT MAX(updated_at) FROM packages WHERE user_id = ?2), 0) + 1)";

const text = (max: number) => z.string().trim().max(max).nullable().optional();
const putBody = z.object({
  trackingNumber: z.string().max(64).optional(),
  carrier: z.enum(CARRIER_IDS).optional(),
  title: text(200),
  merchant: text(200),
  orderId: text(100),
  source: z.enum(["manual", "share"]).optional(),
  archived: z.boolean().optional(),
});
type PutBody = z.infer<typeof putBody>;

function packageId(raw: string | undefined): string {
  const id = (raw ?? "").toLowerCase();
  if (!isUuid(id)) throw new HttpError(400, "bad_request", "id: must be a UUID");
  return id;
}

function cleanNumber(raw: string): string {
  const n = normalizeNumber(raw);
  if (n.length === 0) throw new HttpError(400, "bad_request", "trackingNumber: must not be empty");
  return n;
}

async function duplicateOf(env: Env, userId: string, carrier: string, number: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT id FROM packages WHERE user_id = ? AND carrier = ? AND tracking_number = ? AND deleted_at IS NULL",
  )
    .bind(userId, carrier, number)
    .first<{ id: string }>();
  return row?.id ?? null;
}

const conflictDuplicate = (existingId: string): HttpError =>
  new HttpError(409, "conflict", "You already track this number", {}, { reason: "duplicate", existingId });

async function create(env: Env, userId: string, id: string, body: PutBody): Promise<Response> {
  if (body.trackingNumber === undefined) throw new HttpError(400, "bad_request", "trackingNumber: required on create");
  const number = cleanNumber(body.trackingNumber);
  const carrier: CarrierId = body.carrier ?? detectCarrier(number)[0]?.carrier ?? "other";
  const dup = await duplicateOf(env, userId, carrier, number);
  if (dup) throw conflictDuplicate(dup);
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO packages (id, user_id, carrier, tracking_number, title, merchant, order_id, source, status,
         archived_at, next_check_at, updated_at)
       VALUES (?3, ?2, ?4, ?5, ?6, ?7, ?8, ?9, 'unknown', ?10, ?1, ${NEXT_UPDATED_AT})`,
    )
      .bind(now, userId, id, carrier, number, body.title ?? null, body.merchant ?? null, body.orderId ?? null,
        body.source ?? "manual", body.archived ? now : null)
      .run();
  } catch (err) {
    // A concurrent request won the race; answer as that request would have.
    if (!String(err).includes("UNIQUE")) throw err;
    const raced = await duplicateOf(env, userId, carrier, number);
    if (raced && raced !== id) throw conflictDuplicate(raced);
    return put(env, userId, id, body);
  }
  return json(await loadPackage(env, userId, id), 201);
}

async function update(env: Env, row: PackageRow, body: PutBody): Promise<Response> {
  const now = Date.now();
  const number = body.trackingNumber === undefined ? row.tracking_number : cleanNumber(body.trackingNumber);
  const carrier = body.carrier ?? row.carrier;
  const retarget = number !== row.tracking_number || carrier !== row.carrier;
  if (retarget) {
    const dup = await duplicateOf(env, row.user_id, carrier, number);
    if (dup && dup !== row.id) throw conflictDuplicate(dup);
  }
  const archivedAt = body.archived === undefined ? row.archived_at : body.archived ? (row.archived_at ?? now) : null;
  const next = {
    title: body.title === undefined ? row.title : body.title,
    merchant: body.merchant === undefined ? row.merchant : body.merchant,
    order_id: body.orderId === undefined ? row.order_id : body.orderId,
  };
  const changed =
    retarget || next.title !== row.title || next.merchant !== row.merchant ||
    next.order_id !== row.order_id || archivedAt !== row.archived_at;
  if (changed) {
    const stmts = [
      env.DB.prepare(
        `UPDATE packages SET title = ?3, merchant = ?4, order_id = ?5, archived_at = ?6, updated_at = ${NEXT_UPDATED_AT}
         WHERE id = ?7 AND user_id = ?2`,
      ).bind(now, row.user_id, next.title, next.merchant, next.order_id, archivedAt, row.id),
    ];
    if (retarget) {
      // A different number is a different shipment: drop what the old one said.
      stmts.push(
        env.DB.prepare(
          `UPDATE packages SET carrier = ?, tracking_number = ?, status = 'unknown', status_detail = NULL,
             eta_start = NULL, eta_end = NULL, eta_date_only = 0, delivered_at = NULL, last_checked_at = NULL, next_check_at = ?
           WHERE id = ? AND user_id = ?`,
        ).bind(carrier, number, now, row.id, row.user_id),
        env.DB.prepare("DELETE FROM events WHERE package_id = ?").bind(row.id),
      );
    }
    await env.DB.batch(stmts);
  }
  return json(await loadPackage(env, row.user_id, row.id), 200);
}

async function ownRow(env: Env, userId: string, id: string): Promise<PackageRow | null> {
  const row = await env.DB.prepare("SELECT * FROM packages WHERE id = ?").bind(id).first<PackageRow>();
  if (row && row.user_id !== userId) throw new HttpError(404, "not_found", "No such package");
  return row;
}

async function put(env: Env, userId: string, id: string, body: PutBody): Promise<Response> {
  const row = await ownRow(env, userId, id);
  if (!row) return create(env, userId, id, body);
  if (row.deleted_at !== null) throw new HttpError(409, "conflict", "This package was deleted", {}, { reason: "deleted" });
  return update(env, row, body);
}

async function putPackage({ req, env, params }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const id = packageId(params.id);
  return put(env, session.userId, id, await readJson(req, putBody));
}

/** One live package with its items and events, for deep links. */
async function getPackage({ req, env, params }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const id = packageId(params.id);
  const row = await env.DB.prepare("SELECT * FROM packages WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .bind(id, session.userId)
    .first<PackageRow>();
  if (!row) throw new HttpError(404, "not_found", "No such package");
  const [pkg] = await toPackages(env, session.userId, [row]);
  return json<PackageResponse>({ package: pkg!, events: await eventsFor(env, session.userId, [id]) });
}

async function deletePackage({ req, env, params }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const id = packageId(params.id);
  const row = await ownRow(env, session.userId, id);
  if (!row) throw new HttpError(404, "not_found", "No such package");
  if (row.deleted_at !== null) return json<PackageDeleteResponse>({ id, deletedAt: toIso(row.deleted_at) });
  const now = Date.now();
  // The tombstone's tracking number gets a suffix so UNIQUE(user, carrier,
  // number) lets the same number be added again under a new id.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events WHERE package_id = ?").bind(id),
    env.DB.prepare("DELETE FROM package_items WHERE package_id = ?").bind(id),
    env.DB.prepare(
      `UPDATE packages SET deleted_at = ?1, next_check_at = NULL, tracking_number = tracking_number || '~deleted~' || id,
         updated_at = ${NEXT_UPDATED_AT} WHERE id = ?3 AND user_id = ?2`,
    ).bind(now, session.userId, id),
  ]);
  return json<PackageDeleteResponse>({ id, deletedAt: toIso(now) });
}

async function refreshPackage({ req, env, params }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const id = packageId(params.id);
  const row = await ownRow(env, session.userId, id);
  if (!row || row.deleted_at !== null) throw new HttpError(404, "not_found", "No such package");
  const now = Date.now();
  const key = `refresh:${id}`;
  const until = Number((await env.RATE.get(key)) ?? 0);
  if (until > now) throw rateLimited(Math.ceil((until - now) / 1000));
  const nextAllowed = now + REFRESH_INTERVAL_MS;
  await env.RATE.put(key, String(nextAllowed), { expirationTtl: REFRESH_INTERVAL_MS / 1000 });
  await env.TRACK_QUEUE.send({ packageId: id, userId: session.userId, reason: "manual", enqueuedAt: now });
  return json<RefreshResponse>({ queued: true, nextAllowedAt: toIso(nextAllowed) }, 202);
}

/** Owns: GET /v1/packages/:id, PUT /v1/packages/:id, DELETE /v1/packages/:id, POST /v1/packages/:id/refresh (docs/API.md). */
export function register(router: Router): void {
  router
    .on("GET", "/v1/packages/:id", getPackage)
    .on("PUT", "/v1/packages/:id", putPackage)
    .on("DELETE", "/v1/packages/:id", deletePackage)
    .on("POST", "/v1/packages/:id/refresh", refreshPackage);
}
