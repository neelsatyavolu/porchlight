import { describe, expect, it } from "vitest";
import { ago, countdown } from "./time";

const NOW = Date.parse("2026-11-08T18:00:00.000Z");

describe("ago", () => {
  it.each([
    ["2026-11-08T17:59:30.000Z", "just now"],
    ["2026-11-08T17:46:00.000Z", "14 min ago"],
    ["2026-11-08T15:00:00.000Z", "3 h ago"],
    ["2026-11-07T12:00:00.000Z", "yesterday"],
    ["2026-11-05T12:00:00.000Z", "3 days ago"],
  ])("%s -> %s", (iso, want) => expect(ago(iso, NOW)).toBe(want));

  it("uses a date after a week", () => {
    expect(ago("2026-10-20T12:00:00.000Z", NOW)).toBe("on Oct 20");
  });

  it("never says a future time is ago", () => {
    expect(ago("2026-11-08T19:00:00.000Z", NOW)).toBe("just now");
  });
});

describe("countdown", () => {
  it.each([
    [600_000, "10:00"],
    [65_000, "1:05"],
    [400, "0:01"],
    [-5_000, "0:00"],
  ])("%d ms -> %s", (ms, want) => expect(countdown(ms)).toBe(want));
});
