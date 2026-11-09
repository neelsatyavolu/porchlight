import { describe, expect, it } from "vitest";
import { fetchWeb, MAX_WEB_BYTES } from "../../../src/adapters/shared/web.js";
import { CarrierError } from "../../../src/types.js";
import { amazonWebAdapter } from "../../../src/adapters/web/amazon.js";
import { dhlEcommerceWebAdapter } from "../../../src/adapters/web/dhl_ecommerce.js";
import { ontracWebAdapter } from "../../../src/adapters/web/ontrac.js";
import { uniuniWebAdapter } from "../../../src/adapters/web/uniuni.js";
import { upsWebAdapter } from "../../../src/adapters/web/ups.js";
import { rejection, webCtx, webFetch } from "./helpers.js";

describe("fetchWeb", () => {
  it("never follows a redirect, whatever the caller asks", async () => {
    const { fetch, calls } = webFetch([
      { url: "example.test", replies: [{ status: 302, text: "", headers: { location: "https://elsewhere.test/" } }] },
    ]);
    const reply = await fetchWeb(webCtx(fetch), "web:test", "https://example.test/feed", { method: "GET", redirect: "follow" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe("manual");
    expect(reply.status).toBe(302);
  });

  it("refuses a body larger than the cap", async () => {
    const { fetch } = webFetch([{ url: "example.test", replies: [{ text: "x".repeat(MAX_WEB_BYTES + 1) }] }]);
    const error = await rejection(fetchWeb(webCtx(fetch), "web:test", "https://example.test/feed", { method: "GET" }));
    expect(error).toBeInstanceOf(CarrierError);
    expect((error as CarrierError).kind).toBe("transient");
  });

  it("refuses a declared content-length over the cap without reading it", async () => {
    const { fetch } = webFetch([
      { url: "example.test", replies: [{ text: "{}", headers: { "content-length": String(MAX_WEB_BYTES + 1) } }] },
    ]);
    const error = await rejection(fetchWeb(webCtx(fetch), "web:test", "https://example.test/feed", { method: "GET" }, { maxBytes: 1 }));
    expect((error as CarrierError).kind).toBe("transient");
  });

  it("reads a body at the cap", async () => {
    const { fetch } = webFetch([{ url: "example.test", replies: [{ text: "abcd" }] }]);
    const reply = await fetchWeb(webCtx(fetch), "web:test", "https://example.test/feed", { method: "GET" }, { maxBytes: 4 });
    expect(reply.text).toBe("abcd");
  });

  it("is used without redirects by every server web adapter", async () => {
    const adapters = [
      [amazonWebAdapter, "TBA123456789012", "amazon"],
      [dhlEcommerceWebAdapter, "GM2951173225174494", "dhl_ecommerce"],
      [ontracWebAdapter, "D10011234567890", "ontrac"],
      [uniuniWebAdapter, "UUS0000000000000000", "uniuni"],
      [upsWebAdapter, "1Z999AA10123456784", "ups"],
    ] as const;
    for (const [adapter, number, carrier] of adapters) {
      const { fetch, calls } = webFetch([{ url: "https://", replies: [{ status: 301, text: "", headers: { location: "https://evil.test/" } }] }]);
      await rejection(adapter.track(number, carrier, webCtx(fetch)));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.redirect === "manual" && !c.url.includes("evil.test"))).toBe(true);
    }
  });
});

describe("error messages", () => {
  it("leave the tracking number out of what the poller logs", async () => {
    const number = "1Z999AA10123456784";
    const { fetch } = webFetch([
      { url: "www.ups.com/track", replies: [{ status: 200, text: "<html></html>", contentType: "text/html", setCookie: ["X-XSRF-TOKEN-ST=t; Path=/"] }] },
      { url: "GetStatus", replies: [{ body: { statusCode: "200", trackDetails: [] } }] },
    ]);
    const error = await rejection(upsWebAdapter.track(number, "ups", webCtx(fetch)));
    expect(error).toBeInstanceOf(CarrierError);
    expect((error as CarrierError).message).not.toContain(number);
  });
});
