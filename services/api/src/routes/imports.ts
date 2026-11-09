// POST /v1/imports/flint and /v1/imports/amazon (docs/API.md §Imports).
// Each item is deduped by (user, source, dedupeKey) through the imports table
// and attaches to an existing (user, carrier, trackingNumber) package if any.
import { CARRIER_IDS, STATUSES, detectCarrier, normalizeNumber, type CarrierId } from "@porchlight/carriers";
import { z } from "zod";
import type { Env } from "../env.js";
import { notifyPackageChange, type PackageChange } from "../lib/apns.js";
import { requireUser, requireUserOrToken } from "../lib/auth.js";
import { etaToMs } from "../lib/eta.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { takeToken, type BucketSpec, type RateDecision } from "../lib/rate.js";
import type { RouteContext, Router } from "../lib/router.js";
import { applyTracking, isoToMs, loadPackage, type PackageRow } from "../poll/store.js";
import type { TrackJob } from "../poll/types.js";
import { NEXT_UPDATED_AT } from "./packages.js";
import type { ImportOutcome, ImportResponse, ImportResult, PackageItem } from "../types/api.js";

export const IMPORT_BUCKET: BucketSpec = { capacity: 30, refillPerSec: 0.5 };

/** Collaborators from other modules, injectable so tests need no module mocks. */
export interface ImportDeps {
  takeToken(env: Env, key: string, spec: BucketSpec, nowMs: number): Promise<RateDecision>;
  normalizeNumber(raw: string): string;
  detectCarrier(number: string): readonly { carrier: CarrierId }[];
  notify(env: Env, change: PackageChange): Promise<unknown>;
  now(): number;
}

export const defaultImportDeps: ImportDeps = {
  takeToken,
  normalizeNumber,
  detectCarrier,
  notify: (env, change) => notifyPackageChange(env, change),
  now: () => Date.now(),
};
/** Observations dated further ahead than this are refused (clock skew allowance). */
const MAX_FUTURE_MS = 5 * 60_000;
const NUMBER_RE = /^[A-Z0-9]{5,40}$/;

const isoDate = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().trim().min(1).max(max);

const RequestSchema = z.strictObject({ items: z.array(z.unknown()).min(1).max(100) });

const FlintItem = z.strictObject({
  trackingNumber: text(64),
  carrier: z.enum(CARRIER_IDS).optional(),
  merchant: text(200).nullable(),
  subject: text(500).nullable(),
  messageDate: isoDate,
  dedupeKey: text(998),
});

const Event = z.strictObject({
  occurredAt: isoDate,
  status: z.enum(STATUSES),
  description: text(500),
  location: text(200).nullable(),
});

const AmazonItem = z.strictObject({
  orderId: text(64),
  shipmentId: text(128),
  carrier: z.enum(CARRIER_IDS),
  trackingNumber: text(64),
  title: text(500).nullable(),
  items: z
    .array(
      z.strictObject({
        name: text(500),
        imageUrl: z.url({ protocol: /^https$/ }).max(2048).nullable(),
        quantity: z.number().int().min(1).max(999),
      }),
    )
    .max(50),
  // Checked against etaDateOnly below: "YYYY-MM-DD" when true, an instant when false.
  etaStart: z.union([z.iso.date(), isoDate]).nullable(),
  etaEnd: z.union([z.iso.date(), isoDate]).nullable(),
  etaDateOnly: z.boolean().optional(),
  observed: z
    .strictObject({
      status: z.enum(STATUSES),
      statusDetail: text(500),
      observedAt: isoDate,
      deliveredAt: isoDate.nullable(),
      events: z.array(Event).max(100),
    })
    .optional(),
}).superRefine((item, ctx) => {
  const dateOnly = item.etaDateOnly === true;
  for (const key of ["etaStart", "etaEnd"] as const) {
    const value = item[key];
    if (value !== null && etaToMs(value, dateOnly) === null) {
      ctx.addIssue({ code: "custom", path: [key], message: dateOnly ? "must be YYYY-MM-DD when etaDateOnly is true" : "must be an ISO 8601 date-time when etaDateOnly is false" });
    }
  }
});
type AmazonItem = z.output<typeof AmazonItem>;

interface ImportCtx {
  env: Env;
  userId: string;
  now: number;
  deps: ImportDeps;
}

type Target = { kind: "existing"; pkg: PackageRow } | { kind: "deleted" } | { kind: "none" };

const rejected = (dedupeKey: string, reason: string): ImportResult => ({ dedupeKey, packageId: null, outcome: "rejected", reason });

