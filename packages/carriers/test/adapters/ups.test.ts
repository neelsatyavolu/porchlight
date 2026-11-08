import { describe, expect, it } from "vitest";
import { createUpsAdapter, mapUpsActivity } from "../../src/adapters/ups.js";
import token from "./fixtures/ups/token.json" with { type: "json" };
import delivered from "./fixtures/ups/delivered.json" with { type: "json" };
import inTransit from "./fixtures/ups/in-transit.json" with { type: "json" };
import exceptionReturn from "./fixtures/ups/exception-return.json" with { type: "json" };
import notFound from "./fixtures/ups/not-found.json" with { type: "json" };
import warningNotFound from "./fixtures/ups/warning-not-found.json" with { type: "json" };
import { fakeFetch, makeCtx, rejection, type FakeReply } from "./helpers.js";

const env = { UPS_CLIENT_ID: "cid", UPS_CLIENT_SECRET: "csecret" };
const NUMBER = "1Z1442YY7229014688";

function setup(track: FakeReply[], tokenReplies: FakeReply[] = [{ body: token }]) {
  const fake = fakeFetch([
    { url: "/security/v1/oauth/token", method: "POST", replies: tokenReplies },
    { url: "/api/track/v1/details/", method: "GET", replies: track },
  ]);
  return { ...fake, ctx: makeCtx(fake.fetch, env), adapter: createUpsAdapter() };
}

describe("ups adapter", () => {
  it("is configured only with both secrets", () => {
    const adapter = createUpsAdapter();
    expect(adapter.isConfigured(env)).toBe(true);
    expect(adapter.isConfigured({ UPS_CLIENT_SECRET: "x" })).toBe(false);
    expect(adapter.supports("ups")).toBe(true);
    expect(adapter.supports("fedex")).toBe(false);
  });

  it("uses basic auth for the token and the required headers for tracking", async () => {
    const { adapter, ctx, calls } = setup([{ body: delivered }]);
    await adapter.track(NUMBER, "ups", ctx);
    expect(calls[0]?.headers.get("authorization")).toBe(`Basic ${btoa("cid:csecret")}`);
    expect(calls[0]?.body).toBe("grant_type=client_credentials");
    const track = calls[1];
    expect(track?.url.startsWith(`https://onlinetools.ups.com/api/track/v1/details/${NUMBER}?`)).toBe(true);
    expect(track?.headers.get("authorization")).toBe("Bearer ups-token-1");
    expect(track?.headers.get("transactionSrc")).toBe("porchlight");
    expect(track?.headers.get("transId")).toBeTruthy();
  });

  it("normalizes a delivered package with offset timestamps", async () => {
    const { adapter, ctx } = setup([{ body: delivered }]);
    const result = await adapter.track(NUMBER, "ups", ctx);
    expect(result.status).toBe("delivered");
    expect(result.statusDetail).toBe("DELIVERED");
    expect(result.deliveredAt).toBe("2022-01-26T16:30:00-05:00");
    expect(result.etaStart).toBeNull();
    expect(result.etaEnd).toBeNull();
    expect(result.events.map((e) => e.status)).toEqual(["delivered", "out_for_delivery", "label_created"]);
    expect(result.events[0]?.location).toBe("PARAMUS, NJ, US");
    expect(result.events[2]).toMatchObject({ occurredAt: "2022-01-24T15:16:41", location: null });
  });

  it("prefers the rescheduled date for the ETA, and skips U updates for status", async () => {
    const { adapter, ctx } = setup([{ body: inTransit }]);
    const result = await adapter.track(NUMBER, "ups", ctx);
    expect(result.status).toBe("in_transit");
    expect(result.statusDetail).toBe("Departed from Facility");
    // The 09:00-19:00 window has no UTC offset, so only its date is kept.
    expect(result.etaStart).toBe("2026-11-06");
    expect(result.etaEnd).toBe("2026-11-06");
    expect(result.etaDateOnly).toBe(true);
    expect(result.events[0]).toMatchObject({ status: "in_transit", location: "US", occurredAt: "2026-11-04T02:15:00-06:00" });
  });

  it("reports a scheduled date with no window as date-only", async () => {
    const body = structuredClone(inTransit);
    delete (body.trackResponse.shipment[0]?.package[0] as Record<string, unknown>).deliveryTime;
    const { adapter, ctx } = setup([{ body }]);
    const result = await adapter.track(NUMBER, "ups", ctx);
    expect([result.etaStart, result.etaEnd, result.etaDateOnly]).toEqual(["2026-11-06", "2026-11-06", true]);
  });

  it("maps return-to-sender exceptions to returned", async () => {
    const { adapter, ctx } = setup([{ body: exceptionReturn }]);
    const result = await adapter.track(NUMBER, "ups", ctx);
    expect(result.status).toBe("returned");
    expect(result.events[1]?.status).toBe("exception");
  });

  it("maps a 404 and a TW0001 warning to not_found", async () => {
    let s = setup([{ status: 404, body: notFound }]);
    expect(await rejection(s.adapter.track(NUMBER, "ups", s.ctx))).toMatchObject({ kind: "not_found", adapter: "ups" });
    s = setup([{ body: warningNotFound }]);
    expect(await rejection(s.adapter.track(NUMBER, "ups", s.ctx))).toMatchObject({ kind: "not_found" });
  });

  it("maps token failure to auth and 429 to rate_limited", async () => {
    let s = setup([{ body: delivered }], [{ status: 401, body: { response: { errors: [{ code: "10401", message: "ClientId is Invalid" }] } } }]);
    expect(await rejection(s.adapter.track(NUMBER, "ups", s.ctx))).toMatchObject({ kind: "auth" });
    s = setup([{ status: 429, body: { response: { errors: [{ code: "10429", message: "Too Many Requests" }] } } }]);
    expect(await rejection(s.adapter.track(NUMBER, "ups", s.ctx))).toMatchObject({ kind: "rate_limited", retryAfterSec: null });
  });

  it("caches the token across calls", async () => {
    const { adapter, ctx, calls } = setup([{ body: delivered }]);
    await adapter.track(NUMBER, "ups", ctx);
    await adapter.track(NUMBER, "ups", ctx);
    expect(calls.filter((c) => c.url.includes("oauth")).length).toBe(1);
  });
});

describe("ups status mapping", () => {
  it.each([
    [{ type: "M", code: "MP", description: "Shipper created a label" }, "label_created"],
    [{ type: "MV", code: "", description: "Voided" }, "label_created"],
    [{ type: "P", code: "", description: "Pickup Scan" }, "in_transit"],
    [{ type: "I", code: "DP", description: "Departed from Facility" }, "in_transit"],
    [{ type: "I", code: "OT", description: "Out For Delivery Today" }, "out_for_delivery"],
    [{ type: "D", code: "", description: "Loaded on Delivery Vehicle" }, "out_for_delivery"],
    [{ type: "D", code: "F4", description: "DELIVERED" }, "delivered"],
    [{ type: "D", code: "", description: "Delivered to UPS Access Point™ and awaiting customer pickup" }, "available_for_pickup"],
    [{ type: "X", code: "48", description: "The receiver was not available" }, "exception"],
    [{ type: "X", code: "", description: "Returning to Sender" }, "returned"],
    [{ type: "RS", code: "", description: "Returned to shipper" }, "returned"],
    [{ type: "U", code: "FC", description: "The delivery date has been updated." }, null],
    [{ type: "Q", code: "", description: "?" }, "unknown"],
  ])("%o -> %s", (status, expected) => {
    expect(mapUpsActivity(status)).toBe(expected);
  });
});
