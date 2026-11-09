import { describe, expect, it } from "vitest";
import { deviceHint, noScansText, readsOnDevice, refreshText, sourceLine } from "./provenance";
import { makePackage } from "./testing";

const NOW = new Date("2026-11-08T18:00:00.000Z");
const TWELVE_MIN_AGO = "2026-11-08T17:48:00.000Z";
const FOUR_HOURS_AGO = "2026-11-08T14:00:00.000Z";

describe("sourceLine", () => {
  it("is null until something has been read", () => {
    expect(sourceLine(makePackage("p", { dataSource: null, lastCheckedAt: TWELVE_MIN_AGO }), NOW)).toBeNull();
  });

  it("names each source with the check time", () => {
    const at = { lastCheckedAt: TWELVE_MIN_AGO };
    expect(sourceLine(makePackage("p", { ...at, carrier: "ups", dataSource: "device" }), NOW)).toBe(
      "From UPS's tracking page, checked on your Mac or iPhone 12 min ago.",
    );
    expect(sourceLine(makePackage("p", { ...at, carrier: "ontrac", dataSource: "web" }), NOW)).toBe(
      "From OnTrac's tracking page, checked by Porchlight 12 min ago.",
    );
    expect(sourceLine(makePackage("p", { ...at, carrier: "dhl", dataSource: "api" }), NOW)).toBe(
      "From DHL's tracking API, checked 12 min ago.",
    );
    expect(sourceLine(makePackage("p", { ...at, carrier: "jitsu", dataSource: "aggregator" }), NOW)).toBe(
      "From Ship24, checked 12 min ago.",
    );
    expect(sourceLine(makePackage("p", { ...at, carrier: "amazon", dataSource: "amazon" }), NOW)).toBe(
      "From your Amazon orders, checked on your Mac or iPhone 12 min ago.",
    );
  });

  it("leaves the time out when there is no check time", () => {
    expect(sourceLine(makePackage("p", { carrier: "usps", dataSource: "device", lastCheckedAt: null }), NOW)).toBe(
      "From USPS's tracking page, checked on your Mac or iPhone.",
    );
  });

  it("doesn't name a carrier it doesn't know", () => {
    expect(
      sourceLine(makePackage("p", { carrier: "other", dataSource: "web", lastCheckedAt: TWELVE_MIN_AGO }), NOW),
    ).toBe("From the carrier's tracking page, checked by Porchlight 12 min ago.");
  });
});

describe("deviceHint", () => {
  const usps = { carrier: "usps" as const, status: "in_transit" as const };

  it("asks for a device when a device carrier was never read", () => {
    expect(deviceHint(makePackage("p", { ...usps, lastCheckedAt: null }), NOW)).toBe(
      "Open Porchlight on your Mac or iPhone to update USPS packages.",
    );
  });

  it("asks for a device when the last read is old", () => {
    expect(deviceHint(makePackage("p", { ...usps, carrier: "fedex", lastCheckedAt: FOUR_HOURS_AGO }), NOW)).toBe(
      "Open Porchlight on your Mac or iPhone to update FedEx packages.",
    );
  });

  it("stays quiet after a recent read, for delivered or archived packages, and for server carriers", () => {
    expect(deviceHint(makePackage("p", { ...usps, lastCheckedAt: TWELVE_MIN_AGO }), NOW)).toBeNull();
    expect(deviceHint(makePackage("p", { ...usps, status: "delivered", lastCheckedAt: null }), NOW)).toBeNull();
    expect(
      deviceHint(makePackage("p", { ...usps, archivedAt: FOUR_HOURS_AGO, lastCheckedAt: null }), NOW),
    ).toBeNull();
    expect(deviceHint(makePackage("p", { carrier: "ontrac", lastCheckedAt: null }), NOW)).toBeNull();
  });
});

describe("readsOnDevice", () => {
  it("is true for USPS and FedEx, and for UPS once a device has read it", () => {
    expect(readsOnDevice(makePackage("p", { carrier: "usps" }))).toBe(true);
    expect(readsOnDevice(makePackage("p", { carrier: "fedex" }))).toBe(true);
    expect(readsOnDevice(makePackage("p", { carrier: "ups", dataSource: null }))).toBe(false);
    expect(readsOnDevice(makePackage("p", { carrier: "ups", dataSource: "web" }))).toBe(false);
    expect(readsOnDevice(makePackage("p", { carrier: "ups", dataSource: "device" }))).toBe(true);
    expect(readsOnDevice(makePackage("p", { carrier: "dhl" }))).toBe(false);
  });
});

describe("refreshText and noScansText", () => {
  it("says a device will do the reading for device carriers", () => {
    const pkg = makePackage("p", { carrier: "usps" });
    expect(refreshText(pkg)).toBe(
      "Asked your Mac or iPhone to check USPS. The update shows up here once Porchlight is open on one of them.",
    );
    expect(noScansText(pkg)).toBe("USPS hasn't reported this number yet. Your Mac or iPhone checks it while Porchlight is open.");
  });

  it("keeps the server wording for everything else", () => {
    const pkg = makePackage("p", { carrier: "ontrac" });
    expect(refreshText(pkg)).toBe("Asked OnTrac for an update. New scans show up here within a minute or two.");
    expect(noScansText(pkg)).toBe("OnTrac hasn't reported this number. Porchlight checks again within the hour.");
  });
});
