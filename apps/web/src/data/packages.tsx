// Shared package data for every signed-in page. Full sync on mount, then the
// cursor every 60 s while the tab is visible (SPEC §3), and once on refocus.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isApiError, type FullSync } from "../api/client";
import type { Package, PackageEvent } from "../api/types";
import { useSession } from "../session";
import { applySync, EMPTY_STORE, removePackage, upsertPackage, type PackageStore } from "./store";

export const POLL_MS = 60_000;

export type LoadState = "loading" | "ready" | "error";

export interface PackagesValue {
  load: LoadState;
  /** The last failure message; stays set while showing stale data. */
  error: string | null;
  /** Every live package, archived included. */
  packages: readonly Package[];
  get: (id: string) => Package | undefined;
  /** Newest first. */
  eventsFor: (id: string) => readonly PackageEvent[];
  /** Pull changes now. */
  sync: () => Promise<void>;
  /** Write-through helpers for pages that just called the API. */
  upsert: (pkg: Package) => void;
  remove: (id: string) => void;
}

const PackagesContext = createContext<PackagesValue | null>(null);

const NO_EVENTS: readonly PackageEvent[] = [];

export function PackagesProvider({ children, pollMs = POLL_MS }: { children: ReactNode; pollMs?: number }) {
  const { api, expired } = useSession();
  const [store, setStore] = useState<PackageStore>(EMPTY_STORE);
  const [load, setLoad] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const sync = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        let restart = false;
        let result: FullSync;
        try {
          result = await api.syncAll(cursorRef.current ?? undefined);
        } catch (err) {
          if (cursorRef.current === null || !isApiError(err, "bad_request")) throw err;
          // Unknown cursor: the contract says to start over with a full sync. The
          // snapshot replaces the store; the list keeps showing until it arrives.
          cursorRef.current = null;
          restart = true;
          result = await api.syncAll();
        }
        if (result.cursor) cursorRef.current = result.cursor;
        setStore((prev) => applySync(restart ? { ...EMPTY_STORE, removed: prev.removed } : prev, result));
        setLoad("ready");
        setError(null);
      } catch (err) {
        if (isApiError(err, "unauthorized")) {
          expired();
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setLoad((prev) => (prev === "ready" ? "ready" : "error"));
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, [api, expired]);

  useEffect(() => {
    void sync();
    const tick = () => {
      if (document.visibilityState === "visible") void sync();
    };
    const timer = window.setInterval(tick, pollMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [sync, pollMs]);

  const upsert = useCallback((pkg: Package) => setStore((prev) => upsertPackage(prev, pkg)), []);
  const remove = useCallback((id: string) => setStore((prev) => removePackage(prev, id)), []);

  const value = useMemo<PackagesValue>(
    () => ({
      load,
      error,
      packages: Array.from(store.packages.values()),
      get: (id) => store.packages.get(id),
      eventsFor: (id) => store.events.get(id) ?? NO_EVENTS,
      sync,
      upsert,
      remove,
    }),
    [store, load, error, sync, upsert, remove],
  );
  return <PackagesContext.Provider value={value}>{children}</PackagesContext.Provider>;
}

export function usePackages(): PackagesValue {
  const value = useContext(PackagesContext);
  if (!value) throw new Error("usePackages must be used inside <PackagesProvider>");
  return value;
}
