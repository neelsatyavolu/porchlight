// Test helpers for the auth and settings pages: a fake /v1 server and a router.
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";
import { createClient } from "../api/client";
import type { User } from "../api/types";
import { SessionProvider } from "../session";

export const USER: User = { id: "u1", email: "a@b.c", hasApple: false, createdAt: "2026-11-01T00:00:00.000Z" };

export function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data, error: null }), { status, headers: { "content-type": "application/json" } });
}

export function fail(status: number, code: string, message = code, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, data: null, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export type Handler = (body: unknown) => Response | Promise<Response>;

/** Routes "METHOD /v1/path" to a handler. GET /v1/me defaults to USER. Unknown routes answer 404. */
export function fakeApi(routes: Record<string, Handler>) {
  const all: Record<string, Handler> = { "GET /v1/me": () => ok({ user: USER }), ...routes };
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const handler = all[key];
    if (!handler) return fail(404, "not_found", `No route for ${key}`);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return handler(body);
  });
}

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

/** Renders `element` at `path` with a session backed by `fetch`, plus a /signin and /app landing. */
export function renderPage(element: ReactNode, opts: { path: string; route: string; fetch: typeof globalThis.fetch }) {
  return render(
    <MemoryRouter initialEntries={[opts.path]}>
      <SessionProvider client={createClient({ fetch: opts.fetch })}>
        <Routes>
          <Route path={opts.route} element={element} />
          <Route path="*" element={<p>landed</p>} />
        </Routes>
        <Where />
      </SessionProvider>
    </MemoryRouter>,
  );
}
