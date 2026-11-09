import { describe, expect, it } from "vitest";
import { CarrierError } from "../../../src/types.js";
import { createUpsWebAdapter, mapUpsActCode, upsScheduledDate } from "../../../src/adapters/web/ups.js";
import pageFixture from "../../../fixtures/web/ups/page.json" with { type: "json" };
import akamai from "../../../fixtures/web/ups/akamai-denied.json" with { type: "json" };
import outForDelivery from "../../../fixtures/web/ups/out-for-delivery.json" with { type: "json" };
import notFoundBody from "../../../fixtures/web/ups/not-found.json" with { type: "json" };
import { expectNoPrivateData, page, rejection, webCtx, webFetch, type WebFake } from "./helpers.js";

const NUMBER = "1Z999AA10123456784";
const NOW = new Date("2026-08-04T06:00:00Z");

function setup(status: WebFake[], pageReplies: WebFake[] = [page(pageFixture)], now = NOW) {
  const fake = webFetch([
    { url: "https://www.ups.com/track?", method: "GET", replies: pageReplies },
    { url: "webapis.ups.com/track/api/Track/GetStatus", method: "POST", replies: status },
  ]);
  return { ...fake, ctx: webCtx(fake.fetch, {}, now), adapter: createUpsWebAdapter() };
}

async function failure(p: Promise<unknown>) {
  const error = await rejection(p);
  expect(error).toBeInstanceOf(CarrierError);
  return error as CarrierError;
}

