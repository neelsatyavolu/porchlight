// Poller source order, device handoff, aggregator budget and the DHL purge
// (docs/API.md "Device tracking", "Aggregator budget"; scraping.md "Polling limits").
import { env } from "cloudflare:test";
import { CarrierError, DHL_RETENTION_DAYS, type AdapterSource, type CarrierAdapter, type TrackResult } from "@porchlight/carriers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { aggregatorUsed, budgetKey, monthlyLimit, reserveAggregator } from "../src/lib/budget.js";
import { processJob, type ConsumeDeps } from "../src/poll/consume.js";
import { cadenceFor, nextCheckAt } from "../src/poll/interval.js";
import { purgeDhlEvents } from "../src/poll/purge.js";
import type { TrackJob } from "../src/poll/types.js";
import { countEvents, getPackage, seedPackage, seedUser } from "./poll-helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-08T18:00:00.000Z");

function result(over: Partial<TrackResult> = {}): TrackResult {
  return {
    status: "in_transit",
    statusDetail: "Departed facility",
    etaStart: null,
    etaEnd: null,
    etaDateOnly: false,
    deliveredAt: null,
    events: [{ occurredAt: "2026-11-08T09:12:00.000Z", status: "in_transit", description: "Departed", location: "Oakland, CA" }],
    ...over,
  };
}

function adapter(id: string, source: AdapterSource, track: CarrierAdapter["track"]): CarrierAdapter {
  return { id, source, supports: () => true, track };
}

const fails = (kind: CarrierError["kind"]) => async () => {
  throw new CarrierError(kind, "x", kind);
};

function deps(adapters: CarrierAdapter[], over: Partial<ConsumeDeps> = {}): ConsumeDeps {
  return {
    adaptersFor: () => adapters,
    takeToken: async () => ({ allowed: true, retryAfterSec: 0 }),
    reserveAggregator,
    fetch: (async () => new Response("unexpected live call", { status: 599 })) as typeof fetch,
    now: () => NOW,
    notify: vi.fn(async () => 0),
    ...over,
  };
}

const job = (packageId: string, userId: string, reason: TrackJob["reason"] = "scheduled"): TrackJob => ({
  packageId, userId, reason, enqueuedAt: NOW,
});

async function cols(id: string) {
  return env.DB.prepare(
    `SELECT last_source, device_needed_at, device_reason, check_failures, web_misses, aggregator_registered_at, events_purged_at
     FROM packages WHERE id = ?`,
  )
    .bind(id)
    .first<{
      last_source: string | null;
      device_needed_at: number | null;
      device_reason: string | null;
      check_failures: number;
      web_misses: number;
      aggregator_registered_at: number | null;
      events_purged_at: number | null;
    }>();
}

beforeEach(async () => {
  await env.RATE.delete(budgetKey(NOW));
});

describe("cadence", () => {
  it("follows scraping.md Polling limits per feed", () => {
    expect(nextCheckAt("out_for_delivery", NOW, NOW, cadenceFor("ontrac", "web"))).toBe(NOW + 15 * MIN);
    expect(nextCheckAt("out_for_delivery", NOW, NOW, cadenceFor("usps", "device"))).toBe(NOW + 30 * MIN);
    expect(nextCheckAt("out_for_delivery", NOW, NOW, cadenceFor("ups", "device"))).toBe(NOW + 20 * MIN);
    expect(nextCheckAt("out_for_delivery", NOW, NOW, cadenceFor("dhl", "api"))).toBe(NOW + 30 * MIN);
    expect(nextCheckAt("in_transit", NOW, NOW, cadenceFor("fedex", "device"))).toBe(NOW + 2 * HOUR);
    expect(nextCheckAt("in_transit", NOW, NOW, cadenceFor("dhl", "api"))).toBe(NOW + 2 * HOUR);
    expect(nextCheckAt("label_created", NOW, NOW, cadenceFor("usps", "device"))).toBe(NOW + 6 * HOUR);
    expect(nextCheckAt("delivered", NOW, NOW, cadenceFor("usps", "device"))).toBeNull();
  });
});

