import { describe, expect, it } from "vitest";
import { createDhlAdapter, mapDhlEvent } from "../../src/adapters/dhl.js";
import transit from "./fixtures/dhl/transit-parcel-de.json" with { type: "json" };
import deliveredExpress from "./fixtures/dhl/delivered-express.json" with { type: "json" };
import returned from "./fixtures/dhl/returned.json" with { type: "json" };
import notFound from "./fixtures/dhl/not-found.json" with { type: "json" };
import unauthorized from "./fixtures/dhl/unauthorized.json" with { type: "json" };
import rateLimited from "./fixtures/dhl/rate-limited.json" with { type: "json" };
import { fakeFetch, makeCtx, rejection, type FakeReply } from "./helpers.js";

const env = { DHL_API_KEY: "dhl-key" };

function setup(replies: FakeReply[]) {
  const fake = fakeFetch([{ url: "api-eu.dhl.com/track/shipments", method: "GET", replies }]);
  return { ...fake, ctx: makeCtx(fake.fetch, env), adapter: createDhlAdapter() };
}

describe("dhl adapter", () => {
  it("is configured with an API key and covers DHL Express and eCommerce", () => {
    const adapter = createDhlAdapter();
    expect(adapter.isConfigured(env)).toBe(true);
    expect(adapter.isConfigured({})).toBe(false);
    expect(adapter.supports("dhl")).toBe(true);
    expect(adapter.supports("dhl_ecommerce")).toBe(true);
    expect(adapter.supports("usps")).toBe(false);
  });

  it("sends the key header and the number", async () => {
    const { adapter, ctx, calls } = setup([{ body: transit }]);
    await adapter.track("00340434292135100197", "dhl", ctx);
    expect(calls[0]?.url).toBe("https://api-eu.dhl.com/track/shipments?trackingNumber=00340434292135100197");
    expect(calls[0]?.headers.get("dhl-api-key")).toBe("dhl-key");
  });

  it("refines parcel-de PO to out_for_delivery and uses the time frame's date as ETA", async () => {
    const { adapter, ctx } = setup([{ body: transit }]);
    const result = await adapter.track("00340434292135100197", "dhl", ctx);
    expect(result.status).toBe("out_for_delivery");
    expect(result.statusDetail).toBe("Being delivered.");
    // The frame has no UTC offset, so only its date is kept.
    expect(result.etaStart).toBe("2024-07-02");
    expect(result.etaEnd).toBe("2024-07-02");
    expect(result.etaDateOnly).toBe(true);
    expect(result.events.map((e) => e.status)).toEqual(["out_for_delivery", "in_transit", "label_created"]);
    expect(result.events[1]?.location).toBe("Köln, DE");
    expect(result.events[2]?.location).toBeNull();
  });

  it("keeps a time frame with an offset as instants, and a bare estimatedTimeOfDelivery as a date", async () => {
    const timed = structuredClone(transit) as { shipments: Record<string, unknown>[] };
    timed.shipments[0]!.estimatedDeliveryTimeFrame = { estimatedFrom: "2024-07-02T09:00:00+02:00", estimatedThrough: "2024-07-02T10:30:00+02:00" };
    let s = setup([{ body: timed }]);
    let result = await s.adapter.track("00340434292135100197", "dhl", s.ctx);
    expect([result.etaStart, result.etaEnd, result.etaDateOnly]).toEqual(["2024-07-02T09:00:00+02:00", "2024-07-02T10:30:00+02:00", false]);

    const dated = structuredClone(transit) as { shipments: Record<string, unknown>[] };
    delete dated.shipments[0]!.estimatedDeliveryTimeFrame;
    s = setup([{ body: dated }]);
    result = await s.adapter.track("00340434292135100197", "dhl", s.ctx);
    expect([result.etaStart, result.etaEnd, result.etaDateOnly]).toEqual(["2024-07-02", "2024-07-02", true]);
  });

  it("normalizes an Express delivery and refines event text", async () => {
    const { adapter, ctx } = setup([{ body: deliveredExpress }]);
    const result = await adapter.track("7777777770", "dhl", ctx);
    expect(result.status).toBe("delivered");
    expect(result.deliveredAt).toBe("2026-11-04T14:15:00+01:00");
    expect(result.etaStart).toBeNull();
    expect(result.events.map((e) => e.status)).toEqual(["delivered", "out_for_delivery", "available_for_pickup"]);
  });

  it("maps failure with returnFlag to returned", async () => {
    const { adapter, ctx } = setup([{ body: returned }]);
    expect((await adapter.track("1234567890", "dhl", ctx)).status).toBe("returned");
  });

  it("maps 404, 401 and 429 to typed errors", async () => {
    let s = setup([{ status: 404, body: notFound }]);
    expect(await rejection(s.adapter.track("1", "dhl", s.ctx))).toMatchObject({ kind: "not_found", adapter: "dhl" });
    s = setup([{ status: 401, body: unauthorized }]);
    expect(await rejection(s.adapter.track("1", "dhl", s.ctx))).toMatchObject({ kind: "auth" });
    s = setup([{ status: 429, body: rateLimited, headers: { "retry-after": "5" } }]);
    expect(await rejection(s.adapter.track("1", "dhl", s.ctx))).toMatchObject({ kind: "rate_limited", retryAfterSec: 5 });
  });

  it("maps an empty shipments list to not_found", async () => {
    const { adapter, ctx } = setup([{ body: { shipments: [] } }]);
    expect(await rejection(adapter.track("1", "dhl", ctx))).toMatchObject({ kind: "not_found" });
  });
});

describe("dhl status mapping", () => {
  it.each([
    [{ statusCode: "pre-transit" }, "label_created"],
    [{ statusCode: "transit", description: "Processed at facility" }, "in_transit"],
    [{ statusCode: "transit", status: "PO", description: "x" }, "out_for_delivery"],
    [{ statusCode: "transit", description: "Out for delivery" }, "out_for_delivery"],
    [{ statusCode: "transit", description: "The shipment is ready for pick-up at the PACKSTATION" }, "available_for_pickup"],
    [{ statusCode: "delivered" }, "delivered"],
    [{ statusCode: "failure", description: "Delivery attempted" }, "exception"],
    [{ statusCode: "failure", description: "Returned to shipper" }, "returned"],
    [{ statusCode: "unknown" }, "unknown"],
    [{ statusCode: "brand-new-value" }, "unknown"],
  ])("%o -> %s", (event, status) => {
    expect(mapDhlEvent(event)).toBe(status);
  });
});
