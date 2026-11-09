import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/adapters/index.js";
import { CARRIER_IDS, CarrierError, DATA_SOURCES, DEVICE_CARRIERS, isDeviceCarrier, isDhlApiData, WEB_ADAPTER_IDS } from "../src/index.js";

describe("phase 5 contract", () => {
  it("names usps, ups and fedex as device carriers", () => {
    expect([...DEVICE_CARRIERS]).toEqual(["usps", "ups", "fedex"]);
    expect(CARRIER_IDS.filter(isDeviceCarrier)).toEqual(["usps", "ups", "fedex"]);
  });

  it("gives every registered adapter a source", () => {
    for (const adapter of ADAPTERS) expect(["api", "web", "aggregator"]).toContain(adapter.source);
    expect(ADAPTERS.find((a) => a.id === "aggregator")?.source).toBe("aggregator");
  });

  it("keeps web adapter ids under the web: prefix", () => {
    for (const id of WEB_ADAPTER_IDS) expect(id.startsWith("web:")).toBe(true);
    expect(DATA_SOURCES).toEqual(["api", "web", "aggregator", "device", "amazon"]);
  });

  it("does not retry device_required on the server", () => {
    expect(new CarrierError("device_required", "web:ups", "challenge").retryable).toBe(false);
  });

  it("applies the DHL terms to whatever the DHL API read, eCommerce included", () => {
    expect(ADAPTERS.find((a) => a.id === "dhl")?.supports("dhl_ecommerce")).toBe(true);
    expect(isDhlApiData("dhl", "api")).toBe(true);
    expect(isDhlApiData("dhl_ecommerce", "api")).toBe(true);
    expect(isDhlApiData("dhl_ecommerce", "web")).toBe(false);
    expect(isDhlApiData("ups", "api")).toBe(false);
  });
});
