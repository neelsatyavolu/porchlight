import { describe, expect, it } from "vitest";
import { CARRIER_IDS } from "../../src/types.js";
import { createShip24Adapter, mapShip24Milestone } from "../../src/adapters/ship24.js";
import delivered from "./fixtures/ship24/delivered.json" with { type: "json" };
import ofdJitsu from "./fixtures/ship24/out-for-delivery-jitsu.json" with { type: "json" };
import returned from "./fixtures/ship24/returned.json" with { type: "json" };
import pending from "./fixtures/ship24/pending.json" with { type: "json" };
import unauthorized from "./fixtures/ship24/unauthorized.json" with { type: "json" };
import rateLimited from "./fixtures/ship24/rate-limited.json" with { type: "json" };
import quota from "./fixtures/ship24/quota.json" with { type: "json" };
import { fakeFetch, makeCtx, rejection, type FakeReply } from "./helpers.js";

const env = { AGGREGATOR_API_KEY: "apik_test" };

function setup(replies: FakeReply[]) {
  const fake = fakeFetch([{ url: "api.ship24.com/public/v1/trackers/track", method: "POST", replies }]);
  return { ...fake, ctx: makeCtx(fake.fetch, env), adapter: createShip24Adapter() };
}

describe("ship24 aggregator adapter", () => {
  it("supports every carrier except Amazon Logistics and needs the aggregator key", () => {
    const adapter = createShip24Adapter();
    expect(adapter.id).toBe("aggregator");
    for (const carrier of CARRIER_IDS) expect(adapter.supports(carrier)).toBe(carrier !== "amazon");
    expect(adapter.isConfigured(env)).toBe(true);
    expect(adapter.isConfigured({})).toBe(false);
  });

  it("creates-and-tracks with a deterministic body and bearer key", async () => {
    const { adapter, ctx, calls } = setup([{ body: ofdJitsu }]);
    await adapter.track("SCD0000F00410922107", "jitsu", ctx);
    expect(calls[0]?.url).toBe("https://api.ship24.com/public/v1/trackers/track");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer apik_test");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ trackingNumber: "SCD0000F00410922107" });
  });

  it("orders events by `order`, newest first, and maps milestones", async () => {
    const { adapter, ctx } = setup([{ body: delivered }]);
    const result = await adapter.track("9400115901047177598206", "usps", ctx);
    expect(result.status).toBe("delivered");
    expect(result.statusDetail).toBe("Delivered to the addressee");
    expect(result.deliveredAt).toBe("2021-03-04T17:12:57");
    expect(result.etaStart).toBeNull();
    expect(result.events.map((e) => e.status)).toEqual(["delivered", "out_for_delivery", "in_transit", "label_created"]);
    expect(result.events[0]?.location).toBe("SAN RAFAEL, CA 94901");
  });

  it("never uses Ship24's own estimatedDeliveryDate as an ETA", async () => {
    const { adapter, ctx } = setup([{ body: ofdJitsu }]);
    const result = await adapter.track("SCD0000F00410922107", "jitsu", ctx);
    expect(result.status).toBe("out_for_delivery");
    expect(result.etaStart).toBeNull();
    expect(result.etaEnd).toBeNull();
    expect(result.events[2]).toMatchObject({ occurredAt: "2026-11-07", location: null, status: "label_created" });
  });

  it("maps exception_return to returned and failed_attempt to exception, keeping the courier ETA", async () => {
    const { adapter, ctx } = setup([{ body: returned }]);
    const result = await adapter.track("C11234567890123", "ontrac", ctx);
    expect(result.status).toBe("returned");
    expect(result.events.map((e) => e.status)).toEqual(["returned", "exception"]);
    expect(result.etaStart).toBe("2026-11-06");
    expect(result.etaEnd).toBe("2026-11-06");
    expect(result.etaDateOnly).toBe(true);
  });

  it("returns unknown with no events while the tracker is still pending", async () => {
    const { adapter, ctx } = setup([{ body: pending }]);
    const result = await adapter.track("UUS0000000000000001", "uniuni", ctx);
    expect(result).toEqual({ status: "unknown", statusDetail: "", etaStart: null, etaEnd: null, etaDateOnly: false, deliveredAt: null, events: [] });
  });

  it("maps 401, 429, quota and 404 to typed errors", async () => {
    let s = setup([{ status: 401, body: unauthorized }]);
    expect(await rejection(s.adapter.track("x", "other", s.ctx))).toMatchObject({ kind: "auth", adapter: "aggregator" });
    s = setup([{ status: 429, body: rateLimited, headers: { "retry-after": "1" } }]);
    expect(await rejection(s.adapter.track("x", "other", s.ctx))).toMatchObject({ kind: "rate_limited", retryAfterSec: 1 });
    s = setup([{ status: 403, body: quota }]);
    expect(await rejection(s.adapter.track("x", "other", s.ctx))).toMatchObject({ kind: "rate_limited", retryable: true });
    s = setup([{ status: 404, body: { errors: [{ code: "tracker_not_found", message: "not found" }], data: null } }]);
    expect(await rejection(s.adapter.track("x", "other", s.ctx))).toMatchObject({ kind: "not_found" });
  });

  it("maps an empty trackings list to not_found", async () => {
    const { adapter, ctx } = setup([{ body: { data: { trackings: [] } } }]);
    expect(await rejection(adapter.track("x", "other", ctx))).toMatchObject({ kind: "not_found" });
  });
});

describe("ship24 status mapping", () => {
  it.each([
    ["pending", null, "unknown"],
    ["info_received", null, "label_created"],
    ["in_transit", null, "in_transit"],
    ["out_for_delivery", null, "out_for_delivery"],
    ["available_for_pickup", null, "available_for_pickup"],
    ["delivered", null, "delivered"],
    ["failed_attempt", null, "exception"],
    ["exception", "exception_delayed", "exception"],
    ["exception", "exception_return", "returned"],
    ["exception", "exception_returned", "returned"],
    ["something_new", null, "unknown"],
    [null, null, "unknown"],
  ])("%s / %s -> %s", (milestone, code, status) => {
    expect(mapShip24Milestone(milestone, code)).toBe(status);
  });
});
