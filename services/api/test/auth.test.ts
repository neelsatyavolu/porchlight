import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { errorResponse, HttpError } from "../src/lib/http.js";
import { Router } from "../src/lib/router.js";
import * as authRoutes from "../src/routes/auth.js";
import { setAppleFetch } from "../src/lib/apple.js";
import { sha256Hex } from "../src/lib/auth.js";
import { base64UrlEncode, base64UrlEncodeText } from "../src/lib/crypto.js";
import { setResendFetch } from "../src/lib/resend.js";

const ORIGIN = "https://porchlight.xanom.co";
const AUD = "co.xanom.porchlight";
const testEnv = { ...env, APP_ORIGIN: ORIGIN, APPLE_CLIENT_IDS: `${AUD}, co.xanom.porchlight.web`, RESEND_API_KEY: "re_test" } as Env;

interface CallOpts {
  body?: unknown;
  token?: string;
  cookie?: string;
  origin?: string;
  ip?: string;
  env?: Env;
}

async function call(method: string, path: string, o: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": o.ip ?? `10.0.${Math.random()}` };
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.cookie = `porchlight_session=${o.cookie}`;
  if (o.origin) headers.origin = o.origin;
  const req = new Request(`https://porchlight.test${path}`, {
    method,
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const ctx = createExecutionContext();
  const res = await handle(req, o.env ?? testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// Mirrors src/index.ts error handling with only the routes under test, so
// these tests do not depend on modules other agents are still writing.
const router = new Router();
authRoutes.register(router);
async function handle(req: Request, e: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    return (await router.handle(req, e, ctx)) ?? errorResponse(404, "not_found", "No such endpoint");
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, { ...err.headers }, err.details);
    throw err;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<any> => res.json();

// ---- Apple test key --------------------------------------------------------

let appleKey: CryptoKeyPair;
let otherKey: CryptoKeyPair;
const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

beforeAll(async () => {
  appleKey = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  otherKey = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", appleKey.publicKey)) as JsonWebKey;
  setAppleFetch(async (input) => {
    expect(String(input)).toBe("https://appleid.apple.com/auth/keys");
    return Response.json({ keys: [{ ...jwk, kid: "test-kid", alg: "RS256", use: "sig" }] });
  });
});

async function appleToken(claims: Record<string, unknown>, key: CryptoKey = appleKey.privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "https://appleid.apple.com",
    aud: AUD,
    iat: now,
    exp: now + 600,
    sub: `apple-${crypto.randomUUID()}`,
    nonce: await sha256Hex("raw-nonce"),
    ...claims,
  };
  const head = `${base64UrlEncodeText(JSON.stringify({ alg: "RS256", kid: "test-kid" }))}.${base64UrlEncodeText(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head));
  return `${head}.${base64UrlEncode(new Uint8Array(sig))}`;
}

const appleSignIn = async (token: string, client = "ios", extra: Record<string, unknown> = {}) =>
  call("POST", "/v1/auth/apple", { body: { identityToken: token, nonce: "raw-nonce", client, ...extra } });

// ---- Resend capture ----------------------------------------------------------

let sent: { url: string; auth: string | null; payload: { to: string[]; text: string } }[] = [];
setResendFetch(async (input, init) => {
  sent = [...sent, { url: String(input), auth: new Headers(init?.headers).get("authorization"), payload: JSON.parse(String(init?.body)) }];
  return Response.json({ id: "email_1" });
});
afterEach(() => {
  sent = [];
});

function lastMail(): { token: string; code: string } {
  const text = sent.at(-1)?.payload.text ?? "";
  const token = /token=([A-Za-z0-9_-]+)/.exec(text)?.[1];
  const code = /code: (\d{6})/.exec(text)?.[1];
  if (!token || !code) throw new Error(`no link in ${text}`);
  return { token, code };
}

const freshEmail = () => `user-${crypto.randomUUID()}@example.com`;

async function emailSession(email = freshEmail()): Promise<{ token: string; userId: string }> {
  expect((await call("POST", "/v1/auth/email/start", { body: { email, client: "ios" } })).status).toBe(202);
  const res = await body(await call("POST", "/v1/auth/email/verify", { body: { token: lastMail().token, client: "ios" } }));
  return { token: res.data.token, userId: res.data.user.id };
}

// ---- Tests -------------------------------------------------------------------

describe("POST /v1/auth/apple", () => {
  it("creates the account once and returns a bearer session for native clients", async () => {
    const token = await appleToken({ sub: "apple-sub-1", email: "a1@example.com", email_verified: "true" });
    const first = await appleSignIn(token);
    expect(first.status).toBe(200);
    const a = await body(first);
    expect(a.data).toMatchObject({ created: true, user: { email: "a1@example.com", hasApple: true } });
    expect(a.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const b = await body(await appleSignIn(token));
    expect(b.data).toMatchObject({ created: false, user: { id: a.data.user.id } });

    const me = await body(await call("GET", "/v1/me", { token: a.data.token }));
    expect(me.data.user).toEqual(a.data.user);
    const stored = await env.DB.prepare("SELECT token_hash FROM sessions WHERE token_hash = ?").bind(await sha256Hex(a.data.token)).first();
    expect(stored).not.toBeNull();
  });

  it("sets an HttpOnly cookie and returns token null for web", async () => {
    const res = await appleSignIn(await appleToken({}), "web");
    expect(res.status).toBe(200);
    expect((await body(res)).data.token).toBeNull();
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^porchlight_session=[A-Za-z0-9_-]+; /);
    for (const part of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/v1"]) expect(cookie).toContain(part);
    const session = /porchlight_session=([^;]+)/.exec(cookie)?.[1] ?? "";
    expect((await call("GET", "/v1/me", { cookie: session })).status).toBe(200);
  });

  it.each([
    ["wrong audience", { aud: "com.evil.app" }],
    ["wrong issuer", { iss: "https://evil.example" }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ["nonce mismatch", { nonce: "not-the-hash" }],
  ])("rejects a token with %s", async (_name, claims) => {
    const res = await appleSignIn(await appleToken(claims));
    expect(res.status).toBe(401);
    expect((await body(res)).error.code).toBe("unauthorized");
  });

  it("rejects a token signed by another key, and garbage", async () => {
    expect((await appleSignIn(await appleToken({}, otherKey.privateKey))).status).toBe(401);
    expect((await appleSignIn("not.a.jwt")).status).toBe(401);
  });

  it("links to an existing email-only account with the same verified email", async () => {
    const email = freshEmail();
    const { userId } = await emailSession(email);
    const res = await body(await appleSignIn(await appleToken({ email, email_verified: true })));
    expect(res.data).toMatchObject({ created: false, user: { id: userId, hasApple: true, email } });
  });

  it("answers 503 when APPLE_CLIENT_IDS is missing and 400 for a bad body", async () => {
    const env503 = { ...testEnv, APPLE_CLIENT_IDS: undefined } as Env;
    const res = await call("POST", "/v1/auth/apple", { env: env503, body: { identityToken: "x", nonce: "n", client: "ios" } });
    expect(res.status).toBe(503);
    expect((await call("POST", "/v1/auth/apple", { body: { identityToken: "x", client: "tv" } })).status).toBe(400);
  });

  it("rate limits sign-in per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await call("POST", "/v1/auth/apple", { ip: "203.0.113.9", body: {} })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("email magic link", () => {
  it("sends a link and a code through Resend and signs in with the link once", async () => {
    const email = freshEmail();
    const start = await call("POST", "/v1/auth/email/start", { body: { email: email.toUpperCase(), client: "web" } });
    expect(start.status).toBe(202);
    expect((await body(start)).data).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: "https://api.resend.com/emails", auth: "Bearer re_test", payload: { to: [email] } });
    const { token } = lastMail();
    expect(sent[0]?.payload.text).toContain(`${ORIGIN}/auth/verify?token=${token}`);

    const row = await env.DB.prepare("SELECT expires_at - created_at AS ttl FROM auth_codes WHERE code_hash = ?").bind(await sha256Hex(token)).first<{ ttl: number }>();
    expect(row?.ttl).toBe(15 * 60 * 1000);

    const ok = await call("POST", "/v1/auth/email/verify", { body: { token, client: "ios" } });
    expect(ok.status).toBe(200);
    expect((await body(ok)).data).toMatchObject({ created: true, user: { email, hasApple: false } });
    expect((await call("POST", "/v1/auth/email/verify", { body: { token, client: "ios" } })).status).toBe(401);
  });

  it("signs in with the 6-digit code, which also spends the link", async () => {
    const email = freshEmail();
    await call("POST", "/v1/auth/email/start", { body: { email, client: "ios" } });
    const { token, code } = lastMail();
    const res = await call("POST", "/v1/auth/email/verify", { body: { email, code, client: "ios" } });
    expect(res.status).toBe(200);
    expect((await call("POST", "/v1/auth/email/verify", { body: { token, client: "ios" } })).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    await call("POST", "/v1/auth/email/start", { body: { email: freshEmail(), client: "ios" } });
    const { token } = lastMail();
    await env.DB.prepare("UPDATE auth_codes SET expires_at = 0 WHERE code_hash = ?").bind(await sha256Hex(token)).run();
    expect((await call("POST", "/v1/auth/email/verify", { body: { token, client: "ios" } })).status).toBe(401);
  });

  it("signs an existing user back in without creating a second account", async () => {
    const email = freshEmail();
    const first = await emailSession(email);
    await call("POST", "/v1/auth/email/start", { body: { email, client: "ios" } });
    const res = await body(await call("POST", "/v1/auth/email/verify", { body: { token: lastMail().token, client: "ios" } }));
    expect(res.data).toMatchObject({ created: false, user: { id: first.userId } });
  });

  it("limits starts per email to 3 per 15 minutes", async () => {
    const email = freshEmail();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await call("POST", "/v1/auth/email/start", { body: { email, client: "ios" } })).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
  });

  it("answers 429 with Retry-After", async () => {
    const email = freshEmail();
    for (let i = 0; i < 3; i++) await call("POST", "/v1/auth/email/start", { body: { email, client: "ios" } });
    const res = await call("POST", "/v1/auth/email/start", { body: { email, client: "ios" } });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await body(res)).error.code).toBe("rate_limited");
  });

  it("answers 503 without RESEND_API_KEY and 400 for a bad email", async () => {
    const res = await call("POST", "/v1/auth/email/start", { env: { ...testEnv, RESEND_API_KEY: undefined } as Env, body: { email: freshEmail(), client: "web" } });
    expect(res.status).toBe(503);
    expect((await body(res)).error.code).toBe("unavailable");
    expect((await call("POST", "/v1/auth/email/start", { body: { email: "nope", client: "web" } })).status).toBe(400);
  });

  it("logs the link and code instead of sending when EMAIL_DEV_LOG is set on a localhost origin", async () => {
    const devEnv = { ...testEnv, RESEND_API_KEY: undefined, EMAIL_DEV_LOG: "1", APP_ORIGIN: "http://localhost:8787" } as Env;
    const logged: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      const email = freshEmail();
      const start = await call("POST", "/v1/auth/email/start", { env: devEnv, body: { email, client: "ios" } });
      expect(start.status).toBe(202);
      expect(sent).toHaveLength(0);
      const line = logged.find((l) => l.includes(email)) ?? "";
      expect(line).toContain("http://localhost:8787/auth/verify?token=");
      const code = /code: (\d{6})/.exec(line)?.[1];
      expect(code).toBeDefined();
      const ok = await call("POST", "/v1/auth/email/verify", { env: devEnv, body: { email, code, client: "ios" } });
      expect(ok.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it("ignores EMAIL_DEV_LOG when APP_ORIGIN is not localhost", async () => {
    const prodEnv = { ...testEnv, RESEND_API_KEY: undefined, EMAIL_DEV_LOG: "1" } as Env;
    const res = await call("POST", "/v1/auth/email/start", { env: prodEnv, body: { email: freshEmail(), client: "ios" } });
    expect(res.status).toBe(503);
  });
});

describe("sessions", () => {
  it("answers 401 without or with a bad credential", async () => {
    expect((await call("GET", "/v1/me")).status).toBe(401);
    expect((await call("GET", "/v1/me", { token: "bogus" })).status).toBe(401);
    expect((await call("GET", "/v1/me", { token: "plt_bogus" })).status).toBe(401);
  });

  it("requires APP_ORIGIN on state-changing cookie requests", async () => {
    const { token } = await emailSession();
    expect((await call("POST", "/v1/auth/signout", { cookie: token })).status).toBe(403);
    expect((await call("POST", "/v1/auth/signout", { cookie: token, origin: "https://evil.example" })).status).toBe(403);
    const ok = await call("POST", "/v1/auth/signout", { cookie: token, origin: ORIGIN });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("signout deletes the session and its device", async () => {
    const { token, userId } = await emailSession();
    const deviceId = crypto.randomUUID();
    const put = await call("PUT", `/v1/devices/${deviceId}`, { token, body: { platform: "ios", apnsToken: "abcdef0123456789", appVersion: "1.0 (1)" } });
    expect(put.status).toBe(200);
    const res = await call("POST", "/v1/auth/signout", { token });
    expect((await body(res)).data).toEqual({ signedOut: true });
    expect((await call("GET", "/v1/me", { token })).status).toBe(401);
    const device = await env.DB.prepare("SELECT id FROM devices WHERE user_id = ?").bind(userId).first();
    expect(device).toBeNull();
  });
});

describe("DELETE /v1/me", () => {
  it("removes the user and every row they own", async () => {
    const { token, userId } = await emailSession();
    const now = Date.now();
    const pkg = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO packages (id, user_id, carrier, tracking_number, source, updated_at) VALUES (?, ?, 'ups', '1Z1', 'manual', ?)").bind(pkg, userId, now),
      env.DB.prepare("INSERT INTO events (id, package_id, occurred_at, status, description, raw_hash) VALUES (?, ?, ?, 'in_transit', 'x', 'h')").bind(crypto.randomUUID(), pkg, now),
      env.DB.prepare("INSERT INTO package_items (package_id, name) VALUES (?, 'thing')").bind(pkg),
      env.DB.prepare("INSERT INTO imports (user_id, source, dedupe_key, package_id, created_at) VALUES (?, 'flint', 'k', ?, ?)").bind(userId, pkg, now),
      env.DB.prepare("INSERT INTO api_tokens (id, token_hash, user_id, label, scopes, created_at) VALUES (?, ?, ?, 'x', 'imports:write', ?)").bind(crypto.randomUUID(), crypto.randomUUID(), userId, now),
      env.DB.prepare("INSERT INTO devices (id, user_id, platform) VALUES (?, ?, 'ios')").bind(crypto.randomUUID(), userId),
    ]);
    const res = await call("DELETE", "/v1/me", { token });
    expect((await body(res)).data).toEqual({ deleted: true });
    const counts = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE id = ?1) + (SELECT COUNT(*) FROM packages WHERE user_id = ?1)
        + (SELECT COUNT(*) FROM events WHERE package_id = ?2) + (SELECT COUNT(*) FROM package_items WHERE package_id = ?2)
        + (SELECT COUNT(*) FROM imports WHERE user_id = ?1) + (SELECT COUNT(*) FROM api_tokens WHERE user_id = ?1)
        + (SELECT COUNT(*) FROM devices WHERE user_id = ?1) + (SELECT COUNT(*) FROM sessions WHERE user_id = ?1) AS n`,
    ).bind(userId, pkg).first<{ n: number }>();
    expect(counts?.n).toBe(0);
    expect((await call("GET", "/v1/me", { token })).status).toBe(401);
  });
});