describe("web:ups", () => {
  it("is a web adapter for ups with no secrets", () => {
    const adapter = createUpsWebAdapter();
    expect([adapter.id, adapter.source, adapter.isConfigured({}), adapter.supports("ups"), adapter.supports("usps")]).toEqual([
      "web:ups", "web", true, true, false,
    ]);
  });

  it("loads the page for cookies, then posts GetStatus with the XSRF token", async () => {
    const { adapter, ctx, calls } = setup([{ body: outForDelivery }]);
    await adapter.track(NUMBER, "ups", ctx);
    const [pageCall, statusCall] = calls;
    expect(pageCall?.url).toBe(`https://www.ups.com/track?loc=en_US&tracknum=${NUMBER}&requester=ST/trackdetails`);
    expect(pageCall?.headers.get("accept")).toContain("text/html");
    expect(statusCall?.url).toBe("https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US");
    expect(statusCall?.headers.get("x-xsrf-token")).toBe("xsrf+synthetic");
    expect(statusCall?.headers.get("cookie")).toBe(
      "X-CSRF-TOKEN=csrf-synthetic; X-XSRF-TOKEN-ST=xsrf%2Bsynthetic; AKA_A2=A; bm_sz=bmsz-synthetic",
    );
    expect(statusCall?.headers.get("origin")).toBe("https://www.ups.com");
    expect(statusCall?.headers.get("referer")).toBe(pageCall?.url);
    expect(JSON.parse(statusCall?.body ?? "")).toEqual({
      Locale: "en_US",
      TrackingNumber: [NUMBER.toLowerCase()],
      Requester: "st/trackdetails",
      returnToValue: "",
    });
    expect(statusCall?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads an out-for-delivery reply (reference fixture)", async () => {
    const { adapter, ctx } = setup([{ body: outForDelivery }]);
    const result = await adapter.track(NUMBER, "ups", ctx);
    expect(result.status).toBe("out_for_delivery");
    expect(result.statusDetail).toBe("Out For Delivery Today");
    expect(result.events.map((e) => e.status)).toEqual(["out_for_delivery", "in_transit", "in_transit"]);
    expect(result.events[0]).toEqual({
      occurredAt: "2026-08-04T09:12:04+02:00",
      status: "out_for_delivery",
      description: "Out For Delivery Today",
      location: "ZUERICH, CH",
    });
    expect([result.etaStart, result.etaEnd, result.etaDateOnly]).toEqual(["2026-08-04", "2026-08-04", true]);
    expectNoPrivateData(result);
  });

  it("maps delivered, delivered to an Access Point, and returns", async () => {
    const delivered = structuredClone(outForDelivery) as typeof outForDelivery & { trackDetails: Record<string, unknown>[] };
    Object.assign(delivered.trackDetails[0]!, { progressBarType: "Delivered", packageStatus: "Delivered" });
    (delivered.trackDetails[0]!.shipmentProgressActivities as Record<string, unknown>[]).unshift({
      date: "08/04/2026", time: "2:00 P.M.", location: "ZUERICH, CH", activityScan: "DELIVERED", actCode: "KB",
      gmtDate: "20260804", gmtTime: "12:00:00", gmtOffset: "+02:00",
    });
    const a = setup([{ body: delivered }]);
    const result = await a.adapter.track(NUMBER, "ups", a.ctx);
    expect([result.status, result.deliveredAt, result.etaStart]).toEqual(["delivered", "2026-08-04T14:00:00+02:00", null]);

    Object.assign(delivered.trackDetails[0]!, { isDeliveredToUAP: true });
    const b = setup([{ body: delivered }]);
    expect((await b.adapter.track(NUMBER, "ups", b.ctx)).status).toBe("available_for_pickup");

    Object.assign(delivered.trackDetails[0]!, { returnNumbers: ["1Z999AA10123456785"] });
    const c = setup([{ body: delivered }]);
    expect((await c.adapter.track(NUMBER, "ups", c.ctx)).status).toBe("returned");
  });

  it("reports errorCode 504 from our probe as not found", async () => {
    const { adapter, ctx } = setup([{ body: notFoundBody }]);
    expect((await failure(adapter.track("1Z999AA10000000006", "ups", ctx))).kind).toBe("not_found");
  });

  it("rejects a reply for another number", async () => {
    const { adapter, ctx } = setup([{ body: outForDelivery }]);
    expect((await failure(adapter.track("1Z999AA10123456785", "ups", ctx))).kind).toBe("not_found");
  });

  it("hands over to the device when the page is blocked or challenged", async () => {
    for (const reply of [{ status: 401, text: "" }, { status: 403, text: "" }, { status: 428, text: "" }, page(akamai), { timeout: true }]) {
      const { adapter, ctx, calls } = setup([{ body: outForDelivery }], [reply]);
      expect((await failure(adapter.track(NUMBER, "ups", ctx))).kind).toBe("device_required");
      expect(calls).toHaveLength(1);
    }
  });

  it("hands over to the device when the page sets no XSRF cookie", async () => {
    const { adapter, ctx } = setup([{ body: outForDelivery }], [{ ...page(pageFixture), setCookie: ["AKA_A2=A"] }]);
    expect((await failure(adapter.track(NUMBER, "ups", ctx))).kind).toBe("device_required");
  });

  it("hands over to the device when GetStatus is blocked, challenged, times out or isn't JSON", async () => {
    for (const reply of [{ status: 401, body: {} }, { status: 403, text: "" }, { status: 428, text: "" }, page(akamai), { timeout: true }, { text: "<html>" }]) {
      const { adapter, ctx } = setup([reply]);
      expect((await failure(adapter.track(NUMBER, "ups", ctx))).kind).toBe("device_required");
    }
  });

  it("keeps 429 a rate limit, and a 5xx or network failure transient", async () => {
    const limited = setup([{ status: 429, body: {}, headers: { "retry-after": "60" } }]);
    expect((await failure(limited.adapter.track(NUMBER, "ups", limited.ctx))).kind).toBe("rate_limited");
    for (const reply of [{ status: 503, text: "" }, { networkError: true }]) {
      const s = setup([reply]);
      expect((await failure(s.adapter.track(NUMBER, "ups", s.ctx))).kind).toBe("transient");
    }
  });

  it("calls a reply with a bad statusCode or no trackDetails transient", async () => {
    for (const body of [{ statusCode: "500" }, { statusCode: "200" }]) {
      const { adapter, ctx } = setup([{ body }]);
      expect((await failure(adapter.track(NUMBER, "ups", ctx))).kind).toBe("transient");
    }
  });

  it("maps actCodes from scraping.md", () => {
    expect(mapUpsActCode("MP")).toBe("label_created");
    expect(mapUpsActCode("OT")).toBe("out_for_delivery");
    expect(mapUpsActCode("KB")).toBe("delivered");
    expect(mapUpsActCode("ZP")).toBe("available_for_pickup");
    expect(mapUpsActCode("48")).toBe("exception");
    expect(mapUpsActCode("AR")).toBe("in_transit");
    expect(mapUpsActCode("")).toBe("in_transit");
  });

  it("picks the year for the scheduled date", () => {
    const now = new Date("2026-12-28T12:00:00Z");
    expect(upsScheduledDate({ monthCMSKey: "cms.stapp.jan", dayNum: "3" }, now)).toBe("2027-01-03");
    expect(upsScheduledDate({ monthCMSKey: "cms.stapp.dec", dayNum: "24" }, now)).toBe("2026-12-24");
    expect(upsScheduledDate({ monthCMSKey: "cms.stapp.feb", dayNum: "30" }, now)).toBeNull();
    expect(upsScheduledDate(null, now)).toBeNull();
  });
});
