import { z } from "zod";
import { API_TOKEN_PREFIX, randomToken, requireUser, sha256Hex } from "../lib/auth.js";
import { normalizeCrockford, randomCrockford, toIso } from "../lib/crypto.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { clientIp, enforce, LIMITS } from "../lib/ratelimit.js";
import type { RouteContext, Router } from "../lib/router.js";
import type { ApiTokenInfo, PairingClaimResponse, PairingStartResponse, TokensResponse } from "../types/api.js";

const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CLAIM_ATTEMPTS = 5;
const PAIRING_SCOPES = ["imports:write"] as const;

const claimBody = z.object({
  code: z.string().max(32),
  label: z.string().trim().min(1).max(100),
});

interface TokenRow {
  id: string;
  label: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
}

async function pairingStart({ req, env }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const now = Date.now();
  const code = randomCrockford(CODE_LENGTH);
  const expiresAt = now + CODE_TTL_MS;
  await env.DB.prepare(
    "INSERT INTO auth_codes (code_hash, kind, user_id, created_at, expires_at) VALUES (?, 'pairing', ?, ?, ?)",
  )
    .bind(await sha256Hex(code), session.userId, now, expiresAt)
    .run();
  const data: PairingStartResponse = { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: toIso(expiresAt) };
  return json(data, 201);
}

async function pairingClaim({ req, env }: RouteContext): Promise<Response> {
  const now = Date.now();
  await enforce(env, `pair:${clientIp(req)}`, LIMITS.pairingClaimPerIp, now);
  const body = await readJson(req, claimBody);
  const code = normalizeCrockford(body.code, CODE_LENGTH);
  if (!code) throw new HttpError(400, "bad_request", "code: must be 8 characters like ABCD-EFGH");
  const hash = await sha256Hex(code);
  const row = await env.DB.prepare(
    `UPDATE auth_codes SET used_at = ?1, attempts = attempts + 1
     WHERE code_hash = ?2 AND kind = 'pairing' AND used_at IS NULL AND expires_at > ?1 AND attempts < ?3
     RETURNING user_id`,
  )
    .bind(now, hash, MAX_CLAIM_ATTEMPTS)
    .first<{ user_id: string | null }>();
  if (!row?.user_id) {
    await env.DB.prepare("UPDATE auth_codes SET attempts = attempts + 1 WHERE code_hash = ? AND kind = 'pairing'")
      .bind(hash)
      .run();
    throw new HttpError(401, "unauthorized", "This pairing code is invalid, used or expired");
  }
  const token = `${API_TOKEN_PREFIX}${randomToken()}`;
  const tokenId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO api_tokens (id, token_hash, user_id, label, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(tokenId, await sha256Hex(token), row.user_id, body.label, PAIRING_SCOPES.join(" "), now)
    .run();
  const data: PairingClaimResponse = { token, tokenId, scopes: [...PAIRING_SCOPES] };
  return json(data, 201);
}

async function listTokens({ req, env }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const { results } = await env.DB.prepare(
    "SELECT id, label, scopes, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at, id",
  )
    .bind(session.userId)
    .all<TokenRow>();
  const tokens: ApiTokenInfo[] = results.map((r) => ({
    id: r.id,
    label: r.label,
    scopes: r.scopes.split(" ").filter(Boolean),
    createdAt: toIso(r.created_at),
    lastUsedAt: toIso(r.last_used_at),
  }));
  return json<TokensResponse>({ tokens });
}

async function deleteToken({ req, env, params }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const row = await env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ? RETURNING id")
    .bind((params.id ?? "").toLowerCase(), session.userId)
    .first<{ id: string }>();
  if (!row) throw new HttpError(404, "not_found", "No such token");
  return json({ deleted: true });
}

/** Owns: POST /v1/pairing/start, POST /v1/pairing/claim, GET /v1/tokens, DELETE /v1/tokens/:id (docs/API.md). */
export function register(router: Router): void {
  router
    .on("POST", "/v1/pairing/start", pairingStart)
    .on("POST", "/v1/pairing/claim", pairingClaim)
    .on("GET", "/v1/tokens", listTokens)
    .on("DELETE", "/v1/tokens/:id", deleteToken);
}
