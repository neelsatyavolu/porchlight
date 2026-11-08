import { describe, expect, it } from "vitest";
import { parseNumbers } from "./parse";

describe("parseNumbers", () => {
  it("normalizes, drops blanks and repeats, one number per line", () => {
    const lines = parseNumbers("1z999aa10123456784\n\n  TBA123456789012 \r\n1Z 999 AA1 0123456784\n");
    expect(lines.map((l) => l.number)).toEqual(["1Z999AA10123456784", "TBA123456789012"]);
  });

  it("preselects a single high-confidence carrier", () => {
    const [ups] = parseNumbers("1Z999AA10123456784");
    expect(ups).toMatchObject({ preselected: "ups", ambiguous: false });
  });

  it("leaves a single medium-confidence match for the server to decide", () => {
    const [fedex] = parseNumbers("986578788855");
    expect(fedex?.candidates).toEqual([{ carrier: "fedex", confidence: "medium" }]);
    expect(fedex).toMatchObject({ preselected: null, ambiguous: false });
  });

  it("marks a number that fits several carriers as ambiguous", () => {
    // An S10 number (USPS) whose prefix is also a DHL eCommerce prefix.
    const [line] = parseNumbers("CN123456785US");
    expect(line?.candidates.map((c) => c.carrier)).toEqual(expect.arrayContaining(["usps", "dhl_ecommerce"]));
    expect(line).toMatchObject({ ambiguous: true, preselected: null });
  });

  it("keeps unknown formats with no candidates, and flags overlong input", () => {
    const [unknown, long] = parseNumbers(`HELLO\n${"9".repeat(41)}`);
    expect(unknown).toMatchObject({ candidates: [], preselected: null, tooLong: false });
    expect(long?.tooLong).toBe(true);
  });
});
