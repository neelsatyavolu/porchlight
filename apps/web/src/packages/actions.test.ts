import { describe, expect, it } from "vitest";
import { applyPatch, revertPatch } from "./actions";
import { makePackage as pkg } from "./testing";

const NOW = "2026-11-08T18:00:00.000Z";

describe("applyPatch", () => {
  it("sets the title and archive time without touching the original", () => {
    const before = pkg("a", { title: "Lamp" });
    const next = applyPatch(before, { title: "Desk lamp", archived: true }, NOW);
    expect(next).toMatchObject({ title: "Desk lamp", archivedAt: NOW });
    expect(before).toMatchObject({ title: "Lamp", archivedAt: null });
  });

  it("keeps an existing archive time and clears it on unarchive", () => {
    const archived = pkg("a", { archivedAt: "2026-11-01T00:00:00.000Z" });
    expect(applyPatch(archived, { archived: true }, NOW).archivedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(applyPatch(archived, { archived: false }, NOW).archivedAt).toBeNull();
  });
});

describe("revertPatch", () => {
  it("undoes only the fields it changed", () => {
    const before = pkg("a", { title: "Lamp" });
    const optimistic = applyPatch(before, { title: "Desk lamp" }, NOW);
    // A sync arrived meanwhile with a new status.
    const current = { ...optimistic, status: "delivered" as const };
    expect(revertPatch(current, optimistic, before, { title: "Desk lamp" })).toMatchObject({ title: "Lamp", status: "delivered" });
  });

  it("keeps a value another device wrote after the optimistic one", () => {
    const before = pkg("a", { title: "Lamp" });
    const optimistic = applyPatch(before, { title: "Desk lamp" }, NOW);
    const current = { ...optimistic, title: "Renamed on iPhone" };
    expect(revertPatch(current, optimistic, before, { title: "Desk lamp" }).title).toBe("Renamed on iPhone");
  });

  it("restores the archive time", () => {
    const before = pkg("a");
    const optimistic = applyPatch(before, { archived: true }, NOW);
    expect(revertPatch(optimistic, optimistic, before, { archived: true }).archivedAt).toBeNull();
  });
});