function issueText(err: z.ZodError): string {
  const first = err.issues[0];
  if (!first) return "invalid item";
  return first.path.length > 0 ? `${first.path.join(".")}: ${first.message}` : first.message;
}

function normalized(c: ImportCtx, raw: string): string | null {
  const n = c.deps.normalizeNumber(raw);
  return NUMBER_RE.test(n) ? n : null;
}

async function findTarget(c: ImportCtx, source: string, key: string, carrier: string, number: string): Promise<Target> {
  const imp = await c.env.DB.prepare("SELECT package_id FROM imports WHERE user_id = ? AND source = ? AND dedupe_key = ?")
    .bind(c.userId, source, key)
    .first<{ package_id: string | null }>();
  const byImport = imp?.package_id ? await loadPackage(c.env.DB, imp.package_id, c.userId) : null;
  const pkg =
    byImport ??
    (await c.env.DB.prepare("SELECT * FROM packages WHERE user_id = ? AND carrier = ? AND tracking_number = ?")
      .bind(c.userId, carrier, number)
      .first<PackageRow>());
  if (!pkg) return { kind: "none" };
  return pkg.deleted_at === null ? { kind: "existing", pkg } : { kind: "deleted" };
}

async function recordImport(c: ImportCtx, source: string, key: string, packageId: string): Promise<void> {
  await c.env.DB.prepare(
    `INSERT INTO imports (user_id, source, dedupe_key, package_id, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, source, dedupe_key) DO UPDATE SET package_id = excluded.package_id`,
  )
    .bind(c.userId, source, key, packageId, c.now)
    .run();
}

interface NewPackage {
  carrier: string;
  number: string;
  title: string | null;
  merchant: string | null;
  orderId: string | null;
  source: "flint" | "amazon";
  etaStart: number | null;
  etaEnd: number | null;
  etaDateOnly: boolean;
  items: readonly PackageItem[];
}

/**
 * Inserts the package and its items in one batch, so a sync never sees the
 * package without its items at an updated_at it will not send again. Returns
 * the id, or null if another row won the (user, carrier, number) race.
 */
async function insertPackage(c: ImportCtx, p: NewPackage): Promise<string | null> {
  const id = crypto.randomUUID();
  const db = c.env.DB;
  const item = db.prepare(
    `INSERT INTO package_items (package_id, name, image_url, quantity)
     SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM packages WHERE id = ?1 AND user_id = ?5)`,
  );
  const [res] = await db.batch([
    db
      .prepare(
        `INSERT INTO packages (id, user_id, carrier, tracking_number, title, merchant, order_id, source,
           eta_start, eta_end, eta_date_only, next_check_at, updated_at)
         VALUES (?3, ?2, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?1, ${NEXT_UPDATED_AT})
         ON CONFLICT (user_id, carrier, tracking_number) DO NOTHING`,
      )
      .bind(c.now, c.userId, id, p.carrier, p.number, p.title, p.merchant, p.orderId, p.source, p.etaStart, p.etaEnd,
        p.etaStart === null && p.etaEnd === null ? 0 : Number(p.etaDateOnly)),
    ...p.items.map((i) => item.bind(id, i.name, i.imageUrl, i.quantity, c.userId)),
  ]);
  return (res?.meta.changes ?? 0) > 0 ? id : null;
}

async function queueFirstCheck(c: ImportCtx, packageId: string): Promise<void> {
  const job: TrackJob = { packageId, userId: c.userId, reason: "import", enqueuedAt: c.now };
  // next_check_at is already now, so the cron picks it up if this send fails.
  await c.env.TRACK_QUEUE.send(job).catch((err: unknown) => console.error("imports: queue send failed", packageId, err));
}

// ---- Flint ------------------------------------------------------------------

