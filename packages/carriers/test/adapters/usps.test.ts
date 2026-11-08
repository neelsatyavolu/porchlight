import { describe, expect, it } from "vitest";
import { createUspsAdapter, mapUspsCategory, mapUspsEventCode } from "../../src/adapters/usps.js";
import { CarrierError } from "../../src/types.js";
import token from "./fixtures/usps/token.json" with { type: "json" };
import inTransit from "./fixtures/usps/in-transit.json" with { type: "json" };
import delivered from "./fixtures/usps/delivered.json" with { type: "json" };
import notFound from "./fixtures/usps/not-found.json" with { type: "json" };
import { fakeFetch, makeCtx, rejection, type FakeReply } from "./helpers.js";

const env = { USPS_CLIENT_ID: "id", USPS_CLIENT_SECRET: "secret" };
const NUMBER = "9400111899223456789012";

function setup(track: FakeReply[], tokenReplies: FakeReply[] = [{ body: token }]) {
  const fake = fakeFetch([
    { url: "/oauth2/v3/token", method: "POST", replies: tokenReplies },
    { url: "/tracking/v3r2/tracking", method: "POST", replies: track },
  ]);
  return { ...fake, ctx: makeCtx(fake.fetch, env), adapter: createUspsAdapter() };
}

describe("usps adapter", () => {
  it("is configured only with both secrets", () => {
    const adapter = createUspsAdapter();
    expect(adapter.isConfigured(env)).toBe(true);
    expect(adapter.isConfigured({ USPS_CLIENT_ID: "id" })).toBe(false);
    expect(adapter.supports("usps")).toBe(true);
    expect(adapter.supports("ups")).toBe(false);
  });

  it("gets a token, then tracks and normalizes an in-transit package", async () => {
    const { adapter, ctx, calls } = setup([{ body: inTransit }]);
    const result = await adapter.track(NUMBER, "usps", ctx);

    expect(calls[0]?.url).toBe("https://apis.usps.com/oauth2/v3/token");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ grant_type: "client_credentials", client_id: "id", client_secret: "secret" });
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer usps-token-1");
    expect(JSON.parse(calls[1]?.body ?? "[]")).toEqual([{ trackingNumber: NUMBER }]);

    expect(result.status).toBe("in_transit");
    expect(result.statusDetail).toBe("In Transit to Next Facility");
    expect(result.etaStart).toBe("2026-11-05");
    expect(result.etaEnd).toBe("2026-11-05");
    expect(result.etaDateOnly).toBe(true);
    expect(result.deliveredAt).toBeNull();
    expect(result.events).toHaveLength(4);
    expect(result.events[0]).toEqual({
      occurredAt: "2026-11-03T22:10:00-05:00",
      status: "in_transit",
      description: "In Transit to Next Facility",
      location: "ORLANDO, FL, US",
    });
    expect(result.events[3]).toMatchObject({ status: "label_created", location: "ORLANDO, FL" });
  });

  it("reports delivery time and drops the ETA once delivered", async () => {
    const { adapter, ctx } = setup([{ body: delivered }]);
    const result = await adapter.track(NUMBER, "usps", ctx);
    expect(result.status).toBe("delivered");
    expect(result.deliveredAt).toBe("2025-02-07T12:55:12-05:00");
    expect(result.etaStart).toBeNull();
    expect(result.events[1]?.status).toBe("out_for_delivery");
  });

  it("caches the token until it is about to expire", async () => {
    const { adapter, ctx, calls } = setup([{ body: inTransit }]);
    await adapter.track(NUMBER, "usps", ctx);
    await adapter.track(NUMBER, "usps", ctx);
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(1);

    ctx.clock.now = new Date(ctx.clock.now.getTime() + 8 * 3600 * 1000);
    await adapter.track(NUMBER, "usps", ctx);
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(2);
  });

  it("throws auth when the token request is refused", async () => {
    const { adapter, ctx } = setup([{ body: inTransit }], [{ status: 401, body: { error: "invalid_client" } }]);
    const error = await rejection(adapter.track(NUMBER, "usps", ctx));
    expect(error).toBeInstanceOf(CarrierError);
    expect(error).toMatchObject({ kind: "auth", adapter: "usps", retryable: false });
  });

  it("refreshes a rejected cached token once, then gives up with auth", async () => {
    const { adapter, ctx, calls } = setup([{ status: 401, body: {} }]);
    const error = await rejection(adapter.track(NUMBER, "usps", ctx));
    expect(error).toMatchObject({ kind: "auth" });
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(2);
    expect(calls.filter((c) => c.url.includes("tracking")).length).toBe(2);
  });

  it("treats a 403 (Mailer ID not authorized) as auth so the aggregator takes over", async () => {
    const { adapter, ctx } = setup([{ status: 403, body: { error: { message: "Unauthorized MID" } } }]);
    expect(await rejection(adapter.track(NUMBER, "usps", ctx))).toMatchObject({ kind: "auth" });
  });

  it("maps 404 to not_found", async () => {
    const { adapter, ctx } = setup([{ status: 404, body: notFound }]);
    expect(await rejection(adapter.track(NUMBER, "usps", ctx))).toMatchObject({ kind: "not_found" });
  });

  it("maps an item-level error in a 200/207 body to not_found", async () => {
    const { adapter, ctx } = setup([{ status: 207, body: [{ trackingNumber: NUMBER, error: notFound.error }] }]);
    expect(await rejection(adapter.track(NUMBER, "usps", ctx))).toMatchObject({ kind: "not_found" });
  });

  it("maps 429 to rate_limited with Retry-After", async () => {
    const { adapter, ctx } = setup([{ status: 429, body: {}, headers: { "retry-after": "120" } }]);
    const error = await rejection(adapter.track(NUMBER, "usps", ctx));
    expect(error).toMatchObject({ kind: "rate_limited", retryAfterSec: 120, retryable: true });
  });

  it("maps 5xx and network failures to transient", async () => {
    const { adapter, ctx } = setup([{ status: 503, body: {} }]);
    expect(await rejection(adapter.track(NUMBER, "usps", ctx))).toMatchObject({ kind: "transient" });

    const broken = makeCtx((async () => {
      throw new TypeError("network down");
    }) as typeof fetch, env);
    expect(await rejection(createUspsAdapter().track(NUMBER, "usps", broken))).toMatchObject({ kind: "transient" });
  });
});

