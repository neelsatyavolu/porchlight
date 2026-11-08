import { describe, expect, it } from "vitest";
import { ADAPTERS, pickAdapters, resolveAdapters } from "../../src/adapters/index.js";

const all = {
  AGGREGATOR_API_KEY: "a",
  USPS_CLIENT_ID: "u", USPS_CLIENT_SECRET: "u",
  UPS_CLIENT_ID: "u", UPS_CLIENT_SECRET: "u",
  FEDEX_CLIENT_ID: "f", FEDEX_CLIENT_SECRET: "f",
  DHL_API_KEY: "d",
};
const ids = (list: { id: string }[]) => list.map((a) => a.id);

describe("pickAdapters", () => {
  it("registers the four direct adapters before the aggregator", () => {
    expect(ids([...ADAPTERS])).toEqual(["usps", "ups", "fedex", "dhl", "aggregator"]);
  });

  it("puts the direct adapter first when its secrets exist", () => {
    expect(ids(pickAdapters("usps", all))).toEqual(["usps", "aggregator"]);
    expect(ids(pickAdapters("ups", all))).toEqual(["ups", "aggregator"]);
    expect(ids(pickAdapters("fedex", all))).toEqual(["fedex", "aggregator"]);
    expect(ids(pickAdapters("dhl", all))).toEqual(["dhl", "aggregator"]);
    expect(ids(pickAdapters("dhl_ecommerce", all))).toEqual(["dhl", "aggregator"]);
  });

  it("skips a direct adapter whose secrets are missing", () => {
    expect(ids(pickAdapters("usps", { AGGREGATOR_API_KEY: "a", USPS_CLIENT_ID: "u" }))).toEqual(["aggregator"]);
    expect(ids(pickAdapters("fedex", { AGGREGATOR_API_KEY: "a" }))).toEqual(["aggregator"]);
  });

  it("sends aggregator-only carriers to the aggregator", () => {
    for (const carrier of ["jitsu", "ontrac", "lasership", "uniuni", "other"] as const) {
      expect(ids(pickAdapters(carrier, all))).toEqual(["aggregator"]);
    }
  });

  it("never sends Amazon Logistics numbers to the aggregator (billed, usually not found)", () => {
    expect(pickAdapters("amazon", all)).toEqual([]);
  });

  it("returns nothing when no adapter is configured", () => {
    expect(pickAdapters("ups", {})).toEqual([]);
    expect(ids(pickAdapters("ups", { UPS_CLIENT_ID: "u", UPS_CLIENT_SECRET: "u" }))).toEqual(["ups"]);
  });

  it("keeps resolveAdapters as an alias", () => {
    expect(ids(resolveAdapters("usps", all))).toEqual(ids(pickAdapters("usps", all)));
  });
});
