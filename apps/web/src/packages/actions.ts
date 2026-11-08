// Package writes for the list, detail and add pages. Edits and archive are
// optimistic: the store changes at once and is rolled back if the PUT fails.
// Delete hides the package at once and removes it when the server agrees.
import type { CarrierId } from "@porchlight/carriers";
import { useCallback, useMemo, useRef } from "react";
import { isApiError } from "../api/client";
import type { Package, PackageConflict, RefreshResponse } from "../api/types";
import { usePackages } from "../data/packages";
import { useSession } from "../session";
import { rowTitle } from "./format";
import { pending } from "./pending";

/** The client-owned fields the pages edit (docs/API.md, Packages). */
export interface PackagePatch {
  title?: string | null;
  archived?: boolean;
}

export type AddResult = { kind: "created"; pkg: Package } | { kind: "duplicate"; existingId: string };

export interface AddInput {
  trackingNumber: string;
  /** Left out when the user didn't pick: the server then uses the top detected carrier. */
  carrier?: CarrierId;
  title?: string;
}

export function newPackageId(): string {
  return crypto.randomUUID();
}

/** The package as it should look right after `patch` is applied. */
export function applyPatch(pkg: Package, patch: PackagePatch, nowIso: string): Package {
  let next = pkg;
  if (patch.title !== undefined) next = { ...next, title: patch.title };
  if (patch.archived !== undefined) next = { ...next, archivedAt: patch.archived ? (pkg.archivedAt ?? nowIso) : null };
  return next;
}

/**
 * Undoes `patch` on `current`, field by field, but only where `current` still
 * holds the optimistic value; anything a sync changed since then is kept.
 */
export function revertPatch(current: Package, optimistic: Package, before: Package, patch: PackagePatch): Package {
  let next = current;
  if (patch.title !== undefined && current.title === optimistic.title) next = { ...next, title: before.title };
  if (patch.archived !== undefined && current.archivedAt === optimistic.archivedAt) {
    next = { ...next, archivedAt: before.archivedAt };
  }
  return next;
}

function conflictOf(err: unknown): PackageConflict | null {
  if (!isApiError(err, "conflict") || !err.details) return null;
  const d = err.details;
  if (d.reason === "duplicate" && typeof d.existingId === "string") return { reason: "duplicate", existingId: d.existingId };
  if (d.reason === "deleted") return { reason: "deleted" };
  return null;
}

export function usePackageActions() {
  const { api, expired } = useSession();
  const packages = usePackages();
  const latest = useRef(packages);
  latest.current = packages;

  const onError = useCallback(
    (err: unknown): never => {
      if (isApiError(err, "unauthorized")) expired();
      throw err;
    },
    [expired],
  );

  const update = useCallback(
    async (id: string, patch: PackagePatch): Promise<Package> => {
      const before = latest.current.get(id);
      if (!before) throw new Error("This package isn't loaded");
      const optimistic = applyPatch(before, patch, new Date().toISOString());
      latest.current.upsert(optimistic);
      try {
        const saved = await api.putPackage(id, patch);
        latest.current.upsert(saved);
        return saved;
      } catch (err) {
        const current = latest.current.get(id);
        if (current) latest.current.upsert(revertPatch(current, optimistic, before, patch));
        return onError(err);
      }
    },
    [api, onError],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      const before = latest.current.get(id);
      pending.notify(null);
      pending.hide(id);
      try {
        await api.deletePackage(id);
        latest.current.remove(id);
        pending.unhide(id);
      } catch (err) {
        if (isApiError(err, "not_found")) {
          // Already gone on the server (another device): finish the delete here too.
          latest.current.remove(id);
          pending.unhide(id);
          return;
        }
        pending.unhide(id);
        const name = before ? rowTitle(before) : "the package";
        pending.notify(`Couldn't delete ${name}. It's back in your list.`);
        onError(err);
      }
    },
    [api, onError],
  );

  const refresh = useCallback(
    async (id: string): Promise<RefreshResponse> => {
      try {
        return await api.refreshPackage(id);
      } catch (err) {
        return onError(err);
      }
    },
    [api, onError],
  );

  const add = useCallback(
    async (input: AddInput): Promise<AddResult> => {
      const body = {
        trackingNumber: input.trackingNumber,
        ...(input.carrier ? { carrier: input.carrier } : {}),
        ...(input.title ? { title: input.title } : {}),
        source: "manual" as const,
      };
      // A "deleted" conflict means the id was used before; ids are never reused, so take a fresh one once.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const pkg = await api.putPackage(newPackageId(), body);
          latest.current.upsert(pkg);
          return { kind: "created", pkg };
        } catch (err) {
          const conflict = conflictOf(err);
          if (conflict?.reason === "duplicate") return { kind: "duplicate", existingId: conflict.existingId };
          if (conflict?.reason === "deleted" && attempt === 0) continue;
          return onError(err);
        }
      }
      throw new Error("Couldn't save the package");
    },
    [api, onError],
  );

  return useMemo(() => ({ update, remove, refresh, add }), [update, remove, refresh, add]);
}
