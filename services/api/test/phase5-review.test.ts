// Regression tests from the Phase 5 correctness review: DHL terms for DHL
// eCommerce read through the DHL API, the web feeds' hourly cap, the queue's
// single consumer (budget races) and observations that lose a race.
import { env } from "cloudflare:test";
import { DHL_ATTRIBUTION, DHL_RETENTION_DAYS, type CarrierAdapter } from "@porchlight/carriers";
import { describe, expect, it } from "vitest";
import { CARRIER_BUCKET, WEB_BUCKET, bucketFor } from "../src/poll/consume.js";
import { cadenceFor } from "../src/poll/interval.js";
import { purgeDhlEvents } from "../src/poll/purge.js";
import { applyTracking, loadPackage } from "../src/poll/store.js";
import { attributionFor } from "../src/routes/sync.js";
import { countEvents, getPackage, seedPackage, seedUser } from "./poll-helpers.js";
import wranglerText from "../wrangler.jsonc?raw";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-08T18:00:00.000Z");

describe("DHL terms follow the DHL API, whatever the carrier", () => {
  it("attributes and slows DHL eCommerce read through the DHL API, not through its web feed", () => {
    expect(attributionFor("dhl_ecommerce", "api")).toBe(DHL_ATTRIBUTION);
    expect(attributionFor("dhl_ecommerce", "web")).toBeNull();
    expect(cadenceFor("dhl_ecommerce", "api")).toBe("dhl_api");
    expect(cadenceFor("dhl_ecommerce", "web")).toBe("server");
  });

  it("purges the events of a DHL eCommerce package the DHL API read", async () => {
    const userId = await seedUser(env);
    const seed = async (source: string) => {
      const id = await seedPackage(env, { userId, carrier: "dhl_ecommerce", status: "delivered", trackingNumber: crypto.randomUUID().slice(0, 12) });
      const at = NOW - DHL_RETENTION_DAYS * DAY - 1;
      await env.DB.prepare("UPDATE packages SET last_source = ?, delivered_at = ? WHERE id = ?").bind(source, at, id).run();
      await env.DB.prepare(
        "INSERT INTO events (id, package_id, occurred_at, status, description, location, raw_hash) VALUES (?, ?, ?, 'delivered', 'Delivered', NULL, ?)",
      )
        .bind(crypto.randomUUID(), id, at, crypto.randomUUID())
        .run();
      return id;
    };
    const api = await seed("api");
    const web = await seed("web");
    expect(await purgeDhlEvents(env, NOW)).toBeGreaterThanOrEqual(1);
    expect(await countEvents(env, api)).toBe(0);
    expect(await countEvents(env, web)).toBe(1);
  });
});

describe("server caps", () => {
  it("holds web feeds to about 20 requests per carrier an hour", () => {
    const web = { source: "web" } as Pick<CarrierAdapter, "source">;
    expect(bucketFor(web)).toBe(WEB_BUCKET);
    expect(WEB_BUCKET.refillPerSec * 3600).toBeCloseTo(20);
    expect(WEB_BUCKET.capacity).toBeLessThanOrEqual(5);
    expect(bucketFor({ source: "aggregator" })).toBe(CARRIER_BUCKET);
  });

  it("runs one queue consumer at a time, so KV read-then-write budgets can't race", () => {
    const config = JSON.parse(wranglerText.replace(/^\s*\/\/.*$/gm, "")) as {
      queues: { consumers: { queue: string; max_concurrency?: number }[] };
    };
    expect(config.queues.consumers.find((c) => c.queue === "porchlight-track")?.max_concurrency).toBe(1);
  });
});

describe("observation ordering", () => {
  it("drops an observation when a newer one was stored after the caller loaded the row", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, carrier: "usps", status: "in_transit", updatedAt: NOW - DAY });
    const stale = await loadPackage(env.DB, id, userId);
    if (!stale) throw new Error("seed failed");
    const read = (status: "out_for_delivery" | "in_transit", at: number) => ({
      status, statusDetail: status, deliveredAt: null, events: [], checkedAtMs: at, source: "device" as const, onlyIfNewer: true,
    });

    // The newer read lands first; the older one was checked against the same old row.
    expect((await applyTracking(env.DB, stale, read("out_for_delivery", NOW), NOW)).applied).toBe(true);
    const late = await applyTracking(env.DB, stale, read("in_transit", NOW - 60_000), NOW);
    expect(late).toMatchObject({ applied: false, changed: false });
    const row = await getPackage(env, id);
    expect(row.status).toBe("out_for_delivery");
    expect(row.last_checked_at).toBe(NOW);
  });
});
