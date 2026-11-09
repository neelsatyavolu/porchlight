// GET, PUT and DELETE /v1/integrations/amazon (docs/API.md "Integrations").
// The native apps report how their last Amazon import went, so every client's
// Settings can show it (SPEC §6, "Failure is visible"). No Amazon data is stored.
import { z } from "zod";
import { requireUser } from "../lib/auth.js";
import { toIso } from "../lib/crypto.js";
import { json, readJson } from "../lib/http.js";
import type { RouteContext, Router } from "../lib/router.js";
import type { AmazonImportState, AmazonIntegration, AmazonIntegrationResponse, Platform } from "../types/api.js";

const STATES = ["ok", "needs_sign_in", "parse_failed"] as const satisfies readonly AmazonImportState[];

const ReportSchema = z.strictObject({
  state: z.enum(STATES),
  lastImportAt: z.iso.datetime({ offset: true }).nullable(),
  lastError: z.string().trim().max(300).nullable().optional(),
});

interface Row {
  state: AmazonImportState;
  last_import_at: number | null;
  last_error: string | null;
  platform: Platform | null;
  reported_at: number;
}

function toIntegration(row: Row): AmazonIntegration {
  return {
    state: row.state,
    lastImportAt: toIso(row.last_import_at),
    lastError: row.last_error,
    reportedAt: toIso(row.reported_at),
    platform: row.platform,
  };
}

async function load(env: RouteContext["env"], userId: string): Promise<AmazonIntegration | null> {
  const row = await env.DB.prepare(
    "SELECT state, last_import_at, last_error, platform, reported_at FROM integrations WHERE user_id = ? AND kind = 'amazon'",
  )
    .bind(userId)
    .first<Row>();
  return row ? toIntegration(row) : null;
}

async function getAmazon({ req, env }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  return json<AmazonIntegrationResponse>({ amazon: await load(env, session.userId) });
}

async function putAmazon({ req, env }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  const body = await readJson(req, ReportSchema);
  const lastImportMs = body.lastImportAt === null ? null : Date.parse(body.lastImportAt);
  // An "ok" report carries no error text.
  const lastError = body.state === "ok" ? null : body.lastError || null;
  await env.DB.prepare(
    `INSERT INTO integrations (user_id, kind, state, last_import_at, last_error, platform, reported_at)
     VALUES (?1, 'amazon', ?2, ?3, ?4,
       (SELECT COALESCE(d.platform, s.client) FROM sessions s LEFT JOIN devices d ON d.id = s.device_id AND d.user_id = s.user_id
        WHERE s.token_hash = ?5),
       ?6)
     ON CONFLICT (user_id, kind) DO UPDATE SET state = excluded.state, last_import_at = excluded.last_import_at,
       last_error = excluded.last_error, platform = excluded.platform, reported_at = excluded.reported_at`,
  )
    .bind(session.userId, body.state, lastImportMs, lastError, session.sessionId, Date.now())
    .run();
  return json<AmazonIntegrationResponse>({ amazon: await load(env, session.userId) });
}

async function deleteAmazon({ req, env }: RouteContext): Promise<Response> {
  const session = await requireUser(req, env);
  if (session instanceof Response) return session;
  await env.DB.prepare("DELETE FROM integrations WHERE user_id = ? AND kind = 'amazon'").bind(session.userId).run();
  return json({ deleted: true });
}

/** Owns: GET, PUT, DELETE /v1/integrations/amazon (docs/API.md). */
export function register(router: Router): void {
  router
    .on("GET", "/v1/integrations/amazon", getAmazon)
    .on("PUT", "/v1/integrations/amazon", putAmazon)
    .on("DELETE", "/v1/integrations/amazon", deleteAmazon);
}
