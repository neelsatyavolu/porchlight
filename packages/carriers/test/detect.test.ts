import { describe, expect, it } from "vitest";
import numbers from "../fixtures/numbers.json" with { type: "json" };
import { detectCarrier, normalizeNumber } from "../src/detect.js";
import type { Candidate, Confidence, NumberFixture } from "../src/types.js";

// Fixture semantics (shared with the Swift port in PorchKit):
//   valid=true            -> detectCarrier(number) includes `carrier`
//   valid=false           -> detectCarrier(number) does not include `carrier`
//   carrier=other, valid  -> detectCarrier(number) returns no candidates
const rows = numbers as unknown as NumberFixture[];
const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

const carriersOf = (cs: Candidate[]) => cs.map((c) => c.carrier);
const label = (r: NumberFixture) => `${JSON.stringify(r.number)} (${r.note})`;

describe("detectCarrier against fixtures/numbers.json", () => {
  it("covers every carrier Porchlight detects, with valid and invalid rows", () => {
    for (const carrier of ["usps", "ups", "fedex", "dhl", "dhl_ecommerce", "amazon", "ontrac", "uniuni"]) {
      expect(rows.some((r) => r.carrier === carrier && r.valid), `${carrier} valid`).toBe(true);
      expect(rows.some((r) => r.carrier === carrier && !r.valid), `${carrier} invalid`).toBe(true);
    }
  });

  for (const row of rows.filter((r) => r.carrier === "other")) {
    it(`finds nothing for ${label(row)}`, () => {
      expect(detectCarrier(row.number)).toEqual([]);
    });
  }

  for (const row of rows.filter((r) => r.carrier !== "other")) {
    const verb = row.valid ? "detects" : "rejects";
    it(`${verb} ${row.carrier} for ${label(row)}`, () => {
      const found = carriersOf(detectCarrier(row.number));
      if (row.valid) expect(found).toContain(row.carrier);
      else expect(found).not.toContain(row.carrier);
    });
  }

  for (const row of rows) {
    it(`returns well-formed candidates for ${JSON.stringify(row.number)}`, () => {
      const cs = detectCarrier(row.number);
      const carriers = carriersOf(cs);
      expect(new Set(carriers).size).toBe(carriers.length);
      expect(carriers).not.toContain("other");
      const ranks = cs.map((c) => RANK[c.confidence]);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    });
  }
});

describe("detectCarrier confidence", () => {
  const top = (n: string) => detectCarrier(n)[0];

  it("is high for a unique prefix with a passing check digit", () => {
    expect(top("1Z5R89390357567127")).toEqual({ carrier: "ups", confidence: "high" });
    expect(top("9400111206206406260787")).toEqual({ carrier: "usps", confidence: "high" });
    expect(top("TBA000000000000")).toEqual({ carrier: "amazon", confidence: "high" });
    expect(top("C11031500001879")).toEqual({ carrier: "ontrac", confidence: "high" });
    expect(top("9611020987654312345672")).toEqual({ carrier: "fedex", confidence: "high" });
    expect(top("RB123456785US")).toEqual({ carrier: "usps", confidence: "high" });
  });

  it("uses the FedEx-12 check digit as a booster, not a filter", () => {
    expect(detectCarrier("986578788855")).toEqual([{ carrier: "fedex", confidence: "medium" }]);
    expect(detectCarrier("996578788855")).toEqual([{ carrier: "fedex", confidence: "low" }]);
  });

  it("keeps DHL Express 10-digit waybills low", () => {
    expect(detectCarrier("3318810025")).toEqual([{ carrier: "dhl", confidence: "low" }]);
  });

  it("prefers USPS for a 420-prefixed 34-digit IMpb (also FedEx-34 shaped)", () => {
    const cs = detectCarrier("4201002334249200190132607600833457");
    expect(cs[0]).toEqual({ carrier: "usps", confidence: "high" });
  });

  it("treats inbound S10 items as USPS medium", () => {
    expect(top("RB123456785GB")).toEqual({ carrier: "usps", confidence: "medium" });
  });
});

describe("normalizeNumber", () => {
  it("uppercases and drops spaces, dashes and dots", () => {
    expect(normalizeNumber(" 1z 999-aa1.0123456784\n")).toBe("1Z999AA10123456784");
    expect(normalizeNumber("9400 1112\t0108")).toBe("940011120108");
  });

  it("strips the LaserShip -1 suffix but keeps the base number", () => {
    expect(normalizeNumber("1LS7119013618127-1")).toBe("1LS7119013618127");
    expect(normalizeNumber("1LS7119013618127-2")).toBe("1LS71190136181272");
  });

  it("is idempotent", () => {
    for (const row of rows) {
      const once = normalizeNumber(row.number);
      expect(normalizeNumber(once)).toBe(once);
    }
  });
});

describe("junk input never throws", () => {
  const junk: unknown[] = ["", undefined, null, 42, {}, [], "\u0000", "😀📦", "1Z".repeat(5000), "9".repeat(10_000)];
  for (const value of junk) {
    it(`handles ${String(value).slice(0, 20)}`, () => {
      expect(() => normalizeNumber(value as string)).not.toThrow();
      expect(detectCarrier(value as string)).toEqual([]);
    });
  }
});
