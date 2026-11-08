import { STATUSES } from "@porchlight/carriers";
import { describe, expect, it } from "vitest";
import { carrierName } from "./carriers";
import { isPending, statusLabel, statusTone } from "./status";

describe("status display", () => {
  it("has a label and a tone for every status", () => {
    for (const s of STATUSES) {
      expect(statusLabel(s)).not.toBe("");
      expect(["out", "delivered", "exception", "neutral"]).toContain(statusTone(s));
    }
  });

  it("colors only the three statuses DESIGN.md names, plus their close relatives", () => {
    expect(statusTone("delivered")).toBe("delivered");
    expect(statusTone("exception")).toBe("exception");
    expect(statusTone("out_for_delivery")).toBe("out");
    expect(statusTone("in_transit")).toBe("neutral");
  });

  it("marks statuses with no movement as pending", () => {
    expect(isPending("label_created")).toBe(true);
    expect(isPending("in_transit")).toBe(false);
  });

  it("names carriers", () => {
    expect(carrierName("fedex")).toBe("FedEx");
  });
});
