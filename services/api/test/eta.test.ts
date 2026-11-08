// The ETA contract (docs/API.md "Packages"): etaDateOnly with calendar dates,
// or instants. Covers the poller, sync, GET /v1/packages/:id and the
// 0002 backfill.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { CarrierAdapter, TrackResult } from "@porchlight/carriers";
import { describe, expect, it, vi } from "vitest";
import { createSession } from "../src/lib/auth.js";
import { errorResponse, HttpError } from "../src/lib/http.js";
import { Router } from "../src/lib/router.js";
import { processJob, type ConsumeDeps } from "../src/poll/consume.js";
import * as packageRoutes from "../src/routes/packages.js";
import * as syncRoutes from "../src/routes/sync.js";
import { getPackage, seedPackage, seedUser } from "./poll-helpers.js";

const NOW = Date.parse("2026-11-08T18:00:00.000Z");
const DAY = 86_400_000;

const router = new Router();
syncRoutes.register(router);
packageRoutes.register(router);

async function call(method: string, path: string, token: string): Promise<Response> {
  const req = new Request(`https://porchlight.test${path}`, { method, headers: { authorization: `Bearer ${token}` } });
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
const data = async (res: Response): Promise<any> => ((await res.json()) as { data: unknown }).data;

function result(over: Partial<TrackResult>): TrackResult {
  return { status: "in_transit", statusDetail: "Departed", etaStart: null, etaEnd: null, etaDateOnly: false, deliveredAt: null, events: [], ...over };
}

function deps(r: TrackResult): ConsumeDeps {
  const adapter: CarrierAdapter = { id: "ups", supports: () => true, track: async () => r };
  return {
    adaptersFor: () => [adapter],
    takeToken: async () => ({ allowed: true, retryAfterSec: 0 }),
    fetch: (async () => new Response("unexpected live call", { status: 599 })) as typeof fetch,
    now: () => NOW,
    notify: vi.fn(async () => 0),
  };
}

async function tracked(r: TrackResult): Promise<{ userId: string; id: string; token: string }> {
  const userId = await seedUser(env);
  const id = await seedPackage(env, { userId, status: "label_created", updatedAt: NOW - DAY });
  await processJob({ packageId: id, userId, reason: "scheduled", enqueuedAt: NOW }, env, deps(r));
  return { userId, id, token: await createSession(env, userId, null, NOW) };
}

const etaRow = async (id: string) => {
  const row = (await getPackage(env, id)) as unknown as { eta_start: number | null; eta_end: number | null; eta_date_only: number };
  return [row.eta_start, row.eta_end, row.eta_date_only];
};

describe("poller ETA storage", () => {
  it("stores a date-only ETA as 00:00 UTC of the date with the flag set", async () => {
    const { id } = await tracked(result({ etaStart: "2026-11-10", etaEnd: "2026-11-11", etaDateOnly: true }));
    expect(await etaRow(id)).toEqual([Date.UTC(2026, 10, 10), Date.UTC(2026, 10, 11), 1]);
  });

  it("stores instants as instants", async () => {
    const { id } = await tracked(result({ etaStart: "2026-11-10T10:00:00-08:00", etaEnd: "2026-11-10T14:00:00-08:00" }));
    expect(await etaRow(id)).toEqual([Date.parse("2026-11-10T18:00:00Z"), Date.parse("2026-11-10T22:00:00Z"), 0]);
  });

  it("keeps the stored ETA and its flag when the carrier gives none, and clears both on delivery", async () => {
    const { id, userId } = await tracked(result({ etaStart: "2026-11-10", etaEnd: "2026-11-10", etaDateOnly: true }));
    const job = { packageId: id, userId, reason: "manual" as const, enqueuedAt: NOW };
    await processJob(job, env, deps(result({})));
    expect(await etaRow(id)).toEqual([Date.UTC(2026, 10, 10), Date.UTC(2026, 10, 10), 1]);
    await processJob(job, env, deps(result({ status: "delivered", deliveredAt: "2026-11-10T20:00:00Z" })));
    expect(await etaRow(id)).toEqual([null, null, 0]);
  });

  it("counts a change of the flag alone as a change", async () => {
    const { id, userId } = await tracked(result({ etaStart: "2026-11-10T00:00:00Z", etaEnd: "2026-11-10T00:00:00Z" }));
    const before = (await getPackage(env, id)).updated_at;
    const job = { packageId: id, userId, reason: "manual" as const, enqueuedAt: NOW };
    await processJob(job, env, deps(result({ etaStart: "2026-11-10", etaEnd: "2026-11-10", etaDateOnly: true })));
    expect((await etaRow(id))[2]).toBe(1);
    expect((await getPackage(env, id)).updated_at).toBeGreaterThan(before);
  });
});

describe("ETA on the wire", () => {
  it("sync sends calendar dates with etaDateOnly true, never shifted by time zone", async () => {
    const { token, id } = await tracked(result({ etaStart: "2026-11-10", etaEnd: "2026-11-12", etaDateOnly: true }));
    const sync = await data(await call("GET", "/v1/sync", token));
    expect(sync.packages.find((p: { id: string }) => p.id === id)).toMatchObject({
      etaStart: "2026-11-10",
      etaEnd: "2026-11-12",
      etaDateOnly: true,
    });
  });

  it("sync sends instants as ISO 8601 UTC with etaDateOnly false", async () => {
    const { token, id } = await tracked(result({ etaStart: "2026-11-10T10:00:00-08:00", etaEnd: "2026-11-10T14:00:00-08:00" }));
    const [pkg] = (await data(await call("GET", "/v1/sync", token))).packages.filter((p: { id: string }) => p.id === id);
    expect(pkg).toMatchObject({ etaStart: "2026-11-10T18:00:00.000Z", etaEnd: "2026-11-10T22:00:00.000Z", etaDateOnly: false });
  });

  it("sends etaDateOnly false and null bounds when there is no ETA", async () => {
    const { token, id } = await tracked(result({}));
    const [pkg] = (await data(await call("GET", "/v1/sync", token))).packages.filter((p: { id: string }) => p.id === id);
    expect(pkg).toMatchObject({ etaStart: null, etaEnd: null, etaDateOnly: false });
  });
});

describe("GET /v1/packages/:id", () => {
  it("returns one package with its items and events, newest event first", async () => {
    const events = [
      { occurredAt: "2026-11-08T09:12:00.000Z", status: "in_transit" as const, description: "Departed", location: "Oakland, CA" },
      { occurredAt: "2026-11-07T20:00:00.000Z", status: "label_created" as const, description: "Label created", location: null },
    ];
    const { token, id } = await tracked(result({ events, etaStart: "2026-11-10", etaEnd: "2026-11-10", etaDateOnly: true }));
    await env.DB.prepare("INSERT INTO package_items (package_id, name, image_url, quantity) VALUES (?, 'Cable', NULL, 2)").bind(id).run();
    const res = await call("GET", `/v1/packages/${id.toUpperCase()}`, token);
    expect(res.status).toBe(200);
    const body = await data(res);
    expect(Object.keys(body).sort()).toEqual(["events", "package"]);
    expect(body.package).toMatchObject({ id, etaStart: "2026-11-10", etaDateOnly: true, items: [{ name: "Cable", imageUrl: null, quantity: 2 }] });
    expect(body.events.map((e: { description: string }) => e.description)).toEqual(["Departed", "Label created"]);
    expect(body.events[0]).toMatchObject({ packageId: id, occurredAt: "2026-11-08T09:12:00.000Z", location: "Oakland, CA" });
  });

  it("answers 404 for another user's, deleted or unknown packages and 400 for a bad id", async () => {
    const { id } = await tracked(result({}));
    const stranger = await createSession(env, await seedUser(env), null, NOW);
    expect((await call("GET", `/v1/packages/${id}`, stranger)).status).toBe(404);
    expect((await call("GET", `/v1/packages/${crypto.randomUUID()}`, stranger)).status).toBe(404);
    expect((await call("GET", "/v1/packages/nope", stranger)).status).toBe(400);

    const mine = await tracked(result({}));
    expect((await call("DELETE", `/v1/packages/${mine.id}`, mine.token)).status).toBe(200);
    expect((await call("GET", `/v1/packages/${mine.id}`, mine.token)).status).toBe(404);
  });

  it("requires a session", async () => {
    expect((await call("GET", `/v1/packages/${crypto.randomUUID()}`, "bogus")).status).toBe(401);
  });
});

describe("migration 0002 backfill", () => {
  it("flags ETAs that sit on UTC midnight, except Amazon's", async () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0002_"));
    const backfill = migration?.queries.find((q) => q.includes("UPDATE packages SET eta_date_only"));
    expect(backfill).toBeDefined();
    const userId = await seedUser(env);
    const seed = async (etaStart: number | null, etaEnd: number | null, source = "manual") => {
      const id = await seedPackage(env, { userId, source });
      await env.DB.prepare("UPDATE packages SET eta_start = ?, eta_end = ?, eta_date_only = 0 WHERE id = ?").bind(etaStart, etaEnd, id).run();
      return id;
    };
    const midnight = Date.UTC(2026, 10, 10);
    const dated = await seed(midnight, midnight + DAY);
    const oneSided = await seed(null, midnight);
    const timed = await seed(midnight, midnight + 9 * 3_600_000);
    const amazon = await seed(midnight, midnight, "amazon");
    const none = await seed(null, null);
    await env.DB.prepare(backfill!).run();
    const flag = async (id: string) => (await etaRow(id))[2];
    expect([await flag(dated), await flag(oneSided), await flag(timed), await flag(amazon), await flag(none)]).toEqual([1, 1, 0, 0, 0]);
  });
});
