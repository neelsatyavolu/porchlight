import { describe, expect, it } from "vitest";
import { CarrierError } from "../../../src/types.js";
import { createUniuniWebAdapter, mapUniuniState, UNIUNI_DEFAULT_SITE_KEY } from "../../../src/adapters/web/uniuni.js";
import delivered from "../../../fixtures/web/uniuni/delivered.json" with { type: "json" };
import edd from "../../../fixtures/web/uniuni/edd.json" with { type: "json" };
import notFoundBody from "../../../fixtures/web/uniuni/not-found.json" with { type: "json" };
import { expectNoPrivateData, rejection, webCtx, webFetch, type WebFake } from "./helpers.js";

const NUMBER = "UUS0000000000000001";

/** The delivered fixture cut back to before delivery: the latest scan is the second "Out for delivery". */
function outForDelivery() {
  const body = structuredClone(delivered);
  body.data.valid_tno[0]!.spath_list.pop();
  return body;
}

function setup(track: WebFake[], estimate: WebFake[] = [{ body: edd }], env = {}) {
  const fake = webFetch([
    { url: "tracking-service-api.uniuni.ca/tracking/trackinguniuninew", method: "GET", replies: track },
    { url: "sj.uniexpress.ca/version2/orders/edd_information", method: "POST", replies: estimate },
  ]);
  return { ...fake, ctx: webCtx(fake.fetch, env), adapter: createUniuniWebAdapter() };
}

const kind = async (p: Promise<unknown>) => ((await rejection(p)) as CarrierError).kind;

describe("web:uniuni", () => {
  it("sends the public site key, or the configured one", async () => {
    const first = setup([{ body: delivered }]);
    await first.adapter.track(NUMBER, "uniuni", first.ctx);
    const url = new URL(first.calls[0]?.url ?? "");
    expect([url.searchParams.get("id"), url.searchParams.get("key"), url.searchParams.get("source")]).toEqual([NUMBER, UNIUNI_DEFAULT_SITE_KEY, "web"]);
    const second = setup([{ body: delivered }], [{ body: edd }], { UNIUNI_SITE_KEY: "override" });
    await second.adapter.track(NUMBER, "uniuni", second.ctx);
    expect(new URL(second.calls[0]?.url ?? "").searchParams.get("key")).toBe("override");
  });

  it("reverses the oldest-first scans and reads a delivery, without asking for an estimate", async () => {
    const { adapter, ctx, calls } = setup([{ body: delivered }]);
    const result = await adapter.track(NUMBER, "uniuni", ctx);
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("delivered");
    expect(result.events).toHaveLength(9);
    expect(result.events[0]).toEqual({ occurredAt: "2026-01-05T16:00:00-06:00", status: "delivered", description: "Delivered", location: "Example City, EX" });
    expect(result.events.at(-1)).toMatchObject({ status: "label_created", occurredAt: "2026-01-01T14:30:00+00:00", location: null });
    expect(result.events.find((e) => e.description.startsWith("Failed"))?.status).toBe("exception");
    expect(result.deliveredAt).toBe("2026-01-05T16:00:00-06:00");
    expectNoPrivateData(result);
  });

  it("adds a timed window from the estimate call", async () => {
    const { adapter, ctx, calls } = setup([{ body: outForDelivery() }]);
    const result = await adapter.track(NUMBER, "uniuni", ctx);
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({ tnos: [NUMBER] });
    expect(result.status).toBe("out_for_delivery");
    expect([result.etaStart, result.etaEnd, result.etaDateOnly]).toEqual(["2026-01-06T09:00:00-05:00", "2026-01-06T21:00:00-05:00", false]);
  });

  it("uses a bare estimate date as date-only, and ignores a disabled or failed estimate", async () => {
    const dateOnly = structuredClone(edd);
    dateOnly.data[0]!.delivery_estimate.estimated_delivery_time_start = "";
    const a = setup([{ body: outForDelivery() }], [{ body: dateOnly }]);
    const r = await a.adapter.track(NUMBER, "uniuni", a.ctx);
    expect([r.etaStart, r.etaDateOnly]).toEqual(["2026-01-06", true]);
    const disabled = structuredClone(edd);
    disabled.data[0]!.edd_enabled = false;
    for (const estimate of [{ body: disabled }, { status: 500, body: {} }, { timeout: true }, { text: "nope" }]) {
      const s = setup([{ body: outForDelivery() }], [estimate]);
      const result = await s.adapter.track(NUMBER, "uniuni", s.ctx);
      expect([result.status, result.etaStart]).toEqual(["out_for_delivery", null]);
    }
  });

  it("reports the invalid_tno reply as not found", async () => {
    const { adapter, ctx } = setup([{ body: notFoundBody }]);
    expect(await kind(adapter.track("UUS0000000000000000", "uniuni", ctx))).toBe("not_found");
  });

  it("rejects a parcel for another number", async () => {
    const { adapter, ctx } = setup([{ body: delivered }]);
    expect(await kind(adapter.track("UUS0000000000000002", "uniuni", ctx))).toBe("not_found");
  });

  it("calls malformed replies transient", async () => {
    for (const reply of [{ text: "<html>" }, { body: { status: "FAIL" } }, { body: { status: "SUCCESS", data: {} } }, { status: 502, text: "" }]) {
      const { adapter, ctx } = setup([reply]);
      expect(await kind(adapter.track(NUMBER, "uniuni", ctx))).toBe("transient");
    }
  });

  it("maps states, with 202 as a label when the shipper's notice says so", () => {
    expect(mapUniuniState(190, "Order received")).toBe("label_created");
    expect(mapUniuniState(199, "Gateway transit in")).toBe("in_transit");
    expect(mapUniuniState(202, "Out for delivery")).toBe("out_for_delivery");
    expect(mapUniuniState(202, "Shipping information received. Your parcel is on its way to UniUni.")).toBe("label_created");
    expect(mapUniuniState(211, "Failed")).toBe("exception");
    expect(mapUniuniState(203, "Delivered")).toBe("delivered");
    expect(mapUniuniState(230, "Returned")).toBe("returned");
    expect(mapUniuniState(9999, "?")).toBe("unknown");
  });
});
