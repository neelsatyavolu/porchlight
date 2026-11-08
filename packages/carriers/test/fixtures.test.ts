import { describe, expect, it } from "vitest";
import numbers from "../fixtures/numbers.json" with { type: "json" };
import { CARRIER_IDS, type NumberFixture } from "../src/types.js";

describe("fixtures/numbers.json", () => {
  const rows = numbers as unknown as NumberFixture[];

  it("is an array of well-formed rows", () => {
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) {
      expect(typeof row.number).toBe("string");
      expect(row.number.length).toBeGreaterThan(0);
      expect(CARRIER_IDS).toContain(row.carrier);
      expect(typeof row.valid).toBe("boolean");
      expect(typeof row.note).toBe("string");
    }
  });
});