async function importFlintItem(c: ImportCtx, raw: unknown): Promise<ImportResult> {
  const key = typeof (raw as { dedupeKey?: unknown })?.dedupeKey === "string" ? (raw as { dedupeKey: string }).dedupeKey : "";
  const parsed = FlintItem.safeParse(raw);
  if (!parsed.success) return rejected(key, issueText(parsed.error));
  const item = parsed.data;
  const number = normalized(c, item.trackingNumber);
  if (!number) return rejected(key, "trackingNumber: not a tracking number");
  const carrier: CarrierId = item.carrier ?? c.deps.detectCarrier(number)[0]?.carrier ?? "other";

  for (let tries = 0; tries < 2; tries++) {
    const target = await findTarget(c, "flint", key, carrier, number);
    if (target.kind === "deleted") return rejected(key, "deleted");
    if (target.kind === "existing") {
      const { pkg } = target;
      // Fill blanks only: a title or merchant the user set is never overwritten.
      const changed = (pkg.title === null && item.subject !== null) || (pkg.merchant === null && item.merchant !== null);
      if (changed) {
        await c.env.DB.prepare(
          `UPDATE packages SET title = COALESCE(title, ?3), merchant = COALESCE(merchant, ?4), updated_at = ${NEXT_UPDATED_AT}
           WHERE id = ?5 AND user_id = ?2`,
        )
          .bind(c.now, c.userId, item.subject, item.merchant, pkg.id)
          .run();
      }
      await recordImport(c, "flint", key, pkg.id);
      return { dedupeKey: key, packageId: pkg.id, outcome: changed ? "updated" : "unchanged" };
    }
    const id = await insertPackage(c, {
      carrier,
      number,
      title: item.subject,
      merchant: item.merchant,
      orderId: null,
      source: "flint",
      etaStart: null,
      etaEnd: null,
      etaDateOnly: false,
      items: [],
    });
    if (id) {
      await recordImport(c, "flint", key, id);
      await queueFirstCheck(c, id);
      return { dedupeKey: key, packageId: id, outcome: "created" };
    }
  }
  return rejected(key, "conflict, retry");
}

// ---- Amazon -----------------------------------------------------------------

function amazonKey(raw: unknown): string {
  const r = (raw ?? {}) as { orderId?: unknown; shipmentId?: unknown };
  return typeof r.orderId === "string" && typeof r.shipmentId === "string" ? `${r.orderId}:${r.shipmentId}` : "";
}

async function loadItems(c: ImportCtx, packageId: string): Promise<PackageItem[]> {
  const { results } = await c.env.DB.prepare(
    "SELECT name, image_url AS imageUrl, quantity FROM package_items WHERE package_id = ? ORDER BY rowid",
  )
    .bind(packageId)
    .all<PackageItem>();
  return results;
}

/** The title an Amazon import gives a package from its items ("Cable", "Cable and 2 more"). */
function itemsTitle(items: readonly PackageItem[]): string | null {
  const [first] = items;
  if (!first) return null;
  return items.length === 1 ? first.name : `${first.name} and ${items.length - 1} more`;
}

/** Replaces the package's items when they differ from `current`. Returns whether they did. */
async function replaceItems(
  c: ImportCtx,
  packageId: string,
  current: readonly PackageItem[],
  items: readonly PackageItem[],
): Promise<boolean> {
  if (JSON.stringify(current) === JSON.stringify(items)) return false;
  const insert = c.env.DB.prepare("INSERT INTO package_items (package_id, name, image_url, quantity) VALUES (?, ?, ?, ?)");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM package_items WHERE package_id = ?").bind(packageId),
    ...items.map((i) => insert.bind(packageId, i.name, i.imageUrl, i.quantity)),
  ]);
  return true;
}

/** Writes the fields Amazon owns. Returns whether anything changed. */
async function applyAmazonFields(c: ImportCtx, pkg: PackageRow, item: AmazonItem): Promise<boolean> {
  const hasEta = item.etaStart !== null || item.etaEnd !== null;
  const dateOnly = item.etaDateOnly === true;
  const etaStart = hasEta ? etaToMs(item.etaStart, dateOnly) : pkg.eta_start;
  const etaEnd = hasEta ? etaToMs(item.etaEnd, dateOnly) : pkg.eta_end;
  const etaDateOnly = hasEta ? Number(dateOnly) : pkg.eta_date_only;
  const current = await loadItems(c, pkg.id);
  // The app may send a shorter title than the item names (it summarizes them on
  // device). It replaces a title an import set from the items, never one the
  // person typed.
  const importSetTitle = pkg.title === null || pkg.title === itemsTitle(current);
  const title = importSetTitle ? (item.title ?? pkg.title) : pkg.title;
  const fieldsChanged =
    pkg.order_id !== item.orderId || pkg.eta_start !== etaStart || pkg.eta_end !== etaEnd ||
    pkg.eta_date_only !== etaDateOnly || pkg.title !== title;
  const itemsChanged = await replaceItems(c, pkg.id, current, item.items);
  if (fieldsChanged || itemsChanged) {
    await c.env.DB.prepare(
      `UPDATE packages SET order_id = ?3, eta_start = ?4, eta_end = ?5, eta_date_only = ?8, title = ?6, updated_at = ${NEXT_UPDATED_AT}
       WHERE id = ?7 AND user_id = ?2`,
    )
      .bind(c.now, c.userId, item.orderId, etaStart, etaEnd, title, pkg.id, etaDateOnly)
      .run();
  }
  return fieldsChanged || itemsChanged;
}

