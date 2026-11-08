import { describe, expect, it } from "vitest";
import type { Package } from "../api/types";
import { etaPhrase, etaSentence, groupOf, groupPackages } from "./arrival";
import { makePackage as pkg } from "./testing";

const LA = "America/Los_Angeles";
const TOKYO = "Asia/Tokyo";
/** Sunday, Nov 8 2026, 10:00 AM in LA (Monday 3 AM in Tokyo). */
const NOW = new Date("2026-11-08T18:00:00.000Z");

const ids = (list: Package[]) => list.map((p) => p.id);

describe("groupOf", () => {
  it.each<[string, Partial<Package>, string]>([
    ["out for delivery, any ETA", { status: "out_for_delivery", etaEnd: "2026-11-12", etaDateOnly: true }, "today"],
    ["ready for pickup", { status: "available_for_pickup" }, "today"],
    ["ETA today (date only)", { etaStart: "2026-11-08", etaDateOnly: true }, "today"],
    ["late and not delivered", { etaEnd: "2026-11-03", etaDateOnly: true }, "today"],
    ["ETA tomorrow (date only)", { etaEnd: "2026-11-09", etaDateOnly: true }, "tomorrow"],
    ["ETA in 2 days", { etaEnd: "2026-11-10", etaDateOnly: true }, "week"],
    ["ETA in 6 days", { etaEnd: "2026-11-14", etaDateOnly: true }, "week"],
    ["ETA in 7 days", { etaEnd: "2026-11-15", etaDateOnly: true }, "later"],
    ["no ETA", {}, "later"],
    ["delivered", { status: "delivered", deliveredAt: "2026-11-08T16:00:00.000Z", etaEnd: "2026-11-20", etaDateOnly: true }, "delivered"],
    ["exception due tomorrow keeps the date rule", { status: "exception", etaEnd: "2026-11-09", etaDateOnly: true }, "tomorrow"],
    ["returned, no ETA", { status: "returned" }, "later"],
  ])("%s", (_name, patch, group) => {
    expect(groupOf(pkg("x", patch), NOW, LA)).toBe(group);
  });

  it("uses etaEnd over etaStart", () => {
    expect(groupOf(pkg("x", { etaStart: "2026-11-08", etaEnd: "2026-11-10", etaDateOnly: true }), NOW, LA)).toBe("week");
  });

  it("reads a date-only ETA by its date, so Nov 9 is tomorrow in LA and today in Tokyo", () => {
    const p = pkg("x", { etaEnd: "2026-11-09", etaDateOnly: true });
    expect(groupOf(p, NOW, LA)).toBe("tomorrow");
    expect(groupOf(p, NOW, TOKYO)).toBe("today");
  });

  it("reads an instant at midnight UTC in the viewer's zone: only etaDateOnly marks a date", () => {
    // Nov 9, 00:00 UTC is Nov 8, 4 PM in LA.
    expect(groupOf(pkg("x", { etaEnd: "2026-11-09T00:00:00.000Z" }), NOW, LA)).toBe("today");
    expect(groupOf(pkg("y", { etaEnd: "2026-11-09", etaDateOnly: true }), NOW, LA)).toBe("tomorrow");
  });

  it("reads a timed ETA in the viewer's zone", () => {
    // Nov 9, 4 AM UTC = Nov 8, 8 PM in LA (today) and Nov 9, 1 PM in Tokyo (today there too: it's Nov 9 3 AM).
    const p = pkg("x", { etaEnd: "2026-11-09T04:00:00.000Z" });
    expect(groupOf(p, NOW, LA)).toBe("today");
    expect(groupOf(p, NOW, TOKYO)).toBe("today");
    // Nov 10, 4 AM UTC is Nov 9 (tomorrow) in LA.
    expect(groupOf(pkg("y", { etaEnd: "2026-11-10T04:00:00.000Z" }), NOW, LA)).toBe("tomorrow");
  });

  it("moves to Today at local midnight", () => {
    const p = pkg("x", { etaEnd: "2026-11-09T18:00:00.000Z" }); // Nov 9, 10 AM in LA
    expect(groupOf(p, new Date("2026-11-09T07:59:00.000Z"), LA)).toBe("tomorrow");
    expect(groupOf(p, new Date("2026-11-09T08:00:00.000Z"), LA)).toBe("today");
  });
});

describe("groupPackages", () => {
  it("returns groups in order and hides empty ones", () => {
    const groups = groupPackages(
      [
        pkg("later", {}),
        pkg("done", { status: "delivered", deliveredAt: "2026-11-07T20:00:00.000Z" }),
        pkg("today", { etaEnd: "2026-11-08", etaDateOnly: true }),
      ],
      NOW,
      LA,
    );
    expect(groups.map((g) => g.label)).toEqual(["Today", "Later", "Delivered"]);
  });

  it("pins problems first, then out for delivery, then soonest ETA, then newest update", () => {
    const [today] = groupPackages(
      [
        pkg("late-old", { etaEnd: "2026-11-05", updatedAt: "2026-11-01T00:00:00.000Z", etaDateOnly: true }),
        pkg("due-today-new", { etaEnd: "2026-11-08", updatedAt: "2026-11-08T17:00:00.000Z", etaDateOnly: true }),
        pkg("due-today-old", { etaEnd: "2026-11-08", updatedAt: "2026-11-08T09:00:00.000Z", etaDateOnly: true }),
        pkg("out", { status: "out_for_delivery" }),
        pkg("problem", { status: "exception", etaEnd: "2026-11-08", etaDateOnly: true }),
      ],
      NOW,
      LA,
    );
    expect(today && ids(today.packages)).toEqual(["problem", "out", "late-old", "due-today-new", "due-today-old"]);
  });

  it("puts packages with no ETA after dated ones in Later", () => {
    const [later] = groupPackages([pkg("none"), pkg("dated", { etaEnd: "2026-11-30", etaDateOnly: true })], NOW, LA);
    expect(later && ids(later.packages)).toEqual(["dated", "none"]);
  });

  it("sorts Delivered by newest delivery", () => {
    const [delivered] = groupPackages(
      [
        pkg("older", { status: "delivered", deliveredAt: "2026-11-02T20:00:00.000Z" }),
        pkg("newer", { status: "delivered", deliveredAt: "2026-11-08T16:00:00.000Z" }),
      ],
      NOW,
      LA,
    );
    expect(delivered && ids(delivered.packages)).toEqual(["newer", "older"]);
  });

  it("does not change its input", () => {
    const input = [pkg("b", { etaEnd: "2026-11-09", etaDateOnly: true }), pkg("a", { status: "out_for_delivery" })];
    groupPackages(input, NOW, LA);
    expect(ids(input)).toEqual(["b", "a"]);
  });
});

