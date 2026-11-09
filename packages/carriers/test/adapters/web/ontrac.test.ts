import { describe, expect, it } from "vitest";
import { CarrierError } from "../../../src/types.js";
import { createOntracWebAdapter, mapOntracCode } from "../../../src/adapters/web/ontrac.js";
import delivered from "../../../fixtures/web/ontrac/delivered.json" with { type: "json" };
import inTransit from "../../../fixtures/web/ontrac/in-transit.json" with { type: "json" };
import notFoundBody from "../../../fixtures/web/ontrac/not-found.json" with { type: "json" };
import { expectNoPrivateData, rejection, webCtx, webFetch, type WebFake } from "./helpers.js";

function setup(replies: WebFake[]) {
  const fake = webFetch([{ url: "webtrack.ontrac.com/PackageServices/tracking/", method: "GET", replies }]);
  return { ...fake, ctx: webCtx(fake.fetch), adapter: createOntracWebAdapter() };
}

describe("web:ontrac", () => {
  it("serves ontrac and lasership with no secrets", () => {
    const adapter = createOntracWebAdapter();
    expect(adapter.source).toBe("web");
    expect(adapter.isConfigured({})).toBe(true);
    expect(adapter.supports("ontrac")).toBe(true);
    expect(adapter.supports("lasership")).toBe(true);
    expect(adapter.supports("ups")).toBe(false);
  });

  it("reads a delivered LaserShip package with offset clocks and browser headers", async () => {
    const { adapter, ctx, calls } = setup([{ body: delivered }]);
    const result = await adapter.track("1LS0000000000001", "lasership", ctx);
    expect(calls[0]?.url).toBe("https://webtrack.ontrac.com/PackageServices/tracking/1LS0000000000001");
    expect(calls[0]?.headers.get("user-agent")).toContain("Safari");
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(result.status).toBe("delivered");
    expect(result.deliveredAt).toBe("2026-01-03T14:00:00-08:00");
    expect(result.etaStart).toBeNull();
    expect(result.events.map((e) => e.status)).toEqual(["delivered", "out_for_delivery", "label_created"]);
    expect(result.events[0]?.location).toBe("Example City, CA");
    expect(result.events[2]?.location).toBeNull();
    expectNoPrivateData(result);
  });

  it("keeps wall clocks without an offset and reads a midnight UTC ETA as a date", async () => {
    const { adapter, ctx } = setup([{ body: inTransit }]);
    const result = await adapter.track("D10010000000006", "ontrac", ctx);
    expect(result.status).toBe("in_transit");
    expect(result.statusDetail).toBe("Arrived at Final Servicing Facility");
    expect(result.events[0]?.occurredAt).toBe("2026-11-09T04:12:00");
    expect([result.etaStart, result.etaEnd, result.etaDateOnly]).toEqual(["2026-11-11", "2026-11-11", true]);
  });

  it("treats the 404 problem-details body as not found for a valid number", async () => {
    const { adapter, ctx } = setup([{ status: 404, body: notFoundBody }]);
    const error = await rejection(adapter.track("D10000000000000", "ontrac", ctx));
    expect(error).toBeInstanceOf(CarrierError);
    expect((error as CarrierError).kind).toBe("not_found");
  });

  it("does not call OnTrac for a number in the wrong format", async () => {
    const { adapter, ctx, calls } = setup([{ status: 404, body: notFoundBody }]);
    const error = await rejection(adapter.track("1Z999AA10123456784", "ontrac", ctx));
    expect((error as CarrierError).kind).toBe("not_found");
    expect(calls).toHaveLength(0);
  });

  it("treats some other 404 as transient", async () => {
    const { adapter, ctx } = setup([{ status: 404, text: "<html>gone</html>", contentType: "text/html" }]);
    expect(((await rejection(adapter.track("D10000000000000", "ontrac", ctx))) as CarrierError).kind).toBe("transient");
  });

  it("requires exactly one package echoing the number", async () => {
    const body = structuredClone(delivered);
    body.Packages.push(structuredClone(body.Packages[0]!));
    const { adapter, ctx } = setup([{ body }]);
    expect(((await rejection(adapter.track("1LS0000000000001", "lasership", ctx))) as CarrierError).kind).toBe("not_found");
    const other = setup([{ body: delivered }]);
    expect(((await rejection(other.adapter.track("1LS0000000000002", "lasership", other.ctx))) as CarrierError).kind).toBe("not_found");
  });

  it("calls malformed replies transient", async () => {
    for (const reply of [{ text: "not json" }, { body: { Packages: "nope" } }, { body: { Packages: [{ Tracking: "D10000000000000" }] } }]) {
      const { adapter, ctx } = setup([reply]);
      expect(((await rejection(adapter.track("D10000000000000", "ontrac", ctx))) as CarrierError).kind).toBe("transient");
    }
  });

  it("maps 429 to rate_limited and a timeout to transient", async () => {
    const limited = setup([{ status: 429, body: {}, headers: { "retry-after": "120" } }]);
    const error = (await rejection(limited.adapter.track("D10000000000000", "ontrac", limited.ctx))) as CarrierError;
    expect([error.kind, error.retryAfterSec]).toEqual(["rate_limited", 120]);
    const slow = setup([{ timeout: true }]);
    expect(((await rejection(slow.adapter.track("D10000000000000", "ontrac", slow.ctx))) as CarrierError).kind).toBe("transient");
  });

  it("maps codes from scraping.md, keeping unknown codes as unknown", () => {
    expect(mapOntracCode("EXRL")).toBe("label_created");
    expect(mapOntracCode("NFRP")).toBe("in_transit");
    expect(mapOntracCode("ofdl")).toBe("out_for_delivery");
    expect(mapOntracCode("ONHD")).toBe("exception");
    expect(mapOntracCode("ZZZZ")).toBe("unknown");
  });
});
