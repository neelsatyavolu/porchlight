import type { CarrierId, Status } from "@porchlight/carriers";
import type { Env } from "../env.js";
import { requireUser } from "../lib/auth.js";
import { base64UrlDecodeText, base64UrlEncodeText, toIso } from "../lib/crypto.js";
import { HttpError, json } from "../lib/http.js";
import type { RouteContext, Router } from "../lib/router.js";
import type { Package, PackageEvent, PackageItem, PackageSource, SyncResponse } from "../types/api.js";

export const SYNC_PAGE_SIZE = 200;

export interface PackageRow {
  id: string;
  user_id: string;
  carrier: CarrierId;
  tracking_number: string;
  title: string | null;
  merchant: string | null;
  order_id: string | null;
  source: PackageSource;
  status: Status;
  status_detail: string | null;
  eta_start: number | null;
  eta_end: number | null;
  delivered_at: number | null;
  last_checked_at: number | null;
  next_check_at: number | null;
  archived_at: number | null;
  deleted_at: number | null;
  updated_at: number;
}

interface ItemRow {
  package_id: string;
  name: string;
  image_url: string | null;
  quantity: number;
}

interface EventRow {
  id: string;
  package_id: string;
  occurred_at: number;
  status: Status;
  description: string;
  location: string | null;
}

export function toPackage(r: PackageRow, items: PackageItem[]): Package {
  return {
    id: r.id,
    carrier: r.carrier,
    trackingNumber: r.tracking_number,
    title: r.title,
    merchant: r.merchant,
    orderId: r.order_id,
    source: r.source,
    status: r.status,
    statusDetail: r.status_detail,
    etaStart: toIso(r.eta_start),
    etaEnd: toIso(r.eta_end),
    deliveredAt: toIso(r.delivered_at),
    lastCheckedAt: toIso(r.last_checked_at),
    archivedAt: toIso(r.archived_at),
    updatedAt: toIso(r.updated_at),
    items,
  };
}

const toEvent = (r: EventRow): PackageEvent => ({
  id: r.id,
  packageId: r.package_id,
  occurredAt: toIso(r.occurred_at),
  status: r.status,
  description: r.description,
  location: r.location,
});

/** Items for the given package ids, grouped by package. Ids go in as one JSON param (D1 caps bound params). */
async function itemsFor(env: Env, userId: string, ids: readonly string[]): Promise<Map<string, PackageItem[]>> {
  const { results } = await env.DB.prepare(
    `SELECT i.package_id, i.name, i.image_url, i.quantity FROM package_items i
     JOIN packages p ON p.id = i.package_id AND p.user_id = ?1
     WHERE i.package_id IN (SELECT value FROM json_each(?2)) ORDER BY i.rowid`,
  )
    .bind(userId, JSON.stringify(ids))
    .all<ItemRow>();
  const out = new Map<string, PackageItem[]>();
  for (const r of results) {
    const item: PackageItem = { name: r.name, imageUrl: r.image_url, quantity: r.quantity };
    out.set(r.package_id, [...(out.get(r.package_id) ?? []), item]);
  }
  return out;
}

async function eventsFor(env: Env, userId: string, ids: readonly string[]): Promise<PackageEvent[]> {
  if (ids.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.package_id, e.occurred_at, e.status, e.description, e.location FROM events e
     JOIN packages p ON p.id = e.package_id AND p.user_id = ?1
     WHERE e.package_id IN (SELECT value FROM json_each(?2)) ORDER BY e.package_id, e.occurred_at DESC, e.id`,
  )
    .bind(userId, JSON.stringify(ids))
    .all<EventRow>();
  return results.map(toEvent);
}

/** Converts rows to API packages with their items. */
export async function toPackages(env: Env, userId: string, rows: readonly PackageRow[]): Promise<Package[]> {
  if (rows.length === 0) return [];
  const items = await itemsFor(env, userId, rows.map((r) => r.id));
  return rows.map((r) => toPackage(r, items.get(r.id) ?? []));
}

/** One live or deleted package of the user as the API shows it; throws 404 when missing. */
export async function loadPackage(env: Env, userId: string, id: string): Promise<Package> {
  const row = await env.DB.prepare("SELECT * FROM packages WHERE id = ? AND user_id = ?").bind(id, userId).first<PackageRow>();
  if (!row) throw new HttpError(404, "not_found", "No such package");
  const [pkg] = await toPackages(env, userId, [row]);
  return pkg as Package;
}

interface Cursor {
  at: number;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return base64UrlEncodeText(`${c.at}:${c.id}`);
}

export function decodeCursor(raw: string): Cursor {
  try {
    const m = /^(\d{1,16}):([0-9a-f-]{0,36})$/.exec(base64UrlDecodeText(raw));
    if (m?.[1] !== undefined && m[2] !== undefined) return { at: Number(m[1]), id: m[2] };
  } catch {
    // fall through
  }
  throw new HttpError(400, "bad_request", "since: unknown cursor, do a full sync");
}

async function sync({ req, url, env }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const since = url.searchParams.get("since");
  const full = since === null || since === "";
  const from = full ? { at: -1, id: "" } : decodeCursor(since);

  const { results: rows } = await env.DB.prepare(
    `SELECT * FROM packages WHERE user_id = ?1 AND (updated_at > ?2 OR (updated_at = ?2 AND id > ?3))
     ${full ? "AND deleted_at IS NULL" : ""} ORDER BY updated_at, id LIMIT ?4`,
  )
    .bind(session.userId, from.at, from.id, SYNC_PAGE_SIZE + 1)
    .all<PackageRow>();

  const page = rows.slice(0, SYNC_PAGE_SIZE);
  const live = page.filter((r) => r.deleted_at === null);
  const last = page.at(-1);
  const data: SyncResponse = {
    packages: await toPackages(env, session.userId, live),
    events: await eventsFor(env, session.userId, live.map((r) => r.id)),
    deleted: page.filter((r) => r.deleted_at !== null).map((r) => r.id),
    cursor: encodeCursor(last ? { at: last.updated_at, id: last.id } : { at: Math.max(0, from.at), id: from.id }),
    hasMore: rows.length > SYNC_PAGE_SIZE,
  };
  return json(data);
}

/** Owns: GET /v1/sync?since= (docs/API.md). */
export function register(router: Router): void {
  router.on("GET", "/v1/sync", sync);
}
