import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { randomToken, sha256Hex } from "../src/lib/auth.js";
import { errorResponse, HttpError } from "../src/lib/http.js";
import { Router } from "../src/lib/router.js";
import type { TrackJob } from "../src/poll/types.js";
import * as packageRoutes from "../src/routes/packages.js";

let queued: TrackJob[] = [];
const fakeQueue = { send: async (m: TrackJob) => void (queued = [...queued, m]) } as unknown as Queue<TrackJob>;
const testEnv = { ...env, TRACK_QUEUE: fakeQueue } as Env;
beforeEach(() => {
  queued = [];
});

// Mirrors src/index.ts error handling with only the routes under test.
const router = new Router();
packageRoutes.register(router);
async function call(method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request(`https://porchlight.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = createExecutionContext();
  try {
    return (await router.handle(req, testEnv, ctx)) ?? errorResponse(404, "not_found", "No such endpoint");
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, { ...err.headers }, err.details);
    throw err;
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<any> => res.json();

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

const UPS = "1Z999AA10123456784";
const putPkg = (token: string, id: string, b: unknown) => call("PUT", `/v1/packages/${id}`, token, b);

describe("PUT /v1/packages/:id", () => {
  it("creates with a normalized number, detected carrier and an immediate first check", async () => {
    const { token, userId } = await newUser();
    const id = crypto.randomUUID();
    const before = Date.now();
    const res = await putPkg(token, id, { trackingNumber: " 1z999 aa1-0123456784 ", title: "Headphones" });
    expect(res.status).toBe(201);
    const pkg = (await body(res)).data;
    expect(pkg).toMatchObject({
      id, carrier: "ups", trackingNumber: UPS, title: "Headphones", merchant: null, orderId: null, source: "manual",
      status: "unknown", statusDetail: null, etaStart: null, deliveredAt: null, lastCheckedAt: null, archivedAt: null, items: [],
    });
    const row = await env.DB.prepare("SELECT next_check_at, user_id FROM packages WHERE id = ?").bind(id).first<{ next_check_at: number; user_id: string }>();
    expect(row?.user_id).toBe(userId);
    expect(row?.next_check_at).toBeGreaterThanOrEqual(before);
    expect(row?.next_check_at).toBeLessThanOrEqual(Date.now());
  });

  it("falls back to carrier other and keeps an explicit carrier and source", async () => {
    const { token } = await newUser();
    const a = await body(await putPkg(token, crypto.randomUUID(), { trackingNumber: "NOPE" }));
    expect(a.data.carrier).toBe("other");
    const b = await body(await putPkg(token, crypto.randomUUID(), { trackingNumber: "123", carrier: "jitsu", source: "share" }));
    expect(b.data).toMatchObject({ carrier: "jitsu", source: "share" });
  });

  it("is idempotent and does not bump updatedAt when nothing changes", async () => {
    const { token } = await newUser();
    const id = crypto.randomUUID();
    const first = await body(await putPkg(token, id, { trackingNumber: UPS }));
    const again = await putPkg(token, id, { trackingNumber: UPS });
    expect(again.status).toBe(200);
    expect((await body(again)).data).toEqual(first.data);
  });

  it("updates only fields sent, archives and unarchives, ignores server-owned fields", async () => {
    const { token } = await newUser();
    const id = crypto.randomUUID();
    const created = (await body(await putPkg(token, id, { trackingNumber: UPS, title: "A", merchant: "M" }))).data;
    const upd = (await body(await putPkg(token, id, { title: "B", archived: true, status: "delivered", source: "share" }))).data;
    expect(upd).toMatchObject({ title: "B", merchant: "M", status: "unknown", source: "manual" });
    expect(upd.archivedAt).not.toBeNull();
    expect(Date.parse(upd.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
    const un = (await body(await putPkg(token, id, { archived: false, merchant: null }))).data;
    expect(un).toMatchObject({ archivedAt: null, merchant: null, title: "B" });
  });

  it("resets tracking state when the carrier changes", async () => {
    const { token } = await newUser();
    const id = crypto.randomUUID();
    await putPkg(token, id, { trackingNumber: "123456789012", carrier: "fedex" });
    await env.DB.batch([
      env.DB.prepare("UPDATE packages SET status = 'in_transit', next_check_at = NULL WHERE id = ?").bind(id),
      env.DB.prepare("INSERT INTO events (id, package_id, occurred_at, status, description, raw_hash) VALUES (?, ?, 1, 'in_transit', 'x', 'h')").bind(crypto.randomUUID(), id),
    ]);
    const upd = (await body(await putPkg(token, id, { carrier: "ups" }))).data;
    expect(upd).toMatchObject({ carrier: "ups", status: "unknown" });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE package_id = ?").bind(id).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("answers 409 duplicate with existingId", async () => {
    const { token } = await newUser();
    const first = crypto.randomUUID();
    await putPkg(token, first, { trackingNumber: UPS, carrier: "ups" });
    const res = await putPkg(token, crypto.randomUUID(), { trackingNumber: UPS.toLowerCase(), carrier: "ups" });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toMatchObject({ code: "conflict", details: { reason: "duplicate", existingId: first } });
  });

  it("answers 404 for another user's id and 400 for bad input", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const id = crypto.randomUUID();
    await putPkg(alice.token, id, { trackingNumber: UPS });
    expect((await putPkg(bob.token, id, { title: "mine" })).status).toBe(404);
    expect((await putPkg(bob.token, "nope", { trackingNumber: UPS })).status).toBe(400);
    expect((await putPkg(bob.token, crypto.randomUUID(), { title: "no number" })).status).toBe(400);
    expect((await putPkg(bob.token, crypto.randomUUID(), { trackingNumber: UPS, source: "amazon" })).status).toBe(400);
    expect((await putPkg(bob.token, crypto.randomUUID(), { trackingNumber: " - " })).status).toBe(400);
    expect((await putPkg("", crypto.randomUUID(), { trackingNumber: UPS })).status).toBe(401);
  });
});

describe("DELETE /v1/packages/:id", () => {
  it("leaves a tombstone, removes items and events, and is repeatable", async () => {
    const { token } = await newUser();
    const id = crypto.randomUUID();
    await putPkg(token, id, { trackingNumber: UPS });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO package_items (package_id, name) VALUES (?, 'x')").bind(id),
      env.DB.prepare("INSERT INTO events (id, package_id, occurred_at, status, description, raw_hash) VALUES (?, ?, 1, 'in_transit', 'x', 'h')").bind(crypto.randomUUID(), id),
    ]);
    const res = await call("DELETE", `/v1/packages/${id}`, token);
    expect(res.status).toBe(200);
    const del = (await body(res)).data;
    expect(del.id).toBe(id);
    expect((await body(await call("DELETE", `/v1/packages/${id}`, token))).data).toEqual(del);
    const left = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM events WHERE package_id = ?1) + (SELECT COUNT(*) FROM package_items WHERE package_id = ?1) AS n, (SELECT deleted_at FROM packages WHERE id = ?1) AS d",
    ).bind(id).first<{ n: number; d: number }>();
    expect(left).toMatchObject({ n: 0 });
    expect(new Date(left?.d ?? 0).toISOString()).toBe(del.deletedAt);
  });

  it("refuses to reuse a deleted id but lets the number be added again", async () => {
    const { token } = await newUser();
    const id = crypto.randomUUID();
    await putPkg(token, id, { trackingNumber: UPS });
    await call("DELETE", `/v1/packages/${id}`, token);
    const reuse = await putPkg(token, id, { trackingNumber: UPS });
    expect(reuse.status).toBe(409);
    expect((await body(reuse)).error.details).toEqual({ reason: "deleted" });
    expect((await putPkg(token, crypto.randomUUID(), { trackingNumber: UPS })).status).toBe(201);
  });

  it("answers 404 for unknown or foreign packages", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const id = crypto.randomUUID();
    await putPkg(alice.token, id, { trackingNumber: UPS });
    expect((await call("DELETE", `/v1/packages/${id}`, bob.token)).status).toBe(404);
    expect((await call("DELETE", `/v1/packages/${crypto.randomUUID()}`, bob.token)).status).toBe(404);
  });
});

describe("POST /v1/packages/:id/refresh", () => {
  it("queues a manual check once per 2 minutes", async () => {
    const { token, userId } = await newUser();
    const id = crypto.randomUUID();
    await putPkg(token, id, { trackingNumber: UPS });
    const before = Date.now();
    const res = await call("POST", `/v1/packages/${id}/refresh`, token);
    expect(res.status).toBe(202);
    const data = (await body(res)).data;
    expect(data.queued).toBe(true);
    expect(Date.parse(data.nextAllowedAt) - before).toBeGreaterThanOrEqual(120_000);
    expect(queued).toEqual([{ packageId: id, userId, reason: "manual", enqueuedAt: expect.any(Number) }]);

    const again = await call("POST", `/v1/packages/${id}/refresh`, token);
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(100);
    expect(queued).toHaveLength(1);
  });

  it("answers 404 for deleted or foreign packages", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const id = crypto.randomUUID();
    await putPkg(alice.token, id, { trackingNumber: UPS });
    expect((await call("POST", `/v1/packages/${id}/refresh`, bob.token)).status).toBe(404);
    await call("DELETE", `/v1/packages/${id}`, alice.token);
    expect((await call("POST", `/v1/packages/${id}/refresh`, alice.token)).status).toBe(404);
    expect(queued).toHaveLength(0);
  });
});
