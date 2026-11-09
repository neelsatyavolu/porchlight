import { describe, expect, it } from "vitest";
import { CarrierError } from "../../../src/types.js";
import { createDhlEcommerceWebAdapter, mapDhlEcommerceDescription } from "../../../src/adapters/web/dhl_ecommerce.js";
import inTransit from "../../../fixtures/web/dhl_ecommerce/in-transit.json" with { type: "json" };
import delivered from "../../../fixtures/web/dhl_ecommerce/delivered.json" with { type: "json" };
import twoPackages from "../../../fixtures/web/dhl_ecommerce/two-packages.json" with { type: "json" };
import notFoundBody from "../../../fixtures/web/dhl_ecommerce/not-found.json" with { type: "json" };
import { expectNoPrivateData, rejection, webCtx, webFetch, type WebFake } from "./helpers.js";

const NUMBER = "GM2951173225174494";

function setup(replies: WebFake[]) {
  const fake = webFetch([{ url: "api.dhlecs.com/webtrack/v4/tracking", method: "POST", replies }]);
  return { ...fake, ctx: webCtx(fake.fetch), adapter: createDhlEcommerceWebAdapter() };
}

const kind = async (p: Promise<unknown>) => ((await rejection(p)) as CarrierError).kind;

describe("web:dhl_ecommerce", () => {
  it("serves dhl_ecommerce only", () => {
    const adapter = createDhlEcommerceWebAdapter();
    expect([adapter.source, adapter.supports("dhl_ecommerce"), adapter.supports("dhl")]).toEqual(["web", true, false]);
  });

  it("posts the Webtrack body and reads an in-transit package", async () => {
    const { adapter, ctx, calls } = setup([{ body: inTransit }]);
    const result = await adapter.track(NUMBER, "dhl_ecommerce", ctx);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ trackedValue: NUMBER, offset: 0, locale: "en-US" });
    expect(calls[0]?.headers.get("origin")).toBe("https://webtrack.dhlecs.com");
    expect(result.status).toBe("in_transit");
    // EN ROUTE without a place is dropped, and so is the duplicate arrival row.
    expect(result.events.map((e) => e.description)).toEqual([
      "ARRIVAL DESTINATION DHL ECOMMERCE FACILITY",
      "DEPARTURE ORIGIN DHL ECOMMERCE FACILITY",
      "LABEL CREATED",
    ]);
    expect(result.events.map((e) => e.occurredAt)).toEqual([
      "2026-11-08T21:04:26-08:00",
      "2026-11-06T05:04:26-06:00",
      "2026-11-05T03:11:58-05:00",
    ]);
    expect(result.events.map((e) => e.status)).toEqual(["in_transit", "in_transit", "label_created"]);
    expect([result.etaStart, result.etaEnd, result.etaDateOnly]).toEqual(["2026-11-12", "2026-11-12", true]);
    expectNoPrivateData(result);
  });

  it("reads a delivered package and drops the ETA", async () => {
    const { adapter, ctx } = setup([{ body: delivered }]);
    const result = await adapter.track(NUMBER, "dhl_ecommerce", ctx);
    expect(result.status).toBe("delivered");
    expect(result.deliveredAt).toBe("2026-11-10T14:22:00-08:00");
    expect(result.etaStart).toBeNull();
    expect(result.events[1]?.status).toBe("out_for_delivery");
  });

  it("accepts the USPS confirmation number as the echo", async () => {
    const { adapter, ctx } = setup([{ body: inTransit }]);
    await expect(adapter.track("9261 2999 9999 9999 9999 99", "dhl_ecommerce", ctx)).resolves.toMatchObject({ status: "in_transit" });
  });

  it("reports the empty reply from our probe as not found", async () => {
    const { adapter, ctx } = setup([{ body: notFoundBody }]);
    expect(await kind(adapter.track("GM0000000000000000", "dhl_ecommerce", ctx))).toBe("not_found");
  });

  it("rejects two packages and a package for another number", async () => {
    const two = setup([{ body: twoPackages }]);
    expect(await kind(two.adapter.track(NUMBER, "dhl_ecommerce", two.ctx))).toBe("not_found");
    const other = setup([{ body: inTransit }]);
    expect(await kind(other.adapter.track("GM0000000000000001", "dhl_ecommerce", other.ctx))).toBe("not_found");
  });

  it("calls malformed and failed replies transient", async () => {
    for (const reply of [{ text: "<html>" }, { body: { packages: null } }, { status: 503, body: {} }, { timeout: true }, { networkError: true }]) {
      const { adapter, ctx } = setup([reply]);
      expect(await kind(adapter.track(NUMBER, "dhl_ecommerce", ctx))).toBe("transient");
    }
  });

  it("maps scraping.md's descriptions", () => {
    const cases: [string, string][] = [
      ["LABEL CREATED", "label_created"],
      ["EN ROUTE TO DHL ECOMMERCE", "label_created"],
      ["OUT FOR DELIVERY", "out_for_delivery"],
      ["READY FOR COLLECTION", "available_for_pickup"],
      ["DELIVERED", "delivered"],
      ["RETURNED TO SENDER", "returned"],
      ["DELIVERY ATTEMPT FAILED", "exception"],
      ["Carrier exception", "exception"],
      ["ACCEPTED BY USPS", "in_transit"],
      ["CUSTOMS", "in_transit"],
      ["", "unknown"],
    ];
    for (const [text, status] of cases) expect([text, mapDhlEcommerceDescription(text)]).toEqual([text, status]);
  });
});
