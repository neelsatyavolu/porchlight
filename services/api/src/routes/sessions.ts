// GET /v1/sessions and DELETE /v1/sessions/:id (docs/API.md "Sessions").
// Every query is scoped by user id, so one user can never see or end another's session.
import type { Env } from "../env.js";
import { clearSessionCookie, requireUser, usesCookie } from "../lib/auth.js";
import { isUuid, toIso } from "../lib/crypto.js";
import { HttpError, json } from "../lib/http.js";
import type { RouteContext, Router } from "../lib/router.js";
import type { Platform, SessionDeleteResponse, SessionInfo, SessionsResponse } from "../types/api.js";

interface SessionRow {
  id: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  platform: Platform | null;
  app_version: string | null;
}

async function listSessions({ req, env }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.token_hash, s.created_at, s.last_seen_at, COALESCE(d.platform, s.client) AS platform, d.app_version
     FROM sessions s LEFT JOIN devices d ON d.id = s.device_id AND d.user_id = s.user_id
     WHERE s.user_id = ? AND s.id IS NOT NULL ORDER BY s.last_seen_at DESC, s.created_at DESC`,
  )
    .bind(session.userId)
    .all<SessionRow>();
  const sessions: SessionInfo[] = results.map((r) => ({
    id: r.id,
    platform: r.platform,
    appVersion: r.app_version,
    createdAt: toIso(r.created_at),
    lastSeenAt: toIso(r.last_seen_at),
    current: r.token_hash === session.sessionId,
  }));
  return json<SessionsResponse>({ sessions });
}

/** Removes the session's device (and APNs token) unless another session of the user still uses it. */
async function dropOrphanDevice(env: Env, userId: string, deviceId: string): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM devices WHERE id = ?1 AND user_id = ?2 AND NOT EXISTS (SELECT 1 FROM sessions WHERE device_id = ?1 AND user_id = ?2)",
  )
    .bind(deviceId, userId)
    .run();
}

async function deleteSession({ req, env, params }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const id = (params.id ?? "").toLowerCase();
  if (!isUuid(id)) throw new HttpError(400, "bad_request", "id: must be a UUID");
  const row = await env.DB.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ? RETURNING token_hash, device_id")
    .bind(id, session.userId)
    .first<{ token_hash: string; device_id: string | null }>();
  if (!row) throw new HttpError(404, "not_found", "No such session");
  if (row.device_id) await dropOrphanDevice(env, session.userId, row.device_id);
  const signedOut = row.token_hash === session.sessionId;
  const headers: Record<string, string> = signedOut && usesCookie(req) ? { "set-cookie": clearSessionCookie() } : {};
  return json<SessionDeleteResponse>({ deleted: true, signedOut }, 200, headers);
}

/** Owns: GET /v1/sessions, DELETE /v1/sessions/:id (docs/API.md). */
export function register(router: Router): void {
  router.on("GET", "/v1/sessions", listSessions).on("DELETE", "/v1/sessions/:id", deleteSession);
}