describe("PUT /v1/devices/:id", () => {
  it("registers, updates idempotently and links the session", async () => {
    const { token } = await emailSession();
    const id = crypto.randomUUID();
    const a = await body(await call("PUT", `/v1/devices/${id}`, { token, body: { platform: "macos", apnsToken: null, appVersion: null } }));
    expect(a.data).toEqual({ id, platform: "macos", apnsToken: null, appVersion: null });
    const b = await body(await call("PUT", `/v1/devices/${id}`, { token, body: { platform: "macos", apnsToken: "ffff0000ffff0000", appVersion: "1.1 (2)" } }));
    expect(b.data).toEqual({ id, platform: "macos", apnsToken: "ffff0000ffff0000", appVersion: "1.1 (2)" });
    const session = await env.DB.prepare("SELECT device_id FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).first<{ device_id: string }>();
    expect(session?.device_id).toBe(id);
  });

  it("answers 404 for another user's device and 400 for a bad id or body", async () => {
    const alice = await emailSession();
    const bob = await emailSession();
    const id = crypto.randomUUID();
    const dev = { platform: "ios", apnsToken: null, appVersion: null };
    await call("PUT", `/v1/devices/${id}`, { token: alice.token, body: dev });
    expect((await call("PUT", `/v1/devices/${id}`, { token: bob.token, body: dev })).status).toBe(404);
    expect((await call("PUT", "/v1/devices/not-a-uuid", { token: bob.token, body: dev })).status).toBe(400);
    expect((await call("PUT", `/v1/devices/${crypto.randomUUID()}`, { token: bob.token, body: { platform: "android" } })).status).toBe(400);
  });
});

describe("PUT /v1/devices/:id APNs token ownership", () => {
  it("moves an APNs token to the device that registers it last, so a reused phone stops getting the old user's pushes", async () => {
    const alice = await emailSession();
    const bob = await emailSession();
    const apnsToken = "abcdabcdabcdabcdabcdabcdabcdabcd";
    const aliceDevice = crypto.randomUUID();
    const bobDevice = crypto.randomUUID();
    await call("PUT", `/v1/devices/${aliceDevice}`, { token: alice.token, body: { platform: "ios", apnsToken, appVersion: null } });
    expect((await call("PUT", `/v1/devices/${bobDevice}`, { token: bob.token, body: { platform: "ios", apnsToken, appVersion: null } })).status).toBe(200);
    const rows = await env.DB.prepare("SELECT id FROM devices WHERE apns_token = ?").bind(apnsToken).all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toEqual([bobDevice]);
  });
});
