import { describe, expect, it } from "vitest";
import { ADAPTERS, pickAdapters, resolveAdapters } from "../../src/adapters/index.js";
import { CARRIER_IDS, WEB_ADAPTER_IDS } from "../../src/types.js";

const all = {
  AGGREGATOR_API_KEY: "a",
  USPS_CLIENT_ID: "u", USPS_CLIENT_SECRET: "u",
  UPS_CLIENT_ID: "u", UPS_CLIENT_SECRET: "u",
  FEDEX_CLIENT_ID: "f", FEDEX_CLIENT_SECRET: "f",
  DHL_API_KEY: "d",
};
/** What production has today: the aggregator key, the DHL key once approved, no USPS/UPS/FedEx keys. */
const today = { AGGREGATOR_API_KEY: "a", DHL_API_KEY: "d" };
const ids = (list: { id: string }[]) => list.map((a) => a.id);

describe("pickAdapters", () => {
  it("registers direct APIs, then the web adapters, then the aggregator", () => {
    expect(ids([...ADAPTERS])).toEqual([
      "usps", "ups", "fedex", "dhl",
      "web:amazon", "web:dhl_ecommerce", "web:ontrac", "web:uniuni", "web:jitsu", "web:ups",
      "aggregator",
    ]);
    expect(ADAPTERS.filter((a) => a.source === "web").map((a) => a.id).sort()).toEqual([...WEB_ADAPTER_IDS].sort());
  });

  it("orders every list api → web → aggregator", () => {
    const rank = { api: 0, web: 1, aggregator: 2 };
    for (const carrier of CARRIER_IDS) {
      for (const env of [all, today, {}]) {
        const ranks = pickAdapters(carrier, env).map((a) => rank[a.source]);
        expect([carrier, ranks]).toEqual([carrier, [...ranks].sort()]);
      }
    }
  });

  it("uses the web adapter where there is no direct API", () => {
    expect(ids(pickAdapters("dhl_ecommerce", today))).toEqual(["dhl", "web:dhl_ecommerce", "aggregator"]);
    expect(ids(pickAdapters("dhl_ecommerce", { AGGREGATOR_API_KEY: "a" }))).toEqual(["web:dhl_ecommerce", "aggregator"]);
    expect(ids(pickAdapters("ontrac", today))).toEqual(["web:ontrac", "aggregator"]);
    expect(ids(pickAdapters("lasership", today))).toEqual(["web:ontrac", "aggregator"]);
    expect(ids(pickAdapters("uniuni", today))).toEqual(["web:uniuni", "aggregator"]);
    expect(ids(pickAdapters("jitsu", today))).toEqual(["web:jitsu", "aggregator"]);
  });

  it("tries web:ups before the aggregator, after a configured UPS API", () => {
    expect(ids(pickAdapters("ups", today))).toEqual(["web:ups", "aggregator"]);
    expect(ids(pickAdapters("ups", all))).toEqual(["ups", "web:ups", "aggregator"]);
    expect(ids(pickAdapters("ups", {}))).toEqual(["web:ups"]);
  });

  it("has no server web adapter for usps or fedex (the device reads them)", () => {
    expect(ids(pickAdapters("usps", today))).toEqual(["aggregator"]);
    expect(ids(pickAdapters("fedex", today))).toEqual(["aggregator"]);
    expect(ids(pickAdapters("usps", all))).toEqual(["usps", "aggregator"]);
    expect(ids(pickAdapters("fedex", all))).toEqual(["fedex", "aggregator"]);
    expect(pickAdapters("usps", {})).toEqual([]);
  });

  it("never sends Amazon numbers to the aggregator", () => {
    expect(ids(pickAdapters("amazon", all))).toEqual(["web:amazon"]);
  });

  it("keeps dhl on its API, and other on the aggregator", () => {
    expect(ids(pickAdapters("dhl", today))).toEqual(["dhl", "aggregator"]);
    expect(ids(pickAdapters("other", today))).toEqual(["aggregator"]);
    expect(pickAdapters("other", {})).toEqual([]);
  });

  it("keeps resolveAdapters as an alias", () => {
    expect(ids(resolveAdapters("ups", all))).toEqual(ids(pickAdapters("ups", all)));
  });
});
