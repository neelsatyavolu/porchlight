import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { createSession, sha256Hex } from "../src/lib/auth.js";
import { errorResponse, HttpError } from "../src/lib/http.js";
import { Router } from "../src/lib/router.js";
import { register, type ImportDeps } from "../src/routes/imports.js";
import type { ImportResponse } from "../src/types/api.js";
import { countEvents, fakeQueue, getPackage, seedPackage, seedUser } from "./poll-helpers.js";

// Rate limiting, detection and push belong to other modules, so they are
// injected fakes. Auth is real: session and API token rows in D1.
const rate = { allowed: true };
const notify = vi.fn(async () => 0);
const deps: ImportDeps = {
  takeToken: async () => (rate.allowed ? { allowed: true, retryAfterSec: 0 } : { allowed: false, retryAfterSec: 17 }),
  normalizeNumber: (raw) => raw.trim().replace(/[\s-]+/g, "").toUpperCase(),
  detectCarrier: (n) => (n.startsWith("1Z") ? [{ carrier: "ups" }] : n.startsWith("TBA") ? [{ carrier: "amazon" }] : []),
  notify,
  now: () => Date.now(),
};

const router = new Router();
register(router, deps);

let queue: ReturnType<typeof fakeQueue>;
let testEnv: Env;
beforeEach(() => {
  rate.allowed = true;
  notify.mockClear();
  queue = fakeQueue();
  testEnv = { ...env, TRACK_QUEUE: queue } as Env;
});

async function bearer(userId: string, kind: "session" | "token"): Promise<string> {
  if (kind === "session") return createSession(env, userId, null, Date.now());
  const token = `plt_${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO api_tokens (id, token_hash, user_id, label, scopes, created_at) VALUES (?, ?, ?, 'Flint', 'imports:write', ?)",
  )
    .bind(crypto.randomUUID(), await sha256Hex(token), userId, Date.now())
    .run();
  return token;
}

async function post(path: string, body: unknown, userId: string | null, kind: "session" | "token" = "session") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (userId) headers.authorization = `Bearer ${await bearer(userId, kind)}`;
  const req = new Request(`https://porchlight.test${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const res = await router.handle(req, testEnv, {} as ExecutionContext);
    if (!res) throw new Error("route not registered");
    return res;
  } catch (err) {
    // Same conversion src/index.ts applies.
    if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, { ...err.headers }, err.details);
    throw err;
  }
}

async function results(res: Response): Promise<ImportResponse["results"]> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; data: ImportResponse };
  expect(body.ok).toBe(true);
  return body.data.results;
}

function flintItem(over: Record<string, unknown> = {}) {
  return {
    trackingNumber: "1z 999aa1 0123456784",
    carrier: "ups",
    merchant: "Etsy",
    subject: "Your order has shipped",
    messageDate: "2026-11-08T15:00:00.000Z",
    dedupeKey: `<${crypto.randomUUID()}@mail.example.com>`,
    ...over,
  };
}

function amazonItem(over: Record<string, unknown> = {}) {
  return {
    orderId: "112-1234567-1234567",
    shipmentId: `D${crypto.randomUUID().slice(0, 6)}`,
    carrier: "amazon",
    trackingNumber: `TBA${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`,
    title: "USB-C cable",
    items: [{ name: "USB-C cable", imageUrl: "https://m.media-amazon.com/images/I/x.jpg", quantity: 2 }],
    etaStart: "2026-11-09T00:00:00.000Z",
    etaEnd: "2026-11-09T23:59:59.000Z",
    ...over,
  };
}

const observed = {
  status: "out_for_delivery",
  statusDetail: "Out for delivery",
  observedAt: "2026-11-08T14:00:00.000Z",
  deliveredAt: null,
  events: [
    { occurredAt: "2026-11-08T13:05:00.000Z", status: "out_for_delivery", description: "Out for delivery", location: "San Jose, CA" },
    { occurredAt: "2026-11-07T20:00:00.000Z", status: "in_transit", description: "Arrived at station", location: null },
  ],
};

