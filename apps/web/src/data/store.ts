// Pure sync bookkeeping for the web's in-memory package list (SPEC §3: the web
// keeps no local store; it full-syncs on load, then follows the cursor).
import type { FullSync } from "../api/client";
import type { Package, PackageEvent } from "../api/types";

export interface PackageStore {
  /** Keyed by package id. Archived packages are included; views filter them. */
  packages: ReadonlyMap<string, Package>;
  /** Newest first, keyed by package id. */
  events: ReadonlyMap<string, readonly PackageEvent[]>;
  cursor: string | null;
  /**
   * Ids this client deleted. Package ids are never reused (docs/API.md), so a
   * sync that started before the DELETE and still lists one is ignored for it.
   */
  removed: ReadonlySet<string>;
}

export const EMPTY_STORE: PackageStore = { packages: new Map(), events: new Map(), cursor: null, removed: new Set() };

function newestFirst(a: PackageEvent, b: PackageEvent): number {
  return Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
}

/** True when `incoming` is an older copy than the one held, e.g. a sync that started before a PUT returned. */
function isStale(held: Package | undefined, incoming: Package): boolean {
  return held !== undefined && Date.parse(held.updatedAt) > Date.parse(incoming.updatedAt);
}

/**
 * Applies a sync result. Each returned package replaces its events wholesale
 * (docs/API.md, Sync), unless the store already holds a newer copy of it.
 */
export function applySync(store: PackageStore, sync: FullSync): PackageStore {
  const packages = new Map(store.packages);
  const events = new Map(store.events);

  const incoming = new Map<string, PackageEvent[]>();
  for (const e of sync.events) incoming.set(e.packageId, [...(incoming.get(e.packageId) ?? []), e]);

  for (const pkg of sync.packages) {
    if (store.removed.has(pkg.id) || isStale(packages.get(pkg.id), pkg)) continue;
    packages.set(pkg.id, pkg);
    events.set(pkg.id, [...(incoming.get(pkg.id) ?? [])].sort(newestFirst));
  }
  for (const id of sync.deleted) {
    packages.delete(id);
    events.delete(id);
  }
  return { ...store, packages, events, cursor: sync.cursor || store.cursor };
}

/** Puts a package the client just wrote (PUT response) into the store, keeping its events. */
export function upsertPackage(store: PackageStore, pkg: Package): PackageStore {
  const packages = new Map(store.packages);
  packages.set(pkg.id, pkg);
  return { ...store, packages };
}

export function removePackage(store: PackageStore, id: string): PackageStore {
  const packages = new Map(store.packages);
  const events = new Map(store.events);
  packages.delete(id);
  events.delete(id);
  return { ...store, packages, events, removed: new Set([...store.removed, id]) };
}
