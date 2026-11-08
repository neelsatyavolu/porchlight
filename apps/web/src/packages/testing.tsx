// Test helpers for the package pages: a package factory, a fake /v1 server
// behind the real client, and a renderer with a fixed clock and time zone.
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";
import { createClient } from "../api/client";
import type { Package, PackageEvent } from "../api/types";
import { PackagesProvider } from "../data/packages";
import { SessionProvider } from "../session";
import { FixedClock } from "./clock";

export const TZ = "America/Los_Angeles";
/** Sunday, Nov 8 2026, 10:00 AM in Los Angeles. */
export const NOW = new Date("2026-11-08T18:00:00.000Z");

export function makePackage(id: string, patch: Partial<Package> = {}): Package {
  return {
    id,
    carrier: "ups",
    trackingNumber: `1Z999AA1012345${id.padStart(4, "0").slice(-4)}`,
    title: null,
    merchant: null,
    orderId: null,
    source: "manual",
    status: "in_transit",
    statusDetail: null,
    etaStart: null,
    etaEnd: null,
    etaDateOnly: false,
    deliveredAt: null,
    lastCheckedAt: null,
    archivedAt: null,
    updatedAt: "2026-11-08T17:00:00.000Z",
    items: [],
    ...patch,
  };
}

export function makeEvent(id: string, packageId: string, occurredAt: string, patch: Partial<PackageEvent> = {}): PackageEvent {
  return { id, packageId, occurredAt, status: "in_transit", description: id, location: null, ...patch };
}

export interface FakeResponse {
  status: number;
  data?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  headers?: Record<string, string>;
}

export type Handler = (method: string, path: string, body: unknown) => FakeResponse | Promise<FakeResponse> | undefined;

const USER = { id: "u1", email: "a@b.c", hasApple: false, createdAt: "2026-11-01T00:00:00.000Z" };

/** A fetch that answers /me and /sync from `packages`/`events`, then defers to `handler`. */
export function fakeServer(options: { packages?: Package[]; events?: PackageEvent[]; handler?: Handler } = {}) {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const path = url.replace(/^\/v1/, "");
    let res: FakeResponse | undefined = await options.handler?.(method, path, body);
    if (!res && path === "/me") res = { status: 200, data: { user: USER } };
    if (!res && path.startsWith("/sync")) {
      const first = !path.includes("since=");
      res = {
        status: 200,
        data: {
          packages: first ? (options.packages ?? []) : [],
          events: first ? (options.events ?? []) : [],
          deleted: [],
          cursor: "c1",
          hasMore: false,
        },
      };
    }
    res ??= { status: 404, error: { code: "not_found", message: "No such endpoint" } };
    const envelope = res.error ? { ok: false, data: null, error: res.error } : { ok: true, data: res.data, error: null };
    return new Response(JSON.stringify(envelope), {
      status: res.status,
      headers: { "content-type": "application/json", ...res.headers },
    });
  });
  return fetch;
}

export function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname}</output>;
}

/** Renders `routes` under /app with session, packages and a fixed clock. */
export function renderPages(
  path: string,
  routes: ReactNode,
  fetch: ReturnType<typeof fakeServer>,
  clock: { now?: Date; timeZone?: string } = {},
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider client={createClient({ fetch })}>
        <PackagesProvider pollMs={3_600_000}>
          <FixedClock now={clock.now ?? NOW} timeZone={clock.timeZone ?? TZ}>
            <Routes>
              {routes}
              <Route path="*" element={null} />
            </Routes>
            <Where />
          </FixedClock>
        </PackagesProvider>
      </SessionProvider>
    </MemoryRouter>,
  );
}

/** Calls to `fetch` other than /me and /sync, as [method, path, body]. */
export function writes(fetch: ReturnType<typeof fakeServer>): Array<[string, string, unknown]> {
  return fetch.mock.calls
    .map(([input, init]) => [init?.method ?? "GET", String(input).replace(/^\/v1/, ""), init?.body ? JSON.parse(String(init.body)) : undefined] as [string, string, unknown])
    .filter(([method]) => method !== "GET");
}
