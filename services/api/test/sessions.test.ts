import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { createSession } from "../src/lib/auth.js";
import { errorResponse, HttpError } from "../src/lib/http.js";
import { Router } from "../src/lib/router.js";
import * as authRoutes from "../src/routes/auth.js";
import * as sessionRoutes from "../src/routes/sessions.js";
import { seedUser } from "./poll-helpers.js";

const ORIGIN = "https://porchlight.xanom.co";
const testEnv = { ...env, APP_ORIGIN: ORIGIN } as Env;

const router = new Router();
authRoutes.register(router);
sessionRoutes.register(router);

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

interface SessionJson {
  id: string;
  platform: string | null;
  appVersion: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

const list = async (token: string): Promise<SessionJson[]> => (await data(await call("GET", "/v1/sessions", { token }))).sessions;

describe("GET /v1/sessions", () => {
  it("lists the user's sessions with platform, app version and which one is current", async () => {
    const userId = await seedUser(env);
    const t0 = Date.parse("2026-11-01T10:00:00.000Z");
    const web = await createSession(env, userId, null, t0, "web");
    const phone = await createSession(env, userId, null, t0 + 60_000, "ios");
    const deviceId = crypto.randomUUID();
    const put = await call("PUT", `/v1/devices/${deviceId}`, { token: phone, body: { platform: "ios", apnsToken: null, appVersion: "1.0 (7)" } });
    expect(put.status).toBe(200);
    await createSession(env, await seedUser(env), null, t0, "macos"); // someone else's

    const sessions = await list(web);
    expect(sessions).toHaveLength(2);
    const byPlatform = Object.fromEntries(sessions.map((s) => [s.platform, s]));
    expect(byPlatform.web).toMatchObject({ appVersion: null, createdAt: "2026-11-01T10:00:00.000Z", current: true });
    expect(byPlatform.ios).toMatchObject({ appVersion: "1.0 (7)", createdAt: "2026-11-01T10:01:00.000Z", current: false });
    for (const s of sessions) {
      expect(s.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(Object.keys(s).sort()).toEqual(["appVersion", "createdAt", "current", "id", "lastSeenAt", "platform"]);
    }
  });

  it("requires a session", async () => {
    expect((await call("GET", "/v1/sessions")).status).toBe(401);
  });
});

describe("DELETE /v1/sessions/:id", () => {
  it("signs another session out and removes its device, leaving the current one", async () => {
    const userId = await seedUser(env);
    const mine = await createSession(env, userId, null, Date.now(), "web");
    const phone = await createSession(env, userId, null, Date.now(), "ios");
    const deviceId = crypto.randomUUID();
    await call("PUT", `/v1/devices/${deviceId}`, { token: phone, body: { platform: "ios", apnsToken: "abcdef0123456789", appVersion: null } });
    const target = (await list(mine)).find((s) => !s.current)!;

    const res = await call("DELETE", `/v1/sessions/${target.id.toUpperCase()}`, { token: mine });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ deleted: true, signedOut: false });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await call("GET", "/v1/me", { token: phone })).status).toBe(401);
    expect((await call("GET", "/v1/me", { token: mine })).status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM devices WHERE id = ?").bind(deviceId).first()).toBeNull();
  });

  it("keeps a device another session of the user still uses", async () => {
    const userId = await seedUser(env);
    const deviceId = crypto.randomUUID();
    const old = await createSession(env, userId, deviceId, Date.now(), "ios");
    const fresh = await createSession(env, userId, deviceId, Date.now(), "ios");
    await call("PUT", `/v1/devices/${deviceId}`, { token: fresh, body: { platform: "ios", apnsToken: null, appVersion: null } });
    const oldId = (await list(old)).find((s) => s.current)!.id;
    expect((await call("DELETE", `/v1/sessions/${oldId}`, { token: fresh })).status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM devices WHERE id = ?").bind(deviceId).first()).not.toBeNull();
  });

  it("deleting the current session signs out and clears the web cookie", async () => {
    const userId = await seedUser(env);
    const cookie = await createSession(env, userId, null, Date.now(), "web");
    const current = (await data(await call("GET", "/v1/sessions", { cookie }))).sessions[0] as SessionJson;
    expect((await call("DELETE", `/v1/sessions/${current.id}`, { cookie })).status).toBe(403); // no Origin
    const res = await call("DELETE", `/v1/sessions/${current.id}`, { cookie, origin: ORIGIN });
    expect(await data(res)).toEqual({ deleted: true, signedOut: true });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("GET", "/v1/me", { cookie })).status).toBe(401);
  });

  it("answers 404 for another user's session and leaves it alone, and 400 for a bad id", async () => {
    const alice = await createSession(env, await seedUser(env), null, Date.now(), "web");
    const bob = await createSession(env, await seedUser(env), null, Date.now(), "ios");
    const bobsId = (await list(bob))[0]!.id;
    expect((await call("DELETE", `/v1/sessions/${bobsId}`, { token: alice })).status).toBe(404);
    expect((await call("DELETE", `/v1/sessions/${crypto.randomUUID()}`, { token: alice })).status).toBe(404);
    expect((await call("DELETE", "/v1/sessions/not-a-uuid", { token: alice })).status).toBe(400);
    expect((await call("GET", "/v1/me", { token: bob })).status).toBe(200);
  });
});
