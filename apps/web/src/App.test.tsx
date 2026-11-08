import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "./api/client";
import { App } from "./App";
import { SessionProvider } from "./session";

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const USER = { id: "u1", email: "a@b.c", hasApple: false, createdAt: "2026-11-08T00:00:00.000Z" };
const EMPTY_SYNC = { packages: [], events: [], deleted: [], cursor: "c0", hasMore: false };

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

function renderAt(path: string, fetch: typeof globalThis.fetch) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider client={createClient({ fetch })}>
        <App />
        <Where />
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe("App routes", () => {
  it("sends a signed-out visitor from /app to /signin with next", async () => {
    const fetch = vi.fn(async () => respond(401, { ok: false, data: null, error: { code: "unauthorized", message: "Sign in" } }));
    renderAt("/app/settings", fetch);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/signin?next=%2Fapp%2Fsettings"));
  });

  it("shows the shell and syncs for a signed-in user", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path === "/v1/me") return respond(200, { ok: true, data: { user: USER }, error: null });
      if (path.startsWith("/v1/sync")) return respond(200, { ok: true, data: EMPTY_SYNC, error: null });
      return respond(404, { ok: false, data: null, error: { code: "not_found", message: "No such endpoint" } });
    });
    renderAt("/app/p/abc", fetch);
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/v1/sync", expect.anything()));
  });

  it("serves the API's magic-link path with the verify page", () => {
    const fetch = vi.fn(async () => respond(401, { ok: false, data: null, error: { code: "unauthorized", message: "x" } }));
    renderAt("/auth/verify?token=t", fetch);
    expect(screen.getByRole("heading", { name: "Signing you in" })).toBeInTheDocument();
  });

  it("offers a retry when /me fails for another reason", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    renderAt("/app", fetch);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
