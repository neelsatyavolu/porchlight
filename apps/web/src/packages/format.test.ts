import { describe, expect, it } from "vitest";
import { carrierTrackingUrl, matchesQuery, retryWait, rowTitle, sourceLabel, statusLine, timelineDays } from "./format";
import { makeEvent, makePackage as pkg } from "./testing";

describe("rowTitle", () => {
  it("prefers title, then merchant, then carrier and last 4", () => {
    expect(rowTitle(pkg("a", { title: "Headphones", merchant: "Best Buy" }))).toBe("Headphones");
    expect(rowTitle(pkg("a", { title: "  ", merchant: "Best Buy" }))).toBe("Best Buy");
    expect(rowTitle(pkg("a", { trackingNumber: "1Z999AA10123456784" }))).toBe("UPS ···6784");
  });
});

describe("statusLine", () => {
  it("adds the carrier's words after our label", () => {
    expect(statusLine({ status: "exception", statusDetail: "Address issue" })).toBe("Problem · Address issue");
    expect(statusLine({ status: "in_transit", statusDetail: null })).toBe("In transit");
    expect(statusLine({ status: "delivered", statusDetail: "Delivered" })).toBe("Delivered");
  });
});

describe("sourceLabel", () => {
  it("names each source", () => {
    expect(sourceLabel("manual")).toBe("Added by hand");
    expect(sourceLabel("amazon")).toBe("From Amazon");
    expect(sourceLabel("flint")).toBe("From Flint");
    expect(sourceLabel("share")).toBe("Shared");
  });
});

describe("carrierTrackingUrl", () => {
  it("links known carriers and encodes the number", () => {
    expect(carrierTrackingUrl("ups", "1Z999AA10123456784")).toBe("https://www.ups.com/track?tracknum=1Z999AA10123456784");
    expect(carrierTrackingUrl("other", "X")).toBeNull();
    expect(carrierTrackingUrl("usps", "A B")).toContain("A%20B");
  });
});

describe("matchesQuery", () => {
  const p = pkg("a", {
    title: "Desk lamp",
    merchant: "IKEA",
    carrier: "fedex",
    trackingNumber: "123456789012",
    orderId: "112-1234567",
    items: [{ name: "LED bulb", imageUrl: null, quantity: 2 }],
  });
  it.each([
    ["", true],
    ["lamp", true],
    ["ikea", true],
    ["FedEx", true],
    ["in transit", true],
    ["bulb", true],
    ["112-1234567", true],
    ["9012", true],
    ["1234 5678 9012", true],
    ["sofa", false],
  ])("%j matches: %s", (query, expected) => {
    expect(matchesQuery(p, query)).toBe(expected);
  });
});

describe("timelineDays", () => {
  it("groups newest-first events by local day with times", () => {
    const now = new Date("2026-11-08T18:00:00.000Z");
    const days = timelineDays(
      [
        makeEvent("e3", "a", "2026-11-08T17:12:00.000Z", { location: "Oakland, CA" }),
        makeEvent("e2", "a", "2026-11-08T07:59:00.000Z"), // Nov 7, 11:59 PM PST
        makeEvent("e1", "a", "2026-11-07T16:00:00.000Z"),
      ],
      now,
      "America/Los_Angeles",
    );
    expect(days.map((d) => d.label)).toEqual(["Sun, Nov 8", "Sat, Nov 7"]);
    expect(days[0]?.events.map((e) => e.time)).toEqual(["9:12 AM"]);
    expect(days[1]?.events.map((e) => e.id)).toEqual(["e2", "e1"]);
  });
});

describe("retryWait", () => {
  it("rounds Retry-After up to whole minutes", () => {
    expect(retryWait(120)).toBe("2 min");
    expect(retryWait(61)).toBe("2 min");
    expect(retryWait(5)).toBe("1 min");
    expect(retryWait(null)).toBe("2 min");
  });
});
