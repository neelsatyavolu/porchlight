import { describe, expect, it } from "vitest";
import { CarrierError } from "../../../src/types.js";
import { createJitsuWebAdapter, mapJitsuSignal } from "../../../src/adapters/web/jitsu.js";
import delivered from "../../../fixtures/web/jitsu/delivered.json" with { type: "json" };
import linehaul from "../../../fixtures/web/jitsu/linehaul.json" with { type: "json" };
import challenge from "../../../fixtures/web/jitsu/challenge.json" with { type: "json" };
import notFoundBody from "../../../fixtures/web/jitsu/not-found.json" with { type: "json" };
import { expectNoPrivateData, page, rejection, webCtx, webFetch, type WebFake } from "./helpers.js";

const CODE = "zz00000000000001";
const NOW = new Date("2031-03-11T12:00:00Z");

function setup(replies: WebFake[], now = NOW) {
  const fake = webFetch([{ url: "api.recipient.gojitsu.com/delivery/", method: "GET", replies }]);
  return { ...fake, ctx: webCtx(fake.fetch, {}, now), adapter: createJitsuWebAdapter() };
}

const kind = async (p: Promise<unknown>) => ((await rejection(p)) as CarrierError).kind;

/** The delivered fixture before the delivery scan, still out for delivery. */
function outForDelivery() {
  const body = structuredClone(delivered);
  body.outbound_events = body.outbound_events.filter((e) => e.signal !== "DROPOFF_SUCCEEDED");
  body.shipment.status = "PICKUP_SUCCEEDED";
  return body;
}

describe("web:jitsu", () => {
  it("asks for the code without following redirects", async () => {
    const { adapter, ctx, calls } = setup([{ body: delivered }]);
    await adapter.track(CODE.toUpperCase(), "jitsu", ctx);
    expect(calls[0]?.url).toBe(`https://api.recipient.gojitsu.com/delivery/${CODE}`);
    expect(calls[0]?.redirect).toBe("manual");
  });

  it("reads a delivery in the shipment's zone and leaves out the address change", async () => {
    const { adapter, ctx } = setup([{ body: delivered }]);
    const result = await adapter.track(CODE, "jitsu", ctx);
    expect(result.status).toBe("delivered");
    expect(result.deliveredAt).toBe("2031-03-11T18:20:15-07:00");
    expect(result.statusDetail).toBe("Your order was successfully delivered.");
    expect(result.events.some((e) => e.description === "Delivery details updated.")).toBe(false);
    expect(result.events.find((e) => e.location)?.location).toBe("Example City, CA");
    expect(result.etaStart).toBeNull();
    expectNoPrivateData(result);
  });

  it("gives the delivery window while out for delivery", async () => {
    const { adapter, ctx } = setup([{ body: outForDelivery() }]);
    const result = await adapter.track(CODE, "jitsu", ctx);
    expect(result.status).toBe("out_for_delivery");
    expect([result.etaStart, result.etaEnd, result.etaDateOnly]).toEqual(["2031-03-11T08:00:00-07:00", "2031-03-11T20:00:00-07:00", false]);
  });

  it("drops the window once it has passed, and when the shipper hides it", async () => {
    const late = setup([{ body: outForDelivery() }], new Date("2031-03-13T00:00:00Z"));
    expect((await late.adapter.track(CODE, "jitsu", late.ctx)).etaStart).toBeNull();
    const hidden = setup([{ body: linehaul }], new Date("2031-07-01T00:00:00Z"));
    const result = await hidden.adapter.track("zz00000000000003", "jitsu", hidden.ctx);
    expect(result.status).toBe("in_transit");
    expect(result.etaStart).toBeNull();
  });

  it("marks a return shipment as returned", async () => {
    const body = outForDelivery();
    body.shipment.returnShipment = true;
    const { adapter, ctx } = setup([{ body }]);
    expect((await adapter.track(CODE, "jitsu", ctx)).status).toBe("returned");
  });

  it("reads the Jersey 404 from our probe as not found", async () => {
    const { adapter, ctx } = setup([{ status: 404, body: notFoundBody }]);
    expect(await kind(adapter.track("aaaaaaaaaaaaaaaa", "jitsu", ctx))).toBe("not_found");
  });

  it("treats another 404, a redirect and a Cloudflare challenge as transient", async () => {
    for (const reply of [{ status: 404, text: "Not Found" }, { status: 302, text: "", headers: { location: "https://example.com" } }, page(challenge)]) {
      const { adapter, ctx } = setup([reply]);
      expect(await kind(adapter.track(CODE, "jitsu", ctx))).toBe("transient");
    }
  });

  it("rejects a shipment for another code and malformed replies", async () => {
    const other = setup([{ body: delivered }]);
    expect(await kind(other.adapter.track("zz00000000000009", "jitsu", other.ctx))).toBe("not_found");
    for (const reply of [{ text: "{" }, { body: { shipment: {} } }]) {
      const { adapter, ctx } = setup([reply]);
      expect(await kind(adapter.track(CODE, "jitsu", ctx))).toBe("transient");
    }
  });

  it("does not call Jitsu for something that is not a code", async () => {
    const { adapter, ctx, calls } = setup([{ body: delivered }]);
    for (const bad of ["abc", "https://tracking.gojitsu.com/zz00000000000001", "x".repeat(41)]) {
      expect(await kind(adapter.track(bad, "jitsu", ctx))).toBe("not_found");
    }
    expect(calls).toHaveLength(0);
  });

  it("asks Jitsu for a shipper's own number, which it also tracks (SCD…, 19 characters)", async () => {
    const scd = "SCD0000000000000001";
    const body = structuredClone(delivered);
    body.shipment.tracking_code = scd;
    const { adapter, ctx, calls } = setup([{ body }]);
    expect((await adapter.track(scd, "jitsu", ctx)).status).toBe("delivered");
    expect(calls[0]?.url).toBe(`https://api.recipient.gojitsu.com/delivery/${scd.toLowerCase()}`);
  });

  it("maps signals from scraping.md; notices keep the previous status", () => {
    expect(mapJitsuSignal("PLANNING.CREATED")).toBe("label_created");
    expect(mapJitsuSignal("INBOUND.RECEIVED_OK")).toBe("in_transit");
    expect(mapJitsuSignal("OUTBOUND.DROPOFF_EN_ROUTE")).toBe("out_for_delivery");
    expect(mapJitsuSignal("OUTBOUND.DROPOFF_SUCCEEDED")).toBe("delivered");
    expect(mapJitsuSignal("OUTBOUND.DROPOFF_FAILED")).toBe("exception");
    expect(mapJitsuSignal("PLANNING.UNSERVICEABLE")).toBe("exception");
    expect(mapJitsuSignal("OUTBOUND.PICKUP_DELAY")).toBeNull();
    expect(mapJitsuSignal("NEW.THING")).toBe("unknown");
  });
});