describe("POST /v1/imports/flint", () => {
  it("creates a package, records the import and queues a first check", async () => {
    const userId = await seedUser(env);
    const item = flintItem();
    const [r] = await results(await post("/v1/imports/flint", { items: [item] }, userId, "token"));
    expect(r).toMatchObject({ dedupeKey: item.dedupeKey, outcome: "created" });
    const row = await getPackage(env, r!.packageId!);
    expect(row).toMatchObject({
      carrier: "ups",
      tracking_number: "1Z999AA10123456784",
      title: "Your order has shipped",
      merchant: "Etsy",
      source: "flint",
      status: "unknown",
    });
    expect(row.next_check_at).not.toBeNull();
    expect(queue.sent).toEqual([expect.objectContaining({ packageId: r!.packageId, userId, reason: "import" })]);
    const imp = await env.DB.prepare("SELECT package_id FROM imports WHERE user_id = ? AND source = 'flint' AND dedupe_key = ?")
      .bind(userId, item.dedupeKey)
      .first<{ package_id: string }>();
    expect(imp?.package_id).toBe(r!.packageId);
  });

  it("is idempotent per dedupeKey and never overwrites an edited title", async () => {
    const userId = await seedUser(env);
    const item = flintItem();
    const [first] = await results(await post("/v1/imports/flint", { items: [item] }, userId));
    await env.DB.prepare("UPDATE packages SET title = 'My shoes' WHERE id = ?").bind(first!.packageId).run();
    const [again] = await results(await post("/v1/imports/flint", { items: [{ ...item, subject: "Shipped again" }] }, userId));
    expect(again).toEqual({ dedupeKey: item.dedupeKey, packageId: first!.packageId, outcome: "unchanged" });
    expect((await getPackage(env, first!.packageId!)).title).toBe("My shoes");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM packages WHERE user_id = ?").bind(userId).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("attaches to an existing package with the same carrier and number", async () => {
    const userId = await seedUser(env);
    const existing = await seedPackage(env, { userId, carrier: "ups", trackingNumber: "1Z999AA10123456784", title: null });
    const [r] = await results(await post("/v1/imports/flint", { items: [flintItem()] }, userId));
    expect(r).toMatchObject({ packageId: existing, outcome: "updated" });
    const row = await getPackage(env, existing);
    expect(row.title).toBe("Your order has shipped");
    expect(row.source).toBe("manual");
  });

  it("detects the carrier when it is missing and falls back to other", async () => {
    const userId = await seedUser(env);
    const res = await post(
      "/v1/imports/flint",
      { items: [flintItem({ carrier: undefined }), flintItem({ carrier: undefined, trackingNumber: "XYZ12345678" })] },
      userId,
    );
    const [a, b] = await results(res);
    expect((await getPackage(env, a!.packageId!)).carrier).toBe("ups");
    expect((await getPackage(env, b!.packageId!)).carrier).toBe("other");
  });

  it("rejects bad items one by one without failing the rest", async () => {
    const userId = await seedUser(env);
    const good = flintItem();
    const res = await post(
      "/v1/imports/flint",
      {
        items: [
          flintItem({ dedupeKey: "<bad-carrier@x>", carrier: "pigeon" }),
          good,
          flintItem({ dedupeKey: "<bad-number@x>", trackingNumber: "  -- " }),
          flintItem({ dedupeKey: "<extra@x>", body: "mail body must never be sent" }),
          flintItem({ dedupeKey: "<date@x>", messageDate: "yesterday" }),
        ],
      },
      userId,
    );
    const rs = await results(res);
    expect(rs.map((r) => r.outcome)).toEqual(["rejected", "created", "rejected", "rejected", "rejected"]);
    for (const r of rs.filter((x) => x.outcome === "rejected")) {
      expect(r.packageId).toBeNull();
      expect(r.reason).toEqual(expect.any(String));
    }
    expect(rs[0]!.dedupeKey).toBe("<bad-carrier@x>");
  });

  it("does not resurrect a package the user deleted", async () => {
    const userId = await seedUser(env);
    await seedPackage(env, { userId, carrier: "ups", trackingNumber: "1Z999AA10123456784", deletedAt: Date.now() });
    const [r] = await results(await post("/v1/imports/flint", { items: [flintItem()] }, userId));
    expect(r).toMatchObject({ outcome: "rejected", packageId: null, reason: "deleted" });
  });

  it("answers 400 for an empty, oversized or malformed request", async () => {
    const userId = await seedUser(env);
    expect((await post("/v1/imports/flint", { items: [] }, userId)).status).toBe(400);
    const many = Array.from({ length: 101 }, () => flintItem());
    expect((await post("/v1/imports/flint", { items: many }, userId)).status).toBe(400);
    expect((await post("/v1/imports/flint", { items: [flintItem()], extra: 1 }, userId)).status).toBe(400);
    expect((await post("/v1/imports/flint", [flintItem()], userId)).status).toBe(400);
  });

  it("requires credentials and answers 429 when the per-user bucket is empty", async () => {
    expect((await post("/v1/imports/flint", { items: [flintItem()] }, null)).status).toBe(401);
    rate.allowed = false;
    const userId = await seedUser(env);
    const res = await post("/v1/imports/flint", { items: [flintItem()] }, userId);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
  });
});

