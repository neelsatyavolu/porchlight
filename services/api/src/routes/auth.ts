import { z } from "zod";
import type { Env } from "../env.js";
import { AppleTokenError, verifyAppleIdentityToken } from "../lib/apple.js";
import {
  clearSessionCookie,
  createSession,
  randomToken,
  requireUser,
  sessionCookie,
  sha256Hex,
  usesCookie,
} from "../lib/auth.js";
import { isUuid, randomDigits, toIso } from "../lib/crypto.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { clientIp, enforce, LIMITS } from "../lib/ratelimit.js";
import { sendMagicLink } from "../lib/resend.js";
import type { RouteContext, Router } from "../lib/router.js";
import type { Device, MeResponse, SignInResponse, User } from "../types/api.js";

const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;

const client = z.enum(["ios", "macos", "web"]);
const deviceId = z.string().toLowerCase().refine(isUuid, "must be a UUID").optional();
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

const appleBody = z.object({
  identityToken: z.string().min(1).max(8192),
  nonce: z.string().min(1).max(512),
  client,
  deviceId,
});
const emailStartBody = z.object({ email, client });
// `email` + `code` is the typed 6-digit alternative to the link token.
const emailVerifyBody = z.union([
  z.object({ token: z.string().min(1).max(256), client, deviceId }),
  z.object({ email, code: z.string().regex(/^\d{6}$/, "must be 6 digits"), client, deviceId }),
]);
const devicePutBody = z.object({
  platform: client,
  apnsToken: z.string().regex(/^[0-9a-fA-F]{16,256}$/, "must be hex").nullable(),
  appVersion: z.string().max(64).nullable(),
  environment: z.enum(["sandbox", "production"]).optional(),
});

interface UserRow {
  id: string;
  apple_sub: string | null;
  email: string | null;
  created_at: number;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  hasApple: r.apple_sub !== null,
  createdAt: toIso(r.created_at),
});

const userBy = (env: Env, column: "id" | "apple_sub" | "email", value: string): Promise<UserRow | null> =>
  env.DB.prepare(`SELECT id, apple_sub, email, created_at FROM users WHERE ${column} = ?`).bind(value).first<UserRow>();

