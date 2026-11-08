import { describe, expect, it } from "vitest";
import type { Package, PackageEvent } from "../api/types";
import { applySync, EMPTY_STORE, removePackage, upsertPackage } from "./store";

function pkg(id: string, patch: Partial<Package> = {}): Package {
  return {
    id,
    carrier: "ups",
    trackingNumber: `1Z${id}`,
    title: null,
    merchant: null,
    orderId: null,
    source: "manual",
    status: "in_transit",
    statusDetail: null,
    etaStart: null,
    etaEnd: null,
    deliveredAt: null,
    lastCheckedAt: null,
    archivedAt: null,
    updatedAt: "2026-11-08T17:00:00.000Z",
    items: [],
    ...patch,
  };
}

function ev(id: string, packageId: string, occurredAt: string): PackageEvent {
  return { id, packageId, occurredAt, status: "in_transit", description: id, location: null };
}

describe("package store", () => {
  it("loads a full sync with events newest first", () => {
    const store = applySync(EMPTY_STORE, {
      packages: [pkg("a")],
      events: [ev("old", "a", "2026-11-07T10:00:00.000Z"), ev("new", "a", "2026-11-08T10:00:00.000Z")],
      deleted: [],
      cursor: "c1",
    });
    expect(store.packages.get("a")?.id).toBe("a");
    expect(store.events.get("a")?.map((e) => e.id)).toEqual(["new", "old"]);
    expect(store.cursor).toBe("c1");
  });

  it("replaces a package's events wholesale and drops deleted packages", () => {
    const first = applySync(EMPTY_STORE, {
      packages: [pkg("a"), pkg("b")],
      events: [ev("e1", "a", "2026-11-07T10:00:00.000Z")],
      deleted: [],
      cursor: "c1",
    });
    const second = applySync(first, {
      packages: [pkg("a", { status: "delivered" })],
      events: [ev("e2", "a", "2026-11-08T10:00:00.000Z")],
      deleted: ["b"],
      cursor: "c2",
    });
    expect(second.packages.get("a")?.status).toBe("delivered");
    expect(second.events.get("a")?.map((e) => e.id)).toEqual(["e2"]);
    expect(second.packages.has("b")).toBe(false);
    expect(first.packages.has("b")).toBe(true);
  });

  it("keeps events on a local upsert and clears them on remove", () => {
    const loaded = applySync(EMPTY_STORE, {
      packages: [pkg("a")],
      events: [ev("e1", "a", "2026-11-07T10:00:00.000Z")],
      deleted: [],
      cursor: "c1",
    });
    const renamed = upsertPackage(loaded, pkg("a", { title: "Lamp" }));
    expect(renamed.packages.get("a")?.title).toBe("Lamp");
    expect(renamed.events.get("a")).toHaveLength(1);
    expect(removePackage(renamed, "a").packages.size).toBe(0);
  });

  it("keeps a newer copy written by this client when a slower sync returns an older one", () => {
    const fresh = pkg("a", { title: "Renamed", updatedAt: "2026-11-08T17:05:00.000Z" });
    const store = upsertPackage(applySync(EMPTY_STORE, { packages: [pkg("a")], events: [ev("e1", "a", "2026-11-08T09:00:00.000Z")], deleted: [], cursor: "c1" }), fresh);
    const next = applySync(store, { packages: [pkg("a", { title: "Old" })], events: [], deleted: [], cursor: "c2" });
    expect(next.packages.get("a")?.title).toBe("Renamed");
    expect(next.events.get("a")?.map((e) => e.id)).toEqual(["e1"]);
    expect(next.cursor).toBe("c2");
  });

  it("does not bring back a package this client deleted when an older sync lists it", () => {
    const loaded = applySync(EMPTY_STORE, { packages: [pkg("a"), pkg("b")], events: [], deleted: [], cursor: "c1" });
    const next = applySync(removePackage(loaded, "a"), { packages: [pkg("a"), pkg("b", { title: "B" })], events: [], deleted: [], cursor: "c2" });
    expect([...next.packages.keys()]).toEqual(["b"]);
    expect(next.packages.get("b")?.title).toBe("B");
  });
});