describe("POST /v1/imports/amazon", () => {
  it("creates a package with items, order id and Amazon's ETA, keyed by order:shipment", async () => {
    const userId = await seedUser(env);
    const item = amazonItem({ carrier: "ups", trackingNumber: "1Z999AA10000000001" });
    const [r] = await results(await post("/v1/imports/amazon", { items: [item] }, userId));
    expect(r).toMatchObject({ dedupeKey: `${item.orderId}:${item.shipmentId}`, outcome: "created" });
    const row = await getPackage(env, r!.packageId!);
    expect(row).toMatchObject({
      source: "amazon",
      order_id: "112-1234567-1234567",
      title: "USB-C cable",
      eta_start: Date.parse("2026-11-09T00:00:00.000Z"),
      eta_end: Date.parse("2026-11-09T23:59:59.000Z"),
    });
    const items = await env.DB.prepare("SELECT name, image_url, quantity FROM package_items WHERE package_id = ?")
      .bind(r!.packageId)
      .all();
    expect(items.results).toEqual([{ name: "USB-C cable", image_url: "https://m.media-amazon.com/images/I/x.jpg", quantity: 2 }]);
    expect(queue.sent).toHaveLength(1);
  });

  it("replaces items and ETA on re-import, and reports unchanged when nothing changed", async () => {
    const userId = await seedUser(env);
    const item = amazonItem();
    const [first] = await results(await post("/v1/imports/amazon", { items: [item] }, userId));
    const [same] = await results(await post("/v1/imports/amazon", { items: [item] }, userId));
    expect(same).toMatchObject({ packageId: first!.packageId, outcome: "unchanged" });
    const next = { ...item, etaStart: "2026-11-10T00:00:00.000Z", items: [{ name: "Charger", imageUrl: null, quantity: 1 }] };
    const [upd] = await results(await post("/v1/imports/amazon", { items: [next] }, userId));
    expect(upd).toMatchObject({ packageId: first!.packageId, outcome: "updated" });
    const row = await getPackage(env, first!.packageId!);
    expect(row.eta_start).toBe(Date.parse("2026-11-10T00:00:00.000Z"));
    const items = await env.DB.prepare("SELECT name FROM package_items WHERE package_id = ?").bind(first!.packageId).all();
    expect(items.results).toEqual([{ name: "Charger" }]);
  });

  it("takes a date-only Amazon ETA when etaDateOnly is true, and refuses dates that don't match the flag", async () => {
    const userId = await seedUser(env);
    const item = amazonItem({ etaStart: "2026-11-09", etaEnd: "2026-11-10", etaDateOnly: true });
    const [r] = await results(await post("/v1/imports/amazon", { items: [item] }, userId));
    expect(r?.outcome).toBe("created");
    const row = (await getPackage(env, r!.packageId!)) as unknown as { eta_start: number; eta_end: number; eta_date_only: number };
    expect([row.eta_start, row.eta_end, row.eta_date_only]).toEqual([Date.UTC(2026, 10, 9), Date.UTC(2026, 10, 10), 1]);

    // Switching to a timed window on re-import clears the flag.
    const [upd] = await results(await post("/v1/imports/amazon", { items: [{ ...item, etaStart: "2026-11-09T17:00:00.000Z", etaEnd: "2026-11-10T01:00:00.000Z", etaDateOnly: false }] }, userId));
    expect(upd?.outcome).toBe("updated");
    expect(((await getPackage(env, r!.packageId!)) as unknown as { eta_date_only: number }).eta_date_only).toBe(0);

    const bad = await results(
      await post(
        "/v1/imports/amazon",
        { items: [amazonItem({ etaStart: "2026-11-09T00:00:00.000Z", etaEnd: null, etaDateOnly: true }), amazonItem({ etaStart: "2026-11-09", etaEnd: null })] },
        userId,
      ),
    );
    expect(bad.map((b) => b.outcome)).toEqual(["rejected", "rejected"]);
    expect(bad[0]?.reason).toMatch(/^etaStart/);
  });

  it("applies device-observed TBA status and events, deduped, and pushes the transition", async () => {
    const userId = await seedUser(env);
    const item = amazonItem({ observed });
    const [r] = await results(await post("/v1/imports/amazon", { items: [item] }, userId));
    const id = r!.packageId!;
    let row = await getPackage(env, id);
    expect(row.status).toBe("out_for_delivery");
    expect(row.status_detail).toBe("Out for delivery");
    expect(row.last_checked_at).toBe(Date.parse(observed.observedAt));
    expect(await countEvents(env, id)).toBe(2);
    expect(notify).toHaveBeenCalledWith(testEnv, expect.objectContaining({ packageId: id, status: "out_for_delivery", statusChanged: true }));
    const src = await env.DB.prepare("SELECT last_source FROM packages WHERE id = ?").bind(id).first<{ last_source: string }>();
    expect(src?.last_source).toBe("amazon");

    // Same observation again: no new events; older observation: ignored.
    await post("/v1/imports/amazon", { items: [item] }, userId);
    const older = { ...observed, status: "in_transit", observedAt: "2026-11-08T10:00:00.000Z" };
    await post("/v1/imports/amazon", { items: [{ ...item, observed: older }] }, userId);
    row = await getPackage(env, id);
    expect(row.status).toBe("out_for_delivery");
    expect(await countEvents(env, id)).toBe(2);

    const delivered = {
      ...observed,
      status: "delivered",
      statusDetail: "Delivered",
      observedAt: "2026-11-08T19:00:00.000Z",
      deliveredAt: "2026-11-08T18:40:00.000Z",
      events: [{ occurredAt: "2026-11-08T18:40:00.000Z", status: "delivered", description: "Delivered", location: null }, ...observed.events],
    };
    const [d] = await results(await post("/v1/imports/amazon", { items: [{ ...item, observed: delivered }] }, userId));
    expect(d!.outcome).toBe("updated");
    row = await getPackage(env, id);
    expect(row).toMatchObject({ status: "delivered", delivered_at: Date.parse("2026-11-08T18:40:00.000Z"), next_check_at: null });
    expect(await countEvents(env, id)).toBe(3);
  });

  it("does not queue a carrier check for a package Amazon already shows delivered", async () => {
    const userId = await seedUser(env);
    const delivered = { ...observed, status: "delivered", deliveredAt: "2026-11-08T13:30:00.000Z" };
    await results(await post("/v1/imports/amazon", { items: [amazonItem({ observed: delivered })] }, userId));
    expect(queue.sent).toHaveLength(0);
  });

  it("validates items strictly", async () => {
    const userId = await seedUser(env);
    const rs = await results(
      await post(
        "/v1/imports/amazon",
        {
          items: [
            amazonItem({ items: [{ name: "x", imageUrl: "javascript:alert(1)", quantity: 1 }] }),
            amazonItem({ items: [{ name: "x", imageUrl: null, quantity: 0 }] }),
            amazonItem({ observed: { ...observed, status: "teleported" } }),
            amazonItem({ observed: { ...observed, observedAt: "2099-01-01T00:00:00.000Z" } }),
            amazonItem({ etaStart: "soon" }),
          ],
        },
        userId,
      ),
    );
    expect(rs.map((r) => r.outcome)).toEqual(["rejected", "rejected", "rejected", "rejected", "rejected"]);
  });

  it("accepts sessions only, not API tokens", async () => {
    const userId = await seedUser(env);
    expect((await post("/v1/imports/amazon", { items: [amazonItem()] }, userId, "token")).status).toBe(401);
  });
});