describe("usps status mapping", () => {
  it.each([
    ["USPS Awaiting Item", "label_created"],
    ["Pre-Shipment", "label_created"],
    ["Accepted", "in_transit"],
    ["On the Way", "in_transit"],
    ["Moving Through Network", "in_transit"],
    ["Preparing for Delivery", "in_transit"],
    ["International Transit", "in_transit"],
    ["Out for Delivery", "out_for_delivery"],
    ["Available for Pickup", "available_for_pickup"],
    ["Available for Agent Pickup", "available_for_pickup"],
    ["Delivered", "delivered"],
    ["Delivered to Agent", "delivered"],
    ["Alert", "exception"],
    ["Delivery Attempt", "exception"],
    ["Delivery Attempt: Action Needed", "exception"],
    ["Returned to Sender", "returned"],
    ["Returned to Shipper", "returned"],
    ["Something New", null],
  ])("category %s -> %s", (category, status) => {
    expect(mapUspsCategory(category)).toBe(status);
  });

  it.each([
    ["GX", "label_created"], ["MA", "label_created"],
    ["03", "in_transit"], ["OA", "in_transit"], ["07", "in_transit"], ["10", "in_transit"], ["NT", "in_transit"], ["TL", "in_transit"], ["ME", "in_transit"],
    ["OF", "out_for_delivery"],
    ["14", "available_for_pickup"], ["16", "available_for_pickup"],
    ["01", "delivered"], ["OK", "delivered"],
    ["02", "exception"], ["NH", "exception"], ["04", "exception"], ["05", "exception"], ["21", "exception"], ["22", "exception"], ["55", "exception"], ["56", "exception"], ["OH", "exception"],
    ["09", "returned"], ["H8", "returned"],
    ["ZZ", null],
  ])("event code %s -> %s", (code, status) => {
    expect(mapUspsEventCode(code)).toBe(status);
  });
});
