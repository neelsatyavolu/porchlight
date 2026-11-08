import { describe, expect, it, vi } from "vitest";
import { ApiError, createClient, isApiError } from "./client";

function envelope(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ ok: true, data, error: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function failure(status: number, code: string, message: string, extra: object = {}, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ ok: false, data: null, error: { code, message, ...extra } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("api client", () => {
  it("sends cookies and JSON, and unwraps the envelope", async () => {
    const fetch = vi.fn(async () => envelope({ id: "p1" }, 201));
    const client = createClient({ fetch });

    const pkg = await client.putPackage("p1", { trackingNumber: "1Z999AA10123456784" });

    expect(pkg).toEqual({ id: "p1" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/packages/p1");
    expect(init.method).toBe("PUT");
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ trackingNumber: "1Z999AA10123456784" });
  });

  it("always signs in as the web client", async () => {
    const fetch = vi.fn(async () => envelope({ sent: true }, 202));
    await createClient({ fetch }).emailStart("a@b.c");
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.c", client: "web" });
  });

  it("turns an error envelope into ApiError with details and Retry-After", async () => {
    const fetch = vi.fn(async () =>
      failure(429, "rate_limited", "Too many refreshes", { details: { scope: "refresh" } }, { "retry-after": "90" }),
    );
    const err = await createClient({ fetch }).refreshPackage("p1").catch((e: unknown) => e);

    expect(isApiError(err, "rate_limited")).toBe(true);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(429);
    expect(apiErr.message).toBe("Too many refreshes");
    expect(apiErr.details).toEqual({ scope: "refresh" });
    expect(apiErr.retryAfter).toBe(90);
  });

  it("exposes 409 duplicate details so the caller can adopt existingId", async () => {
    const fetch = vi.fn(async () =>
      failure(409, "conflict", "Already tracking", { details: { reason: "duplicate", existingId: "p0" } }),
    );
    const err = await createClient({ fetch }).putPackage("p1", { trackingNumber: "x" }).catch((e: unknown) => e);
    expect(isApiError(err, "conflict") && err.details).toEqual({ reason: "duplicate", existingId: "p0" });
  });

  it("reports a network failure as code network", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const err = await createClient({ fetch }).me().catch((e: unknown) => e);
    expect(isApiError(err, "network")).toBe(true);
    expect((err as ApiError).status).toBe(0);
  });

  it("rejects a body that is not an envelope", async () => {
    const fetch = vi.fn(async () => new Response("<html>", { status: 502 }));
    const err = await createClient({ fetch }).me().catch((e: unknown) => e);
    expect(isApiError(err, "invalid_response")).toBe(true);
  });

  it("follows hasMore until the last page", async () => {
    const pages = [
      { packages: [{ id: "a" }], events: [], deleted: [], cursor: "c1", hasMore: true },
      { packages: [{ id: "b" }], events: [], deleted: ["z"], cursor: "c2", hasMore: false },
    ];
    const fetch = vi.fn(async () => envelope(pages.shift()));
    const result = await createClient({ fetch }).syncAll();

    expect(result.packages.map((p) => p.id)).toEqual(["a", "b"]);
    expect(result.deleted).toEqual(["z"]);
    expect(result.cursor).toBe("c2");
    const urls = fetch.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls).toEqual(["/v1/sync", "/v1/sync?since=c1"]);
  });

  it("keeps one copy of a package that comes back on a later page, so its events are not doubled", async () => {
    const ev = (id: string, packageId: string) => ({ id, packageId, occurredAt: "2026-11-08T09:00:00.000Z" });
    const pages = [
      { packages: [{ id: "a", title: "old" }, { id: "b" }], events: [ev("e1", "a"), ev("e2", "b")], deleted: [], cursor: "c1", hasMore: true },
      // "a" gained an event between the two calls, so the server sends it again with every event.
      { packages: [{ id: "a", title: "new" }], events: [ev("e1", "a"), ev("e3", "a")], deleted: ["b"], cursor: "c2", hasMore: false },
    ];
    const fetch = vi.fn(async () => envelope(pages.shift()));
    const result = await createClient({ fetch }).syncAll("c0");

    expect(result.packages).toEqual([{ id: "a", title: "new" }]);
    expect(result.events.map((e) => e.id)).toEqual(["e1", "e3"]);
    expect(result.deleted).toEqual(["b"]);
  });

  it("encodes ids in paths", async () => {
    const fetch = vi.fn(async () => envelope({ deleted: true }));
    await createClient({ fetch, baseUrl: "http://localhost:8787/v1" }).deleteToken("a/b");
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("http://localhost:8787/v1/tokens/a%2Fb");
  });
});
