import { describe, expect, it } from "vitest";
import { CarrierError } from "../../../src/types.js";
import { amazonEta, amazonTime, createAmazonWebAdapter, mapAmazonEvent } from "../../../src/adapters/web/amazon.js";
import outForDelivery from "../../../fixtures/web/amazon/out-for-delivery.json" with { type: "json" };
import swaDelivered from "../../../fixtures/web/amazon/swa-delivered.json" with { type: "json" };
import historyExpired from "../../../fixtures/web/amazon/history-expired.json" with { type: "json" };
import notFoundBody from "../../../fixtures/web/amazon/not-found.json" with { type: "json" };
import malformedBody from "../../../fixtures/web/amazon/malformed.json" with { type: "json" };
import captcha from "../../../fixtures/web/amazon/captcha.json" with { type: "json" };
import { expectNoPrivateData, page, rejection, webCtx, webFetch, type WebFake } from "./helpers.js";

const TBA = "TBA300000000001";

function setup(replies: WebFake[]) {
  const fake = webFetch([{ url: "track.amazon.com/api/tracker/", method: "GET", replies }]);
  return { ...fake, ctx: webCtx(fake.fetch), adapter: createAmazonWebAdapter() };
}

const kind = async (p: Promise<unknown>) => ((await rejection(p)) as CarrierError).kind;

describe("web:amazon", () => {
  it("serves amazon only", () => {
    const adapter = createAmazonWebAdapter();
    expect([adapter.source, adapter.supports("amazon"), adapter.supports("ups")]).toEqual(["web", true, false]);
  });

  it("sends a browser user agent and the tracker's referer", async () => {
    const { adapter, ctx, calls } = setup([{ body: outForDelivery }]);
    await adapter.track(TBA, "amazon", ctx);
    expect(calls[0]?.url).toBe(`https://track.amazon.com/api/tracker/${TBA}`);
    expect(calls[0]?.headers.get("referer")).toBe("https://track.amazon.com/");
    expect(calls[0]?.headers.get("user-agent")).toMatch(/Safari/);
  });

  it("decodes the nested JSON strings, newest first, without duplicates or addresses", async () => {
    const { adapter, ctx } = setup([{ body: outForDelivery }]);
    const result = await adapter.track(TBA, "amazon", ctx);
    expect(result.status).toBe("out_for_delivery");
    expect(result.statusDetail).toBe("Out for delivery");
    expect(result.events.map((e) => e.status)).toEqual(["out_for_delivery", "in_transit", "in_transit", "label_created"]);
    expect(result.events[0]).toMatchObject({ occurredAt: "2026-11-09T15:30:00Z", location: "Oakland, CA, US" });
    expect([result.etaStart, result.etaEnd, result.etaDateOnly]).toEqual(["2026-11-10T03:00:00Z", "2026-11-10T03:00:00Z", false]);
    expectNoPrivateData(result);
  });

  it("reads long-form clocks without an offset as UTC (reference fixture)", async () => {
    const { adapter, ctx } = setup([{ body: swaDelivered }]);
    const result = await adapter.track(TBA, "amazon", ctx);
    expect(result.status).toBe("delivered");
    expect(result.deliveredAt).toBe("2026-08-11T16:31:56Z");
    expect(result.events).toHaveLength(3);
    expect(result.events[1]?.location).toBe("Paris, Île-de-France, FR");
    expectNoPrivateData(result);
  });

  it("reports TRACKING_ID_NOT_FOUND from our probe, and expired history, as not found", async () => {
    for (const body of [notFoundBody, historyExpired]) {
      const { adapter, ctx } = setup([{ body }]);
      expect(await kind(adapter.track("TBA000000000000", "amazon", ctx))).toBe("not_found");
    }
  });

  it("does not call Amazon for a number that is not a TBA", async () => {
    const { adapter, ctx, calls } = setup([{ body: notFoundBody }]);
    expect(await kind(adapter.track("111-2222222-3333333", "amazon", ctx))).toBe("not_found");
    expect(calls).toHaveLength(0);
  });

  it("calls the robot check and malformed replies transient", async () => {
    for (const reply of [page(captcha), { body: malformedBody }, { text: "<html></html>" }, { status: 500, body: {} }]) {
      const { adapter, ctx } = setup([reply]);
      expect(await kind(adapter.track(TBA, "amazon", ctx))).toBe("transient");
    }
  });

  it("rejects a reply that names another tracking id", async () => {
    const body = { ...outForDelivery, trackingId: "TBA300000000002" };
    const { adapter, ctx } = setup([{ body }]);
    expect(await kind(adapter.track(TBA, "amazon", ctx))).toBe("not_found");
  });

  it("maps scraping.md's event codes", () => {
    expect(mapAmazonEvent("CreationConfirmed", "", false)).toBe("label_created");
    expect(mapAmazonEvent("ArrivedAtSortCenter", "", false)).toBe("in_transit");
    expect(mapAmazonEvent("OutForDelivery", "", false)).toBe("out_for_delivery");
    expect(mapAmazonEvent("Delivered", "", false)).toBe("delivered");
    expect(mapAmazonEvent("DeliveryAttempted", "", false)).toBe("exception");
    expect(mapAmazonEvent("Held", "", true)).toBe("available_for_pickup");
    expect(mapAmazonEvent("Held", "", false)).toBe("exception");
    expect(mapAmazonEvent("ReturnReceived", "", false)).toBe("returned");
    expect(mapAmazonEvent("SomethingNew", "swa_rex_intransit", false)).toBe("in_transit");
    expect(mapAmazonEvent("", "", false)).toBe("unknown");
  });

  it("parses Amazon's clock formats", () => {
    expect(amazonTime("Aug 7, 2026, 11:51:15 PM")).toBe("2026-08-07T23:51:15Z");
    expect(amazonTime("Nov 9, 2026, 12:05:00 AM")).toBe("2026-11-09T00:05:00Z");
    expect(amazonTime("2026-11-09T10:00:00")).toBe("2026-11-09T10:00:00Z");
    expect(amazonTime("2026-11-09T10:00:00-08:00")).toBe("2026-11-09T10:00:00-08:00");
    expect(amazonTime("2026-11-10")).toBe("2026-11-10");
    expect(amazonTime("soon")).toBeNull();
  });

  it("makes an ETA without an offset date-only, on the US day it names", async () => {
    // 03:00 UTC is "by end of day" the evening before in every US zone.
    expect(amazonEta("2026-11-11T03:00:00")).toBe("2026-11-10");
    expect(amazonEta("Aug 11, 2026, 6:00:00 PM")).toBe("2026-08-11");
    expect(amazonEta("2026-11-10T03:00:00Z")).toBe("2026-11-10T03:00:00Z");
    expect(amazonEta("2026-11-10")).toBe("2026-11-10");
    expect(amazonEta(null)).toBeNull();

    const body = structuredClone(outForDelivery);
    body.progressTracker = body.progressTracker.replaceAll("2026-11-10T03:00:00Z", "2026-11-10T03:00:00");
    const { adapter, ctx } = setup([{ body }]);
    const result = await adapter.track(TBA, "amazon", ctx);
    expect([result.etaStart, result.etaEnd, result.etaDateOnly]).toEqual(["2026-11-09", "2026-11-09", true]);
  });
});
