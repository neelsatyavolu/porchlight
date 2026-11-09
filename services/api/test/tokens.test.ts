import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { randomToken, requireUserOrToken, sha256Hex } from "../src/lib/auth.js";
import { errorResponse, HttpError } from "../src/lib/http.js";
import { Router } from "../src/lib/router.js";
import * as tokenRoutes from "../src/routes/tokens.js";

const { maskEmail } = tokenRoutes;

// Mirrors src/index.ts error handling with only the routes under test.
const router = new Router();
tokenRoutes.register(router);
async function call(method: string, path: string, o: { token?: string; body?: unknown; ip?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": o.ip ?? `10.1.${Math.random()}` };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`https://porchlight.test${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const ctx = createExecutionContext();
  try {
    return (await router.handle(req, env, ctx)) ?? errorResponse(404, "not_found", "No such endpoint");
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, { ...err.headers }, err.details);
    throw err;
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<any> => res.json();

async function newUser(): Promise<{ token: string; userId: string }> {
  const userId = crypto.randomUUID();
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").bind(userId, now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(token), userId, now, now),
  ]);
  return { token, userId };
}

async function startPairing(token: string): Promise<string> {
  const res = await call("POST", "/v1/pairing/start", { token });
  expect(res.status).toBe(201);
  return (await body(res)).data.code;
}

const claim = (code: string, label = "Flint on Test Mac", ip?: string) =>
  call("POST", "/v1/pairing/claim", { body: { code, label }, ...(ip ? { ip } : {}) });

const bearer = (token: string) => new Request("https://porchlight.test/v1/imports/flint", { method: "POST", headers: { authorization: `Bearer ${token}` } });

describe("pairing", () => {
  it("issues an 8-character code that expires in 10 minutes", async () => {
    const { token } = await newUser();
    const before = Date.now();
    const res = await body(await call("POST", "/v1/pairing/start", { token }));
    expect(res.data.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const ttl = Date.parse(res.data.expiresAt) - before;
    expect(ttl).toBeGreaterThanOrEqual(10 * 60 * 1000 - 5);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
  });

  it("claims once, case-insensitively and without the dash, into an imports:write token", async () => {
    const { token, userId } = await newUser();
    const code = await startPairing(token);
    const res = await claim(code.replace("-", "").toLowerCase());
    expect(res.status).toBe(201);
    const data = (await body(res)).data;
    expect(data.token).toMatch(/^plt_[A-Za-z0-9_-]{43}$/);
    expect(data.scopes).toEqual(["imports:write"]);

    const stored = await env.DB.prepare("SELECT user_id, label, token_hash FROM api_tokens WHERE id = ?").bind(data.tokenId).first<{ user_id: string; label: string; token_hash: string }>();
    expect(stored).toEqual({ user_id: userId, label: "Flint on Test Mac", token_hash: await sha256Hex(data.token) });

    expect((await claim(code)).status).toBe(401);

    const who = await requireUserOrToken(bearer(data.token), env, "imports:write");
    expect(who).toEqual({ userId, tokenId: data.tokenId, scopes: ["imports:write"] });
  });

  it("rejects expired and unknown codes with 401 and bad input with 400", async () => {
    const { token } = await newUser();
    const code = await startPairing(token);
    await env.DB.prepare("UPDATE auth_codes SET expires_at = 0 WHERE code_hash = ?").bind(await sha256Hex(code.replace("-", ""))).run();
    expect((await claim(code)).status).toBe(401);
    expect((await claim("ZZZZ-ZZZZ")).status).toBe(401);
    expect((await claim("SHORT")).status).toBe(400);
    expect((await claim(await startPairing(token), "")).status).toBe(400);
  });

  it("limits claims to 5 per 10 minutes per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await claim("ZZZZ-ZZZZ", "x", "198.51.100.7")).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("requires a session to start", async () => {
    expect((await call("POST", "/v1/pairing/start")).status).toBe(401);
  });
});

const peek = (code: string, ip?: string) => call("POST", "/v1/pairing/peek", { body: { code }, ...(ip ? { ip } : {}) });

async function userWithEmail(email: string | null): Promise<{ token: string; userId: string }> {
  const u = await newUser();
  await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email, u.userId).run();
  return u;
}

