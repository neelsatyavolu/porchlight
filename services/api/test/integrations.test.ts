import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { createSession } from "../src/lib/auth.js";
import { errorResponse, HttpError } from "../src/lib/http.js";
import { Router } from "../src/lib/router.js";
import * as authRoutes from "../src/routes/auth.js";
import * as integrationRoutes from "../src/routes/integrations.js";
import { seedUser } from "./poll-helpers.js";

const ORIGIN = "https://porchlight.xanom.co";
const testEnv = { ...env, APP_ORIGIN: ORIGIN } as Env;

const router = new Router();
authRoutes.register(router);
integrationRoutes.register(router);

interface CallOpts {
  token?: string;
  cookie?: string;
  origin?: string;
  body?: unknown;
}

async function call(method: string, path: string, o: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.cookie = `porchlight_session=${o.cookie}`;
  if (o.origin) headers.origin = o.origin;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`https://porchlight.test${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const ctx = createExecutionContext();
  try {
    return (await router.handle(req, testEnv, ctx)) ?? errorResponse(404, "not_found", "No such endpoint");
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, { ...err.headers }, err.details);
    throw err;
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = async (res: Response): Promise<any> => ((await res.json()) as { data: unknown }).data;
const PATH = "/v1/integrations/amazon";

describe("/v1/integrations/amazon", () => {
  it("is null until a device reports", async () => {
    const token = await createSession(env, await seedUser(env), null, Date.now(), "ios");
    const res = await call("GET", PATH, { token });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ amazon: null });
  });

  it("stores the latest report with the reporting device's platform", async () => {
    const userId = await seedUser(env);
    const mac = await createSession(env, userId, null, Date.now(), "macos");
    const web = await createSession(env, userId, null, Date.now(), "web");

    const put = await call("PUT", PATH, { token: mac, body: { state: "ok", lastImportAt: "2026-11-08T17:00:00.000Z" } });
    expect(put.status).toBe(200);
    const stored = (await data(put)).amazon;
    expect(stored).toMatchObject({ state: "ok", lastImportAt: "2026-11-08T17:00:00.000Z", lastError: null, platform: "macos" });
    expect(Object.keys(stored).sort()).toEqual(["lastError", "lastImportAt", "platform", "reportedAt", "state"]);

    const later = await call("PUT", PATH, {
      token: mac,
      body: { state: "needs_sign_in", lastImportAt: "2026-11-08T17:00:00.000Z", lastError: "Amazon asked you to sign in again." },
    });
    expect((await data(later)).amazon).toMatchObject({ state: "needs_sign_in", lastError: "Amazon asked you to sign in again." });

    // The web reads it with its cookie.
    const seen = await data(await call("GET", PATH, { cookie: web }));
    expect(seen.amazon).toMatchObject({ state: "needs_sign_in", lastImportAt: "2026-11-08T17:00:00.000Z", platform: "macos" });
  });

  it("drops error text from an ok report", async () => {
    const token = await createSession(env, await seedUser(env), null, Date.now(), "ios");
    const res = await call("PUT", PATH, { token, body: { state: "ok", lastImportAt: null, lastError: "left over" } });
    expect((await data(res)).amazon).toMatchObject({ state: "ok", lastImportAt: null, lastError: null, platform: "ios" });
  });

  it("keeps users apart", async () => {
    const a = await createSession(env, await seedUser(env), null, Date.now(), "ios");
    const b = await createSession(env, await seedUser(env), null, Date.now(), "ios");
    await call("PUT", PATH, { token: a, body: { state: "parse_failed", lastImportAt: null, lastError: "x" } });
    expect(await data(await call("GET", PATH, { token: b }))).toEqual({ amazon: null });
  });

  it("validates the body", async () => {
    const token = await createSession(env, await seedUser(env), null, Date.now(), "ios");
    for (const body of [
      { state: "fine", lastImportAt: null },
      { state: "ok" },
      { state: "ok", lastImportAt: "yesterday" },
      { state: "ok", lastImportAt: null, extra: 1 },
      { state: "parse_failed", lastImportAt: null, lastError: "x".repeat(301) },
    ]) {
      const res = await call("PUT", PATH, { token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("clears on DELETE", async () => {
    const token = await createSession(env, await seedUser(env), null, Date.now(), "ios");
    await call("PUT", PATH, { token, body: { state: "ok", lastImportAt: null } });
    const res = await call("DELETE", PATH, { token });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ deleted: true });
    expect(await data(await call("GET", PATH, { token }))).toEqual({ amazon: null });
  });

  it("needs a session, and the right Origin for cookie writes", async () => {
    expect((await call("GET", PATH)).status).toBe(401);
    expect((await call("PUT", PATH, { body: { state: "ok", lastImportAt: null } })).status).toBe(401);
    const web = await createSession(env, await seedUser(env), null, Date.now(), "web");
    expect((await call("PUT", PATH, { cookie: web, origin: "https://evil.example", body: { state: "ok", lastImportAt: null } })).status).toBe(403);
    expect((await call("DELETE", PATH, { cookie: web })).status).toBe(403);
  });

  it("is removed with the account", async () => {
    const userId = await seedUser(env);
    const token = await createSession(env, userId, null, Date.now(), "ios");
    await call("PUT", PATH, { token, body: { state: "ok", lastImportAt: null } });
    expect((await call("DELETE", "/v1/me", { token })).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM integrations WHERE user_id = ?").bind(userId).first()).toBeNull();
  });
});
