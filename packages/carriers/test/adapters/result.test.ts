import { describe, expect, it } from "vitest";
import { finishResult, type ResultParts } from "../../src/adapters/shared/result.js";

const base: ResultParts = { status: "in_transit", statusDetail: "", etaStart: null, etaEnd: null, deliveredAt: null, events: [] };
const eta = (etaStart: string | null, etaEnd: string | null) => {
  const r = finishResult({ ...base, etaStart, etaEnd });
  return { etaStart: r.etaStart, etaEnd: r.etaEnd, etaDateOnly: r.etaDateOnly };
};

describe("finishResult ETA", () => {
  it("keeps calendar dates as dates and flags them", () => {
    expect(eta("2026-11-05", "2026-11-06")).toEqual({ etaStart: "2026-11-05", etaEnd: "2026-11-06", etaDateOnly: true });
  });

  it("keeps instants with an offset or Z as instants", () => {
    expect(eta("2026-11-05T10:00:00-08:00", "2026-11-05T14:00:00Z")).toEqual({
      etaStart: "2026-11-05T10:00:00-08:00",
      etaEnd: "2026-11-05T14:00:00Z",
      etaDateOnly: false,
    });
  });

  it("reduces a local time with no offset to its date, since it names no instant", () => {
    expect(eta("2026-11-06T09:00:00", "2026-11-06T19:00:00")).toEqual({ etaStart: "2026-11-06", etaEnd: "2026-11-06", etaDateOnly: true });
  });

  it("reduces a mix of a date and an instant to the dates the carrier wrote", () => {
    expect(eta("2026-11-06", "2026-11-07T02:00:00-05:00")).toEqual({ etaStart: "2026-11-06", etaEnd: "2026-11-07", etaDateOnly: true });
  });

  it("fills a one-sided ETA as a single point", () => {
    expect(eta(null, "2026-11-06")).toEqual({ etaStart: "2026-11-06", etaEnd: "2026-11-06", etaDateOnly: true });
  });

  it("drops values that are not dates", () => {
    expect(eta("soon", null)).toEqual({ etaStart: null, etaEnd: null, etaDateOnly: false });
  });

  it("has no ETA and no flag once delivered", () => {
    const r = finishResult({ ...base, status: "delivered", etaStart: "2026-11-05", etaEnd: "2026-11-05" });
    expect([r.etaStart, r.etaEnd, r.etaDateOnly]).toEqual([null, null, false]);
  });
});