/** Applies the on-device observation when it is newer than the last check. */
async function applyObserved(c: ImportCtx, packageId: string, item: AmazonItem): Promise<boolean> {
  const obs = item.observed;
  const pkg = await loadPackage(c.env.DB, packageId, c.userId);
  const observedAt = isoToMs(obs?.observedAt);
  if (!obs || !pkg || observedAt === null || observedAt <= (pkg.last_checked_at ?? -Infinity)) return false;
  const update = { status: obs.status, statusDetail: obs.statusDetail, deliveredAt: obs.deliveredAt, events: obs.events };
  const outcome = await applyTracking(c.env.DB, pkg, { ...update, checkedAtMs: observedAt, source: "amazon", onlyIfNewer: true }, c.now);
  if (outcome.changed) {
    const change = { userId: c.userId, packageId, title: pkg.title, ...update, statusChanged: outcome.statusChanged };
    await c.deps.notify(c.env, change).catch((err: unknown) => console.error("imports: push failed", packageId, err));
  }
  return outcome.changed;
}

async function importAmazonItem(c: ImportCtx, raw: unknown): Promise<ImportResult> {
  const key = amazonKey(raw);
  const parsed = AmazonItem.safeParse(raw);
  if (!parsed.success) return rejected(key, issueText(parsed.error));
  const item = parsed.data;
  if (item.observed && Date.parse(item.observed.observedAt) > c.now + MAX_FUTURE_MS) {
    return rejected(key, "observed.observedAt: in the future");
  }
  const number = normalized(c, item.trackingNumber);
  if (!number) return rejected(key, "trackingNumber: not a tracking number");

  for (let tries = 0; tries < 2; tries++) {
    const target = await findTarget(c, "amazon", key, item.carrier, number);
    if (target.kind === "deleted") return rejected(key, "deleted");
    let packageId: string;
    let outcome: ImportOutcome;
    if (target.kind === "existing") {
      packageId = target.pkg.id;
      outcome = (await applyAmazonFields(c, target.pkg, item)) ? "updated" : "unchanged";
    } else {
      const id = await insertPackage(c, {
        carrier: item.carrier,
        number,
        title: item.title,
        merchant: "Amazon",
        orderId: item.orderId,
        source: "amazon",
        etaStart: etaToMs(item.etaStart, item.etaDateOnly === true),
        etaEnd: etaToMs(item.etaEnd, item.etaDateOnly === true),
        etaDateOnly: item.etaDateOnly === true,
        items: item.items,
      });
      if (!id) continue;
      packageId = id;
      outcome = "created";
    }
    await recordImport(c, "amazon", key, packageId);
    const observedChanged = await applyObserved(c, packageId, item);
    if (outcome === "created" && item.observed?.status !== "delivered") await queueFirstCheck(c, packageId);
    if (outcome === "unchanged" && observedChanged) outcome = "updated";
    return { dedupeKey: key, packageId, outcome };
  }
  return rejected(key, "conflict, retry");
}

// ---- Routes -----------------------------------------------------------------

async function runImport(
  ctx: RouteContext,
  auth: SessionOrToken,
  importItem: (c: ImportCtx, raw: unknown) => Promise<ImportResult>,
  deps: ImportDeps,
): Promise<Response> {
  if (auth instanceof Response) return auth;
  const now = deps.now();
  const rate = await deps.takeToken(ctx.env, `imports:${auth.userId}`, IMPORT_BUCKET, now);
  if (!rate.allowed) {
    throw new HttpError(429, "rate_limited", "Too many imports, try again later", { "retry-after": String(rate.retryAfterSec) });
  }
  const { items } = await readJson(ctx.req, RequestSchema);
  const c: ImportCtx = { env: ctx.env, userId: auth.userId, now, deps };
  const results: ImportResult[] = [];
  for (const raw of items) results.push(await importItem(c, raw));
  return json<ImportResponse>({ results });
}

type SessionOrToken = Awaited<ReturnType<typeof requireUserOrToken>>;

/** Owns: POST /v1/imports/flint, POST /v1/imports/amazon (docs/API.md). */
export function register(router: Router, deps: ImportDeps = defaultImportDeps): void {
  router.on("POST", "/v1/imports/flint", async (ctx) =>
    runImport(ctx, await requireUserOrToken(ctx.req, ctx.env, "imports:write"), importFlintItem, deps),
  );
  router.on("POST", "/v1/imports/amazon", async (ctx) =>
    runImport(ctx, await requireUser(ctx.req, ctx.env), importAmazonItem, deps),
  );
}