describe("source recording", () => {
  it("stores the adapter's source and the DHL API cadence", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, carrier: "dhl", updatedAt: NOW });
    await processJob(job(id, userId), env, deps([adapter("dhl", "api", async () => result())]));
    expect((await cols(id))?.last_source).toBe("api");
    expect((await getPackage(env, id)).next_check_at).toBe(NOW + 2 * HOUR);
  });

  it("moves updated_at when only the source changes, so clients see dataSource", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, carrier: "ontrac" });
    await processJob(job(id, userId), env, deps([adapter("web:ontrac", "web", async () => result())]));
    const before = (await getPackage(env, id)).updated_at;
    const later = deps([adapter("aggregator", "aggregator", async () => result())], { now: () => NOW + HOUR });
    await env.DB.prepare("UPDATE packages SET aggregator_registered_at = 1 WHERE id = ?").bind(id).run();
    await processJob(job(id, userId), env, later);
    expect((await cols(id))?.last_source).toBe("aggregator");
    expect((await getPackage(env, id)).updated_at).toBeGreaterThan(before);
  });
});

describe("device carriers", () => {
  it("hands usps and fedex to the device without asking the aggregator", async () => {
    const userId = await seedUser(env);
    for (const carrier of ["usps", "fedex"]) {
      const id = await seedPackage(env, { userId, carrier, updatedAt: NOW });
      const agg = vi.fn(async () => result());
      await processJob(job(id, userId, "import"), env, deps([adapter("aggregator", "aggregator", agg)]));
      expect(agg).not.toHaveBeenCalled();
      expect(await cols(id)).toMatchObject({ device_needed_at: NOW, device_reason: "new", aggregator_registered_at: null });
      const row = await getPackage(env, id);
      expect(row.next_check_at).toBe(NOW + 6 * HOUR);
      expect(row.last_checked_at).toBeNull();
    }
    expect(await aggregatorUsed(env, NOW)).toBe(0);
  });

  it("asks the aggregator for a number the device couldn't read, then keeps using it", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, carrier: "fedex", updatedAt: NOW });
    await env.DB.prepare("UPDATE packages SET device_needed_at = ?, device_reason = 'new', device_failures = 1 WHERE id = ?")
      .bind(NOW + HOUR, id)
      .run();
    const agg = vi.fn(async () => result());
    await processJob(job(id, userId), env, deps([adapter("aggregator", "aggregator", agg)]));
    expect(agg).toHaveBeenCalledOnce();
    expect(await cols(id)).toMatchObject({ last_source: "aggregator", device_needed_at: null, aggregator_registered_at: NOW });
    expect((await getPackage(env, id)).status).toBe("in_transit");
    expect(await aggregatorUsed(env, NOW)).toBe(1);

    // Registered: later looks go to the aggregator without spending the budget again.
    await processJob(job(id, userId), env, deps([adapter("aggregator", "aggregator", agg)], { now: () => NOW + 2 * HOUR }));
    expect(agg).toHaveBeenCalledTimes(2);
    expect(await aggregatorUsed(env, NOW)).toBe(1);
  });

  it("keeps an earlier request or a backoff, and uses reason scheduled once read", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, carrier: "usps", status: "in_transit", lastCheckedAt: NOW - DAY, updatedAt: NOW });
    await processJob(job(id, userId), env, deps([]));
    expect(await cols(id)).toMatchObject({ device_needed_at: NOW, device_reason: "scheduled" });
    await processJob(job(id, userId), env, deps([], { now: () => NOW + 2 * HOUR }));
    expect(await cols(id)).toMatchObject({ device_needed_at: NOW, device_reason: "scheduled" });
    expect((await getPackage(env, id)).next_check_at).toBe(NOW + 4 * HOUR);
    // A manual job makes it due now.
    await processJob(job(id, userId, "manual"), env, deps([], { now: () => NOW + 3 * HOUR }));
    expect(await cols(id)).toMatchObject({ device_needed_at: NOW + 3 * HOUR, device_reason: "manual" });
  });

  it("hands ups to the device when web:ups throws device_required", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, carrier: "ups", updatedAt: NOW });
    const agg = vi.fn(async () => result());
    const d = deps([adapter("web:ups", "web", fails("device_required")), adapter("aggregator", "aggregator", agg)]);
    expect(await processJob(job(id, userId), env, d)).toEqual({ kind: "done" });
    expect(agg).not.toHaveBeenCalled();
    expect(await cols(id)).toMatchObject({ device_needed_at: NOW, device_reason: "server_blocked", web_misses: 0 });
    expect((await getPackage(env, id)).status).toBe("unknown");
  });

  it("clears a pending device request when web:ups answers", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, carrier: "ups" });
    await env.DB.prepare("UPDATE packages SET device_needed_at = ?, device_reason = 'server_blocked' WHERE id = ?").bind(NOW - HOUR, id).run();
    await processJob(job(id, userId), env, deps([adapter("web:ups", "web", async () => result())]));
    expect(await cols(id)).toMatchObject({ device_needed_at: null, device_reason: null, last_source: "web" });
    expect((await getPackage(env, id)).next_check_at).toBe(NOW + 90 * MIN);
  });

  it("retries transient web:ups errors on the server", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, carrier: "ups" });
    const out = await processJob(job(id, userId), env, deps([adapter("web:ups", "web", fails("transient"))]));
    expect(out).toEqual({ kind: "retry", delaySec: 60 });
    expect((await cols(id))?.device_needed_at).toBeNull();
  });
});

