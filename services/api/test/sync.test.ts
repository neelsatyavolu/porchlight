import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { randomToken, sha256Hex } from "../src/lib/auth.js";
import { errorResponse, HttpError } from "../src/lib/http.js";
import { Router } from "../src/lib/router.js";
import * as packageRoutes from "../src/routes/packages.js";
import * as syncRoutes from "../src/routes/sync.js";

// Mirrors src/index.ts error handling with only the routes under test.
const router = new Router();
syncRoutes.register(router);
packageRoutes.register(router);
async function call(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`https://porchlight.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = createExecutionContext();
  try {
    return (await router.handle(req, env, ctx)) ?? errorResponse(404, "not_found", "No such endpoint");
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, { ...err.headers }, err.details);
    throw err;
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = async (res: Response): Promise<any> => {
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: unknown }).data;
};

async function newUser(): Promise<{ token: string; userId: string }> {
  const userId = crypto.randomUUID();
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").bind(userId, now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(token), userId, now, now),
  ]);
  return { token, userId };
}

const sync = (token: string, since?: string) =>
  call("GET", since === undefined ? "/v1/sync" : `/v1/sync?since=${encodeURIComponent(since)}`, token);
const add = async (token: string, n: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const id = crypto.randomUUID();
  const res = await call("PUT", `/v1/packages/${id}`, token, { trackingNumber: n, carrier: "ups", ...extra });
  expect(res.status).toBe(201);
  return id;
};

describe("GET /v1/sync", () => {
  it("full sync returns every live package with items and events, nothing else", async () => {
    const me = await newUser();
    const other = await newUser();
    const a = await add(me.token, "AAA1", { title: "A" });
    const b = await add(me.token, "BBB2", { archived: true });
    const gone = await add(me.token, "CCC3");
    await add(other.token, "AAA1");
    await call("DELETE", `/v1/packages/${gone}`, me.token);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO package_items (package_id, name, image_url, quantity) VALUES (?, 'Cable', NULL, 2)").bind(a),
      env.DB.prepare("INSERT INTO events (id, package_id, occurred_at, status, description, location, raw_hash) VALUES ('e1', ?, ?, 'in_transit', 'Departed', 'Oakland, CA', 'h1')").bind(a, Date.UTC(2026, 10, 8, 9)),
      env.DB.prepare("INSERT INTO events (id, package_id, occurred_at, status, description, location, raw_hash) VALUES ('e2', ?, ?, 'label_created', 'Label', NULL, 'h2')").bind(a, Date.UTC(2026, 10, 7)),
    ]);

    const res = await data(await sync(me.token));
    expect(res.packages.map((p: { id: string }) => p.id).sort()).toEqual([a, b].sort());
    expect(res.deleted).toEqual([]);
    expect(res.hasMore).toBe(false);
    const pa = res.packages.find((p: { id: string }) => p.id === a);
    expect(pa.items).toEqual([{ name: "Cable", imageUrl: null, quantity: 2 }]);
    expect(res.packages.find((p: { id: string }) => p.id === b).archivedAt).not.toBeNull();
    expect(res.events).toEqual([
      { id: "e1", packageId: a, occurredAt: "2026-11-08T09:00:00.000Z", status: "in_transit", description: "Departed", location: "Oakland, CA" },
      { id: "e2", packageId: a, occurredAt: "2026-11-07T00:00:00.000Z", status: "label_created", description: "Label", location: null },
    ]);
  });

  it("delta sync returns only changes since the cursor, with tombstones", async () => {
    const me = await newUser();
    const a = await add(me.token, "D1");
    const b = await add(me.token, "D2");
    const c = await add(me.token, "D3");
    const first = await data(await sync(me.token));

    const empty = await data(await sync(me.token, first.cursor));
    expect(empty).toMatchObject({ packages: [], events: [], deleted: [], cursor: first.cursor, hasMore: false });

    await call("PUT", `/v1/packages/${b}`, me.token, { title: "renamed" });
    await call("DELETE", `/v1/packages/${c}`, me.token);
    const delta = await data(await sync(me.token, first.cursor));
    expect(delta.packages.map((p: { id: string; title: string }) => [p.id, p.title])).toEqual([[b, "renamed"]]);
    expect(delta.deleted).toEqual([c]);

    const after = await data(await sync(me.token, delta.cursor));
    expect(after.packages).toEqual([]);
    expect(a).toBeDefined();
  });

  it("pages 200 at a time with a stable cursor", async () => {
    const me = await newUser();
    const base = Date.now();
    const stmts = Array.from({ length: 205 }, (_, i) =>
      env.DB.prepare("INSERT INTO packages (id, user_id, carrier, tracking_number, source, updated_at) VALUES (?, ?, 'ups', ?, 'manual', ?)")
        .bind(crypto.randomUUID(), me.userId, `N${i}`, base + (i % 3)),
    );
    await env.DB.batch(stmts);
    const p1 = await data(await sync(me.token));
    expect(p1.packages).toHaveLength(200);
    expect(p1.hasMore).toBe(true);
    const p2 = await data(await sync(me.token, p1.cursor));
    expect(p2.packages).toHaveLength(5);
    expect(p2.hasMore).toBe(false);
    const all = new Set([...p1.packages, ...p2.packages].map((p: { id: string }) => p.id));
    expect(all.size).toBe(205);
  });

  it("rejects a malformed cursor with 400", async () => {
    const me = await newUser();
    for (const bad of ["garbage!", btoa("x:y"), "Zm9v"]) {
      const res = await sync(me.token, bad);
      expect(res.status).toBe(400);
    }
  });

  it("requires a session", async () => {
    expect((await call("GET", "/v1/sync", "bogus")).status).toBe(401);
  });
});