describe("pairing peek", () => {
  it("names the account behind a live code with a masked email, without using the code", async () => {
    const { token } = await userWithEmail("neel@xanom.co");
    const code = await startPairing(token);
    for (let i = 0; i < 3; i++) {
      const res = await peek(code.replace("-", "").toLowerCase());
      expect(res.status).toBe(200);
      expect((await body(res)).data).toEqual({ account: "n•••@xanom.co" });
    }
    expect((await claim(code)).status).toBe(201);
  });

  it("answers 404 for unknown, used, expired and worn-out codes, and 400 for bad input", async () => {
    const { token } = await userWithEmail("a@b.c");
    expect((await peek("ZZZZ-ZZZZ")).status).toBe(404);
    expect((await peek("SHORT")).status).toBe(400);

    const used = await startPairing(token);
    await claim(used);
    expect((await peek(used)).status).toBe(404);

    const expired = await startPairing(token);
    await env.DB.prepare("UPDATE auth_codes SET expires_at = 0 WHERE code_hash = ?").bind(await sha256Hex(expired.replace("-", ""))).run();
    expect((await peek(expired)).status).toBe(404);

    const worn = await startPairing(token);
    await env.DB.prepare("UPDATE auth_codes SET attempts = 5 WHERE code_hash = ?").bind(await sha256Hex(worn.replace("-", ""))).run();
    expect((await peek(worn)).status).toBe(404);
  });

  it("returns null for an account with no email", async () => {
    const { token } = await userWithEmail(null);
    expect((await body(await peek(await startPairing(token)))).data).toEqual({ account: null });
  });

  it("limits peeks to 5 per 10 minutes per IP, apart from claims", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await peek("ZZZZ-ZZZZ", "198.51.100.8")).status);
    expect(statuses).toEqual([404, 404, 404, 404, 404, 429]);
    expect((await claim("ZZZZ-ZZZZ", "x", "198.51.100.8")).status).toBe(401);
  });
});

describe("maskEmail", () => {
  it("keeps the first letter and the domain", () => {
    expect(maskEmail("neel@xanom.co")).toBe("n•••@xanom.co");
    expect(maskEmail("x@privaterelay.appleid.com")).toBe("x•••@privaterelay.appleid.com");
    expect(maskEmail("no-at-sign")).toBe("•••");
    expect(maskEmail("@odd.com")).toBe("•••@odd.com");
  });
});

describe("API tokens", () => {
  it("lists only the user's tokens and revokes them at once", async () => {
    const me = await newUser();
    const other = await newUser();
    const mine = (await body(await claim(await startPairing(me.token)))).data;
    await claim(await startPairing(other.token));

    const list = (await body(await call("GET", "/v1/tokens", { token: me.token }))).data;
    expect(list.tokens).toEqual([
      { id: mine.tokenId, label: "Flint on Test Mac", scopes: ["imports:write"], createdAt: expect.any(String), lastUsedAt: null },
    ]);

    await requireUserOrToken(bearer(mine.token), env, "imports:write");
    const used = (await body(await call("GET", "/v1/tokens", { token: me.token }))).data;
    expect(used.tokens[0].lastUsedAt).not.toBeNull();

    expect((await call("DELETE", `/v1/tokens/${mine.tokenId}`, { token: other.token })).status).toBe(404);
    const del = await call("DELETE", `/v1/tokens/${mine.tokenId}`, { token: me.token });
    expect((await body(del)).data).toEqual({ deleted: true });
    expect((await call("DELETE", `/v1/tokens/${mine.tokenId}`, { token: me.token })).status).toBe(404);

    const after = await requireUserOrToken(bearer(mine.token), env, "imports:write");
    expect(after).toBeInstanceOf(Response);
    expect((after as Response).status).toBe(401);
  });

  it("an API token cannot act as a session, and lacks other scopes", async () => {
    const me = await newUser();
    const t = (await body(await claim(await startPairing(me.token)))).data;
    expect((await call("GET", "/v1/tokens", { token: t.token })).status).toBe(401);
    await env.DB.prepare("UPDATE api_tokens SET scopes = '' WHERE id = ?").bind(t.tokenId).run();
    const res = await requireUserOrToken(bearer(t.token), env, "imports:write");
    expect((res as Response).status).toBe(403);
  });

  it("requireUserOrToken also accepts a session", async () => {
    const me = await newUser();
    const who = await requireUserOrToken(bearer(me.token), env, "imports:write");
    expect(who).toEqual({ userId: me.userId, sessionId: await sha256Hex(me.token) });
  });
});