async function insertUser(env: Env, appleSub: string | null, mail: string | null, nowMs: number): Promise<UserRow> {
  const row: UserRow = { id: crypto.randomUUID(), apple_sub: appleSub, email: mail, created_at: nowMs };
  await env.DB.prepare("INSERT INTO users (id, apple_sub, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(row.id, row.apple_sub, row.email, row.created_at)
    .run();
  return row;
}

/** Login-CSRF guard: a browser sign-in must come from our own origin. */
function checkWebOrigin(req: Request, env: Env, c: z.infer<typeof client>): void {
  const origin = req.headers.get("origin");
  if (c === "web" && origin !== null && origin !== env.APP_ORIGIN) throw new HttpError(403, "forbidden", "Bad origin");
}

async function signedIn(env: Env, user: UserRow, created: boolean, c: z.infer<typeof client>, dev: string | undefined): Promise<Response> {
  const token = await createSession(env, user.id, dev ?? null, Date.now(), c);
  const data: SignInResponse = { token: c === "web" ? null : token, user: toUser(user), created };
  return json(data, 200, c === "web" ? { "set-cookie": sessionCookie(token) } : {});
}

async function appleUser(env: Env, sub: string, mail: string | null, nowMs: number): Promise<[UserRow, boolean]> {
  const existing = await userBy(env, "apple_sub", sub);
  if (existing) return [existing, false];
  const byEmail = mail ? await userBy(env, "email", mail) : null;
  if (byEmail && byEmail.apple_sub === null) {
    await env.DB.prepare("UPDATE users SET apple_sub = ? WHERE id = ?").bind(sub, byEmail.id).run();
    return [{ ...byEmail, apple_sub: sub }, false];
  }
  // An email held by a different Apple account is not shared.
  return [await insertUser(env, sub, byEmail ? null : mail, nowMs), true];
}

async function apple({ req, env }: RouteContext): Promise<Response> {
  const now = Date.now();
  await enforce(env, `auth:${clientIp(req)}`, LIMITS.authPerIp, now);
  const body = await readJson(req, appleBody);
  checkWebOrigin(req, env, body.client);
  const audiences = (env.APPLE_CLIENT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (audiences.length === 0) throw new HttpError(503, "unavailable", "Sign in with Apple is not configured");
  let identity;
  try {
    identity = await verifyAppleIdentityToken(body.identityToken, { audiences, nonce: body.nonce, nowMs: now });
  } catch (err) {
    if (err instanceof AppleTokenError) throw new HttpError(401, "unauthorized", "Apple sign-in failed");
    throw err;
  }
  const [user, created] = await appleUser(env, identity.sub, identity.email, now);
  return signedIn(env, user, created, body.client, body.deviceId);
}

/**
 * EMAIL_DEV_LOG=1 logs the magic link and code instead of sending them, but
 * only when APP_ORIGIN is localhost or 127.0.0.1, so a stray production var
 * cannot leak codes into logs.
 */
function devEmailLog(env: Env): boolean {
  if (env.EMAIL_DEV_LOG !== "1") return false;
  const host = new URL(env.APP_ORIGIN).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

const emailCodeKey = (mail: string, code: string): string => `code:${mail}:${code}`;

async function emailStart({ req, env }: RouteContext): Promise<Response> {
  const now = Date.now();
  await enforce(env, `auth:${clientIp(req)}`, LIMITS.authPerIp, now);
  const body = await readJson(req, emailStartBody);
  checkWebOrigin(req, env, body.client);
  const devLog = !env.RESEND_API_KEY && devEmailLog(env);
  if (!env.RESEND_API_KEY && !devLog) throw new HttpError(503, "unavailable", "Email sign-in is not configured");
  await enforce(env, `email:${body.email}`, LIMITS.emailStartPerEmail, now);

  const token = randomToken();
  const code = randomDigits(6);
  const insert = "INSERT INTO auth_codes (code_hash, kind, email, created_at, expires_at) VALUES (?, 'email', ?, ?, ?)";
  const expires = now + EMAIL_CODE_TTL_MS;
  await env.DB.batch([
    env.DB.prepare(insert).bind(await sha256Hex(token), body.email, now, expires),
    env.DB.prepare(insert).bind(await sha256Hex(emailCodeKey(body.email, code)), body.email, now, expires),
  ]);
  const link = new URL("/auth/verify", env.APP_ORIGIN);
  link.searchParams.set("token", token);
  if (devLog || !env.RESEND_API_KEY) {
    // Local dev only (devEmailLog): the sign-in goes to the wrangler dev log.
    console.info(`EMAIL_DEV_LOG sign-in for ${body.email}: ${link.href} code: ${code}`);
    return json({ sent: true }, 202);
  }
  try {
    await sendMagicLink({ apiKey: env.RESEND_API_KEY, to: body.email, appOrigin: env.APP_ORIGIN, link: link.href, code });
  } catch (err) {
    console.error("resend failed", err);
    throw new HttpError(503, "unavailable", "Could not send the email, try again later");
  }
  return json({ sent: true }, 202);
}

async function emailVerify({ req, env }: RouteContext): Promise<Response> {
  const now = Date.now();
  await enforce(env, `auth:${clientIp(req)}`, LIMITS.authPerIp, now);
  const body = await readJson(req, emailVerifyBody);
  checkWebOrigin(req, env, body.client);
  let secret: string;
  if ("token" in body) {
    secret = body.token;
  } else {
    await enforce(env, `verify:${body.email}`, LIMITS.emailVerifyPerEmail, now);
    secret = emailCodeKey(body.email, body.code);
  }
  const row = await env.DB.prepare(
    `UPDATE auth_codes SET used_at = ?1 WHERE code_hash = ?2 AND kind = 'email' AND used_at IS NULL AND expires_at > ?1
     RETURNING email`,
  )
    .bind(now, await sha256Hex(secret))
    .first<{ email: string }>();
  if (!row) throw new HttpError(401, "unauthorized", "This sign-in link or code is invalid or expired");
  // The link and the code are one credential: using either spends both.
  await env.DB.prepare("UPDATE auth_codes SET used_at = ? WHERE kind = 'email' AND email = ? AND used_at IS NULL")
    .bind(now, row.email)
    .run();
  const existing = await userBy(env, "email", row.email);
  const user = existing ?? (await insertUser(env, null, row.email.toLowerCase(), now));
  return signedIn(env, user, existing === null, body.client, body.deviceId);
}

async function signout({ req, env }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const row = await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ? AND user_id = ? RETURNING device_id")
    .bind(session.sessionId, session.userId)
    .first<{ device_id: string | null }>();
  if (row?.device_id) {
    await env.DB.prepare("DELETE FROM devices WHERE id = ? AND user_id = ?").bind(row.device_id, session.userId).run();
  }
  return json({ signedOut: true }, 200, usesCookie(req) ? { "set-cookie": clearSessionCookie() } : {});
}

async function me({ req, env }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const user = await userBy(env, "id", session.userId);
  if (!user) throw new HttpError(401, "unauthorized", "Sign in required");
  const data: MeResponse = { user: toUser(user) };
  return json(data);
}

async function deleteMe({ req, env }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const uid = session.userId;
  const owned = "(SELECT id FROM packages WHERE user_id = ?)";
  // Explicit deletes rather than relying on FK cascades alone (SPEC §9).
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM events WHERE package_id IN ${owned}`).bind(uid),
    env.DB.prepare(`DELETE FROM package_items WHERE package_id IN ${owned}`).bind(uid),
    env.DB.prepare("DELETE FROM imports WHERE user_id = ?").bind(uid),
    env.DB.prepare("DELETE FROM packages WHERE user_id = ?").bind(uid),
    env.DB.prepare("DELETE FROM api_tokens WHERE user_id = ?").bind(uid),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(uid),
    env.DB.prepare("DELETE FROM devices WHERE user_id = ?").bind(uid),
    env.DB.prepare(
      "DELETE FROM auth_codes WHERE user_id = ?1 OR (kind = 'email' AND email = (SELECT email FROM users WHERE id = ?1))",
    ).bind(uid),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(uid),
  ]);
  return json({ deleted: true }, 200, usesCookie(req) ? { "set-cookie": clearSessionCookie() } : {});
}

async function putDevice({ req, env, params }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const id = (params.id ?? "").toLowerCase();
  if (!isUuid(id)) throw new HttpError(400, "bad_request", "id: must be a UUID");
  const body = await readJson(req, devicePutBody);
  const owner = await env.DB.prepare("SELECT user_id FROM devices WHERE id = ?").bind(id).first<{ user_id: string }>();
  if (owner && owner.user_id !== session.userId) throw new HttpError(404, "not_found", "No such device");
  await env.DB.batch([
    // An APNs token addresses one app install: whoever registers it last owns
    // it, so a reused or handed-down phone stops getting the old user's pushes.
    env.DB.prepare("UPDATE devices SET apns_token = NULL WHERE lower(apns_token) = lower(?1) AND id != ?2").bind(
      body.apnsToken,
      id,
    ),
    // An omitted environment is production on create and unchanged on update.
    env.DB.prepare(
      `INSERT INTO devices (id, user_id, platform, apns_token, app_version, apns_environment)
       VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, 'production'))
       ON CONFLICT (id) DO UPDATE SET platform = ?3, apns_token = ?4, app_version = ?5,
         apns_environment = COALESCE(?6, apns_environment) WHERE user_id = ?2`,
    ).bind(id, session.userId, body.platform, body.apnsToken, body.appVersion, body.environment ?? null),
    env.DB.prepare("UPDATE sessions SET device_id = ? WHERE token_hash = ? AND user_id = ?").bind(
      id,
      session.sessionId,
      session.userId,
    ),
  ]);
  const stored = await env.DB.prepare("SELECT apns_environment FROM devices WHERE id = ? AND user_id = ?")
    .bind(id, session.userId)
    .first<{ apns_environment: Device["environment"] }>();
  const data: Device = {
    id,
    platform: body.platform,
    apnsToken: body.apnsToken,
    appVersion: body.appVersion,
    environment: stored?.apns_environment ?? "production",
  };
  return json(data);
}

/** Owns: POST /v1/auth/apple, POST /v1/auth/email/start, POST /v1/auth/email/verify, POST /v1/auth/signout, GET /v1/me, DELETE /v1/me, PUT /v1/devices/:id (docs/API.md). */
export function register(router: Router): void {
  router
    .on("POST", "/v1/auth/apple", apple)
    .on("POST", "/v1/auth/email/start", emailStart)
    .on("POST", "/v1/auth/email/verify", emailVerify)
    .on("POST", "/v1/auth/signout", signout)
    .on("GET", "/v1/me", me)
    .on("DELETE", "/v1/me", deleteMe)
    .on("PUT", "/v1/devices/:id", putDevice);
}