describe("etaPhrase", () => {
  it.each<[string, Partial<Package>, string, boolean]>([
    ["out for delivery", { status: "out_for_delivery" }, "Today", false],
    ["out for delivery with a window", { status: "out_for_delivery", etaEnd: "2026-11-09T04:00:00.000Z" }, "By 8:00 PM", false],
    ["out for delivery, window ending at midnight UTC", { status: "out_for_delivery", etaEnd: "2026-11-09T00:00:00.000Z" }, "By 4:00 PM", false],
    ["out for delivery, date-only ETA", { status: "out_for_delivery", etaEnd: "2026-11-08", etaDateOnly: true }, "Today", false],
    ["ETA today", { etaEnd: "2026-11-08", etaDateOnly: true }, "Today", false],
    ["ETA tomorrow", { etaEnd: "2026-11-09", etaDateOnly: true }, "Tomorrow", false],
    ["ETA within 6 days", { etaEnd: "2026-11-12", etaDateOnly: true }, "Thursday", false],
    ["ETA later", { etaEnd: "2026-11-21", etaDateOnly: true }, "Nov 21", false],
    ["overdue", { etaEnd: "2026-11-03", etaDateOnly: true }, "Was due Nov 3", true],
    ["no ETA", {}, "No date yet", true],
    ["delivered today", { status: "delivered", deliveredAt: "2026-11-08T17:14:00.000Z" }, "Delivered 9:14 AM", false],
    ["delivered this week", { status: "delivered", deliveredAt: "2026-11-03T22:14:00.000Z" }, "Delivered Tue", false],
    ["delivered earlier", { status: "delivered", deliveredAt: "2026-10-30T22:14:00.000Z" }, "Delivered Oct 30", false],
    ["delivered, no time", { status: "delivered" }, "Delivered", false],
  ])("%s", (_name, patch, text, muted) => {
    expect(etaPhrase(pkg("x", patch), NOW, LA)).toEqual({ text, muted });
  });

  it("puts a delivery late last night on yesterday's date, not today", () => {
    const p = pkg("x", { status: "delivered", deliveredAt: "2026-11-08T07:30:00.000Z" }); // Nov 7, 11:30 PM PST
    expect(etaPhrase(p, NOW, LA).text).toBe("Delivered Sat");
  });
});

describe("etaSentence", () => {
  it.each<[string, Partial<Package>, string]>([
    ["single date", { etaEnd: "2026-11-12", etaDateOnly: true }, "Arriving Thursday, Nov 12"],
    ["tomorrow", { etaEnd: "2026-11-09", etaDateOnly: true }, "Arriving tomorrow"],
    [
      "multi-day window",
      { etaStart: "2026-11-12", etaEnd: "2026-11-14", etaDateOnly: true },
      "Arriving between Thursday, Nov 12 and Saturday, Nov 14",
    ],
    [
      "same-day window with times",
      { etaStart: "2026-11-12T22:00:00.000Z", etaEnd: "2026-11-13T02:00:00.000Z" },
      "Arriving Thursday, Nov 12, 2:00 PM to 6:00 PM",
    ],
    ["window that already started", { etaStart: "2026-11-06", etaEnd: "2026-11-10", etaDateOnly: true }, "Arriving between today and Tuesday, Nov 10"],
    ["no ETA", {}, "No delivery date from UPS yet"],
    ["overdue", { etaEnd: "2026-11-03", etaDateOnly: true }, "Was due Tuesday, Nov 3"],
    ["out for delivery", { status: "out_for_delivery", etaEnd: "2026-11-09T04:00:00.000Z" }, "Arriving today by 8:00 PM"],
    ["ready for pickup", { status: "available_for_pickup" }, "Ready for pickup"],
    ["delivered today", { status: "delivered", deliveredAt: "2026-11-08T17:14:00.000Z" }, "Delivered today at 9:14 AM"],
    ["delivered this week", { status: "delivered", deliveredAt: "2026-11-03T22:14:00.000Z" }, "Delivered Tuesday at 2:14 PM"],
    ["delivered earlier", { status: "delivered", deliveredAt: "2026-10-20T22:14:00.000Z" }, "Delivered Oct 20 at 3:14 PM"],
  ])("%s", (_name, patch, sentence) => {
    expect(etaSentence(pkg("x", patch), "UPS", NOW, LA)).toBe(sentence);
  });
});
