// CONTRACT: authentication helpers shared by every route module.
// Sessions: `Authorization: Bearer <session token>` (native) or the
// `porchlight_session` HttpOnly cookie (web). API tokens (Flint) use
// `Authorization: Bearer plt_<token>`. Only SHA-256 hashes are stored.
import type { Env } from "../env.js";
import { errorResponse } from "./http.js";

export const SESSION_COOKIE = "porchlight_session";
export const API_TOKEN_PREFIX = "plt_";

export type Scope = "imports:write";

export interface SessionUser {
  userId: string;
  /** sessions.token_hash of the current session. */
  sessionId: string;
}

export interface TokenUser {
  userId: string;
  /** api_tokens.id */
  tokenId: string;
  scopes: readonly Scope[];
}

/** Lowercase hex SHA-256, used for every stored token and code. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, base64url. Used for session tokens and magic-link tokens. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Web sessions live this long in the browser (Chrome caps cookies at 400 days). */
const COOKIE_MAX_AGE_SEC = 400 * 24 * 60 * 60;
/** last_seen_at is bumped at most this often, to keep reads cheap. */
const SEEN_BUMP_MS = 60_000;

type Credential = { kind: "bearer"; token: string } | { kind: "cookie"; token: string };

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

function readCredential(req: Request): Credential | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    return m?.[1] ? { kind: "bearer", token: m[1] } : null;
  }
  const cookie = readCookie(req, SESSION_COOKIE);
  return cookie ? { kind: "cookie", token: cookie } : null;
}

const unauthorized = (): Response => errorResponse(401, "unauthorized", "Sign in required");

/** Cookie requests that change state must come from APP_ORIGIN (CSRF guard). */
function badOrigin(req: Request, env: Env, cred: Credential): boolean {
  if (cred.kind !== "cookie" || req.method === "GET" || req.method === "HEAD") return false;
  return req.headers.get("origin") !== env.APP_ORIGIN;
}

async function sessionFor(env: Env, token: string, nowMs: number): Promise<SessionUser | null> {
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT user_id, last_seen_at FROM sessions WHERE token_hash = ?")
    .bind(hash)
    .first<{ user_id: string; last_seen_at: number }>();
  if (!row) return null;
  if (nowMs - row.last_seen_at > SEEN_BUMP_MS) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").bind(nowMs, hash).run();
  }
  return { userId: row.user_id, sessionId: hash };
}

async function apiTokenFor(env: Env, token: string, nowMs: number): Promise<TokenUser | null> {
  const row = await env.DB.prepare("SELECT id, user_id, scopes FROM api_tokens WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ id: string; user_id: string; scopes: string }>();
  if (!row) return null;
  await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(nowMs, row.id).run();
  const scopes = row.scopes.split(" ").filter((s): s is Scope => s === "imports:write");
  return { userId: row.user_id, tokenId: row.id, scopes };
}

/**
 * Resolves the session from bearer header or cookie and bumps last_seen_at.
 * Returns a 401 error envelope Response when missing or invalid, and 403 for
 * a state-changing cookie request whose Origin is not APP_ORIGIN.
 */
export async function requireUser(req: Request, env: Env): Promise<SessionUser | Response> {
  const cred = readCredential(req);
  if (!cred || cred.token.startsWith(API_TOKEN_PREFIX)) return unauthorized();
  if (badOrigin(req, env, cred)) return errorResponse(403, "forbidden", "Bad origin");
  return (await sessionFor(env, cred.token, Date.now())) ?? unauthorized();
}

/**
 * Accepts either a session or an API token carrying `scope`.
 * Returns 401 (no/invalid credentials) or 403 (missing scope) as a Response.
 */
export async function requireUserOrToken(
  req: Request,
  env: Env,
  scope: Scope,
): Promise<SessionUser | TokenUser | Response> {
  const cred = readCredential(req);
  if (!cred || cred.kind !== "bearer" || !cred.token.startsWith(API_TOKEN_PREFIX)) return requireUser(req, env);
  const user = await apiTokenFor(env, cred.token, Date.now());
  if (!user) return unauthorized();
  return user.scopes.includes(scope) ? user : errorResponse(403, "forbidden", `Token lacks scope ${scope}`);
}

/** Creates a session row and returns the raw token (shown to the client once). */
export async function createSession(
  env: Env,
  userId: string,
  deviceId: string | null,
  nowMs: number,
  client: "ios" | "macos" | "web" | null = null,
): Promise<string> {
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, id, user_id, device_id, client, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256Hex(token), crypto.randomUUID(), userId, deviceId, client, nowMs, nowMs)
    .run();
  return token;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/v1; Max-Age=${COOKIE_MAX_AGE_SEC}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/v1; Max-Age=0`;
}

/** True when the request authenticated with the web cookie rather than a bearer token. */
export function usesCookie(req: Request): boolean {
  return readCredential(req)?.kind === "cookie";
}