describe("aggregator gate and budget", () => {
  it("asks the aggregator only after the web adapter missed twice in a row", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, carrier: "uniuni", updatedAt: NOW });
    const agg = vi.fn(async () => result());
    const d = deps([adapter("web:uniuni", "web", fails("not_found")), adapter("aggregator", "aggregator", agg)]);
    await processJob(job(id, userId), env, d);
    expect(agg).not.toHaveBeenCalled();
    expect(await cols(id)).toMatchObject({ web_misses: 1, aggregator_registered_at: null });
    expect((await getPackage(env, id)).last_checked_at).toBe(NOW);

    await processJob(job(id, userId), env, d);
    expect(agg).toHaveBeenCalledOnce();
    expect(await cols(id)).toMatchObject({ web_misses: 2, aggregator_registered_at: NOW, last_source: "aggregator" });
    expect(await aggregatorUsed(env, NOW)).toBe(1);

    // Reading an already-registered tracker costs nothing.
    await processJob(job(id, userId), env, d);
    expect(agg).toHaveBeenCalledTimes(2);
    expect(await aggregatorUsed(env, NOW)).toBe(1);
  });

  it("resets web_misses when the web adapter answers", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, carrier: "jitsu" });
    await env.DB.prepare("UPDATE packages SET web_misses = 3 WHERE id = ?").bind(id).run();
    await processJob(job(id, userId), env, deps([adapter("web:jitsu", "web", async () => result())]));
    expect((await cols(id))?.web_misses).toBe(0);
  });

  it("uses the aggregator straight away when the carrier has no other path", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, carrier: "other" });
    const agg = vi.fn(async () => result());
    await processJob(job(id, userId), env, deps([adapter("aggregator", "aggregator", agg)]));
    expect(agg).toHaveBeenCalledOnce();
    expect(await aggregatorUsed(env, NOW)).toBe(1);
  });

  it("stops registering new numbers once the month's limit is spent", async () => {
    const userId = await seedUser(env);
    await env.RATE.put(budgetKey(NOW), "10");
    const fresh = await seedPackage(env, { userId, carrier: "other", updatedAt: NOW });
    const known = await seedPackage(env, { userId, carrier: "other" });
    await env.DB.prepare("UPDATE packages SET aggregator_registered_at = ? WHERE id = ?").bind(NOW - DAY, known).run();
    const agg = vi.fn(async () => result());
    const d = deps([adapter("aggregator", "aggregator", agg)]);
    await processJob(job(fresh, userId), env, d);
    expect(agg).not.toHaveBeenCalled();
    expect((await cols(fresh))?.aggregator_registered_at).toBeNull();
    expect((await getPackage(env, fresh)).next_check_at).toBe(NOW + DAY);
    await processJob(job(known, userId), env, d);
    expect(agg).toHaveBeenCalledOnce();
    expect(await aggregatorUsed(env, NOW)).toBe(10);
  });

  it("does not spend the budget when the carrier bucket is empty", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, carrier: "other" });
    const d = deps([adapter("aggregator", "aggregator", async () => result())], {
      takeToken: async () => ({ allowed: false, retryAfterSec: 120 }),
    });
    await processJob(job(id, userId), env, d);
    expect(await aggregatorUsed(env, NOW)).toBe(0);
  });
});