// A D1 wrapper that runs `after` once each write statement or batch commits,
// so a test can look at what a concurrent sync would have seen at that moment.
function observedDb(db: D1Database, after: (sql: string[]) => Promise<void>): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const sqlOf = new WeakMap<object, string>();
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const w = {
      bind: (...args: unknown[]) => wrap(stmt.bind(...args), sql),
      first: (col?: string) => (col === undefined ? stmt.first() : stmt.first(col)),
      all: () => stmt.all(),
      raw: () => stmt.raw(),
      run: async () => {
        const r = await stmt.run();
        await after([sql]);
        return r;
      },
    } as unknown as D1PreparedStatement;
    real.set(w, stmt);
    sqlOf.set(w, sql);
    return w;
  };
  return {
    prepare: (sql: string) => wrap(db.prepare(sql), sql),
    batch: async (stmts: D1PreparedStatement[]) => {
      const r = await db.batch(stmts.map((s) => real.get(s) ?? s));
      await after(stmts.map((s) => sqlOf.get(s) ?? ""));
      return r;
    },
  } as unknown as D1Database;
}

describe("POST /v1/imports/amazon sync visibility", () => {
  it("never shows a new package without its items at an updated_at a later sync would not re-send", async () => {
    const userId = await seedUser(env);
    const item = amazonItem();
    const seen: { updatedAt: number; items: number }[] = [];
    const snapshot = async () => {
      const row = await env.DB.prepare(
        "SELECT p.updated_at AS u, (SELECT COUNT(*) FROM package_items WHERE package_id = p.id) AS n FROM packages p WHERE user_id = ?",
      )
        .bind(userId)
        .first<{ u: number; n: number }>();
      if (row) seen.push({ updatedAt: row.u, items: row.n });
    };
    testEnv = { ...testEnv, DB: observedDb(env.DB, snapshot) } as Env;
    const [r] = await results(await post("/v1/imports/amazon", { items: [item] }, userId));
    expect(r?.outcome).toBe("created");
    const final = await getPackage(env, r?.packageId ?? "");
    for (const s of seen) {
      // A sync that saw this state would hold cursor >= s.updatedAt; it only
      // re-sends the package if updated_at moved past that.
      if (s.items !== 1) expect(final.updated_at).toBeGreaterThan(s.updatedAt);
    }
  });
});
