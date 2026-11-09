// Migration 0005 and the package `dataSource` / `attribution` fields
// (docs/API.md "The Package object").
import { env, SELF } from "cloudflare:test";
import { DHL_ATTRIBUTION } from "@porchlight/carriers";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/lib/auth.js";
import { seedPackage, seedUser } from "./poll-helpers.js";

async function getPackage(token: string, id: string) {
  const res = await SELF.fetch(`https://porchlight.test/v1/packages/${id}`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { package: { dataSource: unknown; attribution: unknown } } }).data.package;
}

describe("migration 0005", () => {
  it("adds the source, device and backoff columns with their defaults", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId });
    const row = await env.DB.prepare(
      `SELECT last_source, device_needed_at, device_reason, device_failures, check_failures, web_misses,
         aggregator_registered_at, events_purged_at FROM packages WHERE id = ?`,
    )
      .bind(id)
      .first();
    expect(row).toEqual({
      last_source: null,
      device_needed_at: null,
      device_reason: null,
      device_failures: 0,
      check_failures: 0,
      web_misses: 0,
      aggregator_registered_at: null,
      events_purged_at: null,
    });
  });

  it("rejects an unknown last_source", async () => {
    const id = await seedPackage(env, { userId: await seedUser(env) });
    await expect(env.DB.prepare("UPDATE packages SET last_source = 'scraper' WHERE id = ?").bind(id).run()).rejects.toThrow();
  });
});

describe("package dataSource and attribution", () => {
  it("are null before anything is read", async () => {
    const userId = await seedUser(env);
    const token = await createSession(env, userId, null, Date.now(), "ios");
    const pkg = await getPackage(token, await seedPackage(env, { userId }));
    expect(pkg.dataSource).toBeNull();
    expect(pkg.attribution).toBeNull();
  });

  it("carry the DHL line only for DHL packages read through the DHL API", async () => {
    const userId = await seedUser(env);
    const token = await createSession(env, userId, null, Date.now(), "ios");
    const dhlApi = await seedPackage(env, { userId, carrier: "dhl", trackingNumber: "1234567890" });
    const dhlAgg = await seedPackage(env, { userId, carrier: "dhl", trackingNumber: "1234567891" });
    const upsDevice = await seedPackage(env, { userId, carrier: "ups" });
    const set = (id: string, source: string) => env.DB.prepare("UPDATE packages SET last_source = ? WHERE id = ?").bind(source, id).run();
    await set(dhlApi, "api");
    await set(dhlAgg, "aggregator");
    await set(upsDevice, "device");

    expect(await getPackage(token, dhlApi)).toMatchObject({ dataSource: "api", attribution: DHL_ATTRIBUTION });
    expect(await getPackage(token, dhlAgg)).toMatchObject({ dataSource: "aggregator", attribution: null });
    expect(await getPackage(token, upsDevice)).toMatchObject({ dataSource: "device", attribution: null });
  });
});

// Wiring through the Worker entry point; behaviour is in device.test.ts.
describe("device tracking routes", () => {
  const routes = [
    ["GET", "/v1/device-tracking/due"],
    ["POST", `/v1/packages/${crypto.randomUUID()}/observed`],
  ] as const;

  it.each(routes)("%s %s needs a session", async (method, path) => {
    const res = await SELF.fetch(`https://porchlight.test${path}`, { method });
    expect(res.status).toBe(401);
  });

  it("are served by the Worker", async () => {
    const token = await createSession(env, await seedUser(env), null, Date.now(), "ios");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const due = await SELF.fetch("https://porchlight.test/v1/device-tracking/due", { headers });
    expect(due.status).toBe(200);
    expect(((await due.json()) as { data: unknown }).data).toEqual({ jobs: [] });
    const body = {
      observedAt: new Date().toISOString(), source: "device", outcome: "failed", status: "unknown", statusDetail: null,
      etaStart: null, etaEnd: null, etaDateOnly: false, deliveredAt: null, events: [],
    };
    const res = await SELF.fetch(`https://porchlight.test/v1/packages/${crypto.randomUUID()}/observed`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    expect(res.status).toBe(404);
  });
});