describe("lib/budget", () => {
  it("keys the counter by UTC month", () => {
    expect(budgetKey(Date.parse("2026-11-30T23:59:59Z"))).toBe("aggregator:2026-11");
    expect(budgetKey(Date.parse("2026-12-01T00:00:00Z"))).toBe("aggregator:2026-12");
  });

  it("reads AGGREGATOR_MONTHLY_LIMIT, default 10", () => {
    expect(monthlyLimit({})).toBe(10);
    expect(monthlyLimit({ AGGREGATOR_MONTHLY_LIMIT: "3" })).toBe(3);
    expect(monthlyLimit({ AGGREGATOR_MONTHLY_LIMIT: "0" })).toBe(0);
    expect(monthlyLimit({ AGGREGATOR_MONTHLY_LIMIT: "lots" })).toBe(10);
    expect(monthlyLimit({ AGGREGATOR_MONTHLY_LIMIT: "-1" })).toBe(10);
  });

  it("reserves up to the limit, then refuses; a new month starts at zero", async () => {
    const small = { ...env, AGGREGATOR_MONTHLY_LIMIT: "2" } as Env;
    expect(await reserveAggregator(small, NOW)).toBe(true);
    expect(await reserveAggregator(small, NOW)).toBe(true);
    expect(await reserveAggregator(small, NOW)).toBe(false);
    expect(await aggregatorUsed(small, NOW)).toBe(2);
    const nextMonth = Date.parse("2026-12-01T00:00:00Z");
    await env.RATE.delete(budgetKey(nextMonth));
    expect(await reserveAggregator(small, nextMonth)).toBe(true);
  });

  it("refuses when KV fails", async () => {
    const broken = { ...env, RATE: { get: async () => { throw new Error("kv down"); } } } as unknown as Env;
    expect(await reserveAggregator(broken, NOW)).toBe(false);
  });
});

describe("DHL purge", () => {
  async function delivered(userId: string, carrier: string, source: string | null, deliveredAt: number): Promise<string> {
    const id = await seedPackage(env, { userId, carrier, status: "delivered", trackingNumber: crypto.randomUUID().slice(0, 10) });
    await env.DB.prepare("UPDATE packages SET last_source = ?, delivered_at = ? WHERE id = ?").bind(source, deliveredAt, id).run();
    await env.DB.prepare(
      "INSERT INTO events (id, package_id, occurred_at, status, description, location, raw_hash) VALUES (?, ?, ?, 'delivered', 'Delivered', NULL, ?)",
    )
      .bind(crypto.randomUUID(), id, deliveredAt, crypto.randomUUID())
      .run();
    return id;
  }

  it("deletes events of DHL-API packages 30 days after delivery and moves updated_at", async () => {
    const userId = await seedUser(env);
    const old = NOW - DHL_RETENTION_DAYS * DAY - MIN;
    const due = await delivered(userId, "dhl", "api", old);
    const recent = await delivered(userId, "dhl", "api", NOW - 29 * DAY);
    const aggregator = await delivered(userId, "dhl", "aggregator", old);
    const ups = await delivered(userId, "ups", "api", old);
    const before = (await getPackage(env, due)).updated_at;

    expect(await purgeDhlEvents(env, NOW)).toBe(1);
    expect(await countEvents(env, due)).toBe(0);
    expect((await cols(due))?.events_purged_at).toBe(NOW);
    expect((await getPackage(env, due)).updated_at).toBeGreaterThan(before);
    expect((await getPackage(env, due)).status).toBe("delivered");
    for (const id of [recent, aggregator, ups]) expect(await countEvents(env, id)).toBe(1);

    // Already purged: nothing more to do.
    expect(await purgeDhlEvents(env, NOW + HOUR)).toBe(0);
  });

  it("purges again when a later API read adds events", async () => {
    const userId = await seedUser(env);
    const id = await delivered(userId, "dhl", "api", NOW - 40 * DAY);
    await purgeDhlEvents(env, NOW);
    const back = result({ status: "delivered", deliveredAt: new Date(NOW - 40 * DAY).toISOString() });
    await processJob(job(id, userId, "manual"), env, deps([adapter("dhl", "api", async () => back)]));
    expect(await countEvents(env, id)).toBe(1);
    expect((await cols(id))?.events_purged_at).toBeNull();
    expect(await purgeDhlEvents(env, NOW + MIN)).toBe(1);
    expect(await countEvents(env, id)).toBe(0);
  });

  it("respects the batch limit", async () => {
    const userId = await seedUser(env);
    for (let i = 0; i < 3; i++) await delivered(userId, "dhl", "api", NOW - 60 * DAY - i);
    expect(await purgeDhlEvents(env, NOW, 2)).toBe(2);
  });
});
