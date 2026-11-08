import { describe, expect, it } from "vitest";
import {
  ago,
  clockTime,
  dayNumberOf,
  daysFromToday,
  etaDayNumber,
  isDateOnly,
  monthDay,
  shortDayHeader,
  weekdayMonthDay,
  weekdayName,
} from "./time";

const LA = "America/Los_Angeles";
const TOKYO = "Asia/Tokyo";
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86_400_000;

describe("dayNumberOf", () => {
  it("uses the calendar day in the given zone", () => {
    const lateEvening = new Date("2026-11-09T07:30:00.000Z"); // Nov 8, 11:30 PM in LA; Nov 9, 4:30 PM in Tokyo
    expect(dayNumberOf(lateEvening, LA)).toBe(day(2026, 11, 8));
    expect(dayNumberOf(lateEvening, TOKYO)).toBe(day(2026, 11, 9));
    expect(dayNumberOf(lateEvening, "UTC")).toBe(day(2026, 11, 9));
  });
});

describe("etaDayNumber", () => {
  it("reads a date-only ETA (midnight UTC) by its UTC date, in every zone", () => {
    const eta = "2026-11-10T00:00:00.000Z";
    expect(isDateOnly(eta)).toBe(true);
    expect(etaDayNumber(eta, LA)).toBe(day(2026, 11, 10));
    expect(etaDayNumber(eta, TOKYO)).toBe(day(2026, 11, 10));
    // Read naively, the same instant is Nov 9 in LA.
    expect(dayNumberOf(new Date(eta), LA)).toBe(day(2026, 11, 9));
  });

  it("reads an ETA with a time in the viewer's zone", () => {
    const eta = "2026-11-10T03:00:00.000Z"; // Nov 9, 7 PM in LA
    expect(isDateOnly(eta)).toBe(false);
    expect(etaDayNumber(eta, LA)).toBe(day(2026, 11, 9));
    expect(etaDayNumber(eta, TOKYO)).toBe(day(2026, 11, 10));
  });
});

describe("daysFromToday", () => {
  it("counts calendar days, not 24-hour blocks", () => {
    const now = new Date("2026-11-08T18:00:00.000Z"); // Sun 10 AM in LA
    expect(daysFromToday(day(2026, 11, 8), now, LA)).toBe(0);
    expect(daysFromToday(day(2026, 11, 9), now, LA)).toBe(1);
    expect(daysFromToday(day(2026, 11, 7), now, LA)).toBe(-1);
  });

  it("is not skewed by the end of daylight saving time (Nov 1, 2026 in the US)", () => {
    const now = new Date("2026-10-31T19:00:00.000Z"); // Sat Oct 31, noon PDT
    const tuesdayMorning = new Date("2026-11-03T08:30:00.000Z"); // Tue Nov 3, 12:30 AM PST
    expect(daysFromToday(dayNumberOf(tuesdayMorning, LA), now, LA)).toBe(3);
  });

  it("changes at local midnight, not UTC midnight", () => {
    const beforeMidnight = new Date("2026-11-09T07:59:00.000Z"); // Nov 8, 11:59 PM PST
    const afterMidnight = new Date("2026-11-09T08:01:00.000Z"); // Nov 9, 12:01 AM PST
    expect(daysFromToday(day(2026, 11, 9), beforeMidnight, LA)).toBe(1);
    expect(daysFromToday(day(2026, 11, 9), afterMidnight, LA)).toBe(0);
  });
});

describe("day names", () => {
  it("formats weekdays and dates without a zone shift", () => {
    expect(weekdayName(day(2026, 11, 12))).toBe("Thursday");
    expect(weekdayMonthDay(day(2026, 11, 12), day(2026, 11, 8))).toBe("Thursday, Nov 12");
    expect(shortDayHeader(day(2026, 11, 8), day(2026, 11, 8))).toBe("Sun, Nov 8");
  });

  it("adds the year only when it differs from today's", () => {
    expect(monthDay(day(2026, 11, 21), day(2026, 11, 8))).toBe("Nov 21");
    expect(monthDay(day(2027, 1, 3), day(2026, 12, 30))).toBe("Jan 3, 2027");
  });

  it("formats clock times in the zone", () => {
    expect(clockTime("2026-11-08T22:14:00.000Z", LA)).toBe("2:14 PM");
    expect(clockTime("2026-11-08T22:14:00.000Z", TOKYO)).toBe("7:14 AM");
  });
});

describe("ago", () => {
  const now = new Date("2026-11-08T18:00:00.000Z");
  it.each([
    ["2026-11-08T17:59:30.000Z", "just now"],
    ["2026-11-08T18:00:30.000Z", "just now"], // clock skew
    ["2026-11-08T17:46:00.000Z", "14 min ago"],
    ["2026-11-08T17:00:01.000Z", "59 min ago"],
    ["2026-11-08T15:00:00.000Z", "3 h ago"],
    ["2026-11-07T17:00:00.000Z", "1 day ago"],
    ["2026-11-05T18:00:00.000Z", "3 days ago"],
  ])("%s reads %s", (iso, expected) => {
    expect(ago(iso, now)).toBe(expected);
  });
});
