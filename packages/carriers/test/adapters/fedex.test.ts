import { describe, expect, it } from "vitest";
import { createFedexAdapter, mapFedexCode } from "../../src/adapters/fedex.js";
import token from "./fixtures/fedex/token.json" with { type: "json" };
import inTransit from "./fixtures/fedex/in-transit.json" with { type: "json" };
import delivered from "./fixtures/fedex/delivered.json" with { type: "json" };
import notFound from "./fixtures/fedex/not-found.json" with { type: "json" };
import unauthorized from "./fixtures/fedex/unauthorized.json" with { type: "json" };
import { fakeFetch, makeCtx, rejection, type FakeReply } from "./helpers.js";

const env = { FEDEX_CLIENT_ID: "fid", FEDEX_CLIENT_SECRET: "fsecret" };
const NUMBER = "123456789012";

function setup(track: FakeReply[], tokenReplies: FakeReply[] = [{ body: token }]) {
  const fake = fakeFetch([
    { url: "/oauth/token", method: "POST", replies: tokenReplies },
    { url: "/track/v1/trackingnumbers", method: "POST", replies: track },
  ]);
  return { ...fake, ctx: makeCtx(fake.fetch, env), adapter: createFedexAdapter() };
}

describe("fedex adapter", () => {
  it("is configured only with both secrets", () => {
    const adapter = createFedexAdapter();
    expect(adapter.isConfigured(env)).toBe(true);
    expect(adapter.isConfigured({})).toBe(false);
    expect(adapter.supports("fedex")).toBe(true);
    expect(adapter.supports("dhl")).toBe(false);
  });

  it("sends a form token request and a detailed-scan track request", async () => {
    const { adapter, ctx, calls } = setup([{ body: inTransit }]);
    await adapter.track(NUMBER, "fedex", ctx);
    expect(calls[0]?.url).toBe("https://apis.fedex.com/oauth/token");
    expect(new URLSearchParams(calls[0]?.body ?? "").get("client_id")).toBe("fid");
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer fedex-token-1");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      includeDetailedScans: true,
      trackingInfo: [{ trackingNumberInfo: { trackingNumber: NUMBER } }],
    });
  });

  it("uses the delivery window for the ETA, never the standard transit time", async () => {
    const { adapter, ctx } = setup([{ body: inTransit }]);
    const result = await adapter.track(NUMBER, "fedex", ctx);
    expect(result.status).toBe("in_transit");
    expect(result.statusDetail).toBe("In transit");
    expect(result.etaStart).toBe("2026-11-05T10:00:00-08:00");
    expect(result.etaEnd).toBe("2026-11-05T14:00:00-08:00");
    expect(result.etaDateOnly).toBe(false);
    expect(result.events.map((e) => e.status)).toEqual(["in_transit", "in_transit", "label_created"]);
    expect(result.events[0]).toMatchObject({ description: "Arrived at FedEx location", location: "OAKLAND, CA, US" });
    expect(result.events[2]?.location).toBe("US");
  });

  it("falls back to ESTIMATED_DELIVERY when there is no window, as a date when it carries no time", async () => {
    const body = structuredClone(inTransit);
    const track = body.output.completeTrackResults[0]?.trackResults[0] as Record<string, unknown>;
    delete track.estimatedDeliveryTimeWindow;
    const { adapter, ctx } = setup([{ body }]);
    const result = await adapter.track(NUMBER, "fedex", ctx);
    expect(result.etaStart).toBe("2026-11-05");
    expect(result.etaEnd).toBe("2026-11-05");
    expect(result.etaDateOnly).toBe(true);
  });

  it("keeps an ESTIMATED_DELIVERY with a real time as an instant", async () => {
    const body = structuredClone(inTransit);
    const track = body.output.completeTrackResults[0]?.trackResults[0] as Record<string, unknown>;
    delete track.estimatedDeliveryTimeWindow;
    track.dateAndTimes = [{ type: "ESTIMATED_DELIVERY", dateTime: "2026-11-05T20:00:00-08:00" }];
    const { adapter, ctx } = setup([{ body }]);
    const result = await adapter.track(NUMBER, "fedex", ctx);
    expect([result.etaStart, result.etaEnd, result.etaDateOnly]).toEqual(["2026-11-05T20:00:00-08:00", "2026-11-05T20:00:00-08:00", false]);
  });

  it("reports actual delivery", async () => {
    const { adapter, ctx } = setup([{ body: delivered }]);
    const result = await adapter.track("128667043726", "fedex", ctx);
    expect(result.status).toBe("delivered");
    expect(result.deliveredAt).toBe("2026-11-05T11:42:00-08:00");
    expect(result.etaStart).toBeNull();
    expect(result.events[1]?.status).toBe("out_for_delivery");
  });

  it("maps a per-number NOTFOUND error in a 200 response to not_found", async () => {
    const { adapter, ctx } = setup([{ body: notFound }]);
    expect(await rejection(adapter.track("000000000000", "fedex", ctx))).toMatchObject({ kind: "not_found", adapter: "fedex" });
  });

  it("maps 401 to auth after one token refresh", async () => {
    const { adapter, ctx, calls } = setup([{ status: 401, body: unauthorized }]);
    expect(await rejection(adapter.track(NUMBER, "fedex", ctx))).toMatchObject({ kind: "auth" });
    expect(calls.filter((c) => c.url.includes("oauth")).length).toBe(2);
  });

  it("treats a 403 from the token endpoint as the 10-minute OAuth penalty", async () => {
    const { adapter, ctx } = setup([{ body: inTransit }], [{ status: 403, body: { errors: [{ code: "FORBIDDEN.ERROR" }] } }]);
    expect(await rejection(adapter.track(NUMBER, "fedex", ctx))).toMatchObject({ kind: "rate_limited", retryAfterSec: 600 });
  });

  it("maps 429 to rate_limited", async () => {
    const { adapter, ctx } = setup([{ status: 429, body: { errors: [{ code: "RATE.LIMIT.EXCEEDED" }] }, headers: { "retry-after": "10" } }]);
    expect(await rejection(adapter.track(NUMBER, "fedex", ctx))).toMatchObject({ kind: "rate_limited", retryAfterSec: 10 });
  });
});

describe("fedex status mapping", () => {
  it.each([
    ["OC", "label_created"], ["IN", "label_created"],
    ["PU", "in_transit"], ["DO", "in_transit"], ["AR", "in_transit"], ["DP", "in_transit"], ["IT", "in_transit"],
    ["AF", "in_transit"], ["FD", "in_transit"], ["PX", "in_transit"], ["IX", "in_transit"], ["CC", "in_transit"], ["CP", "in_transit"],
    ["AE", "in_transit"], ["AO", "in_transit"],
    ["OD", "out_for_delivery"],
    ["HP", "available_for_pickup"], ["HL", "available_for_pickup"],
    ["DL", "delivered"],
    ["DE", "exception"], ["SE", "exception"], ["DD", "exception"], ["DY", "exception"], ["CD", "exception"], ["PD", "exception"],
    ["RS", "returned"],
    ["CA", "unknown"], ["ZZ", "unknown"],
  ])("%s -> %s", (code, status) => {
    expect(mapFedexCode(code)).toBe(status);
  });
});
