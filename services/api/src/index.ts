import type { Env } from "./env.js";
import { serveAssets } from "./lib/assets.js";
import { errorResponse, HttpError } from "./lib/http.js";
import { Router } from "./lib/router.js";
import { consume } from "./poll/consume.js";
import { schedule } from "./poll/schedule.js";
import type { TrackJob } from "./poll/types.js";
import * as auth from "./routes/auth.js";
import * as imports from "./routes/imports.js";
import * as integrations from "./routes/integrations.js";
import * as packages from "./routes/packages.js";
import * as sessions from "./routes/sessions.js";
import * as sync from "./routes/sync.js";
import * as tokens from "./routes/tokens.js";

const router = new Router();
for (const mod of [auth, sessions, sync, packages, imports, integrations, tokens]) mod.register(router);

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || origin !== env.APP_ORIGIN) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  if (Object.keys(headers).length === 0) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

async function handleApi(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  try {
    const res = await router.handle(req, env, exec);
    return res ?? errorResponse(404, "not_found", "No such endpoint");
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, { ...err.headers }, err.details);
    console.error("unhandled", req.method, new URL(req.url).pathname, err);
    return errorResponse(500, "internal", "Something went wrong");
  }
}

export default {
  async fetch(req, env, exec): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/v1" || pathname.startsWith("/v1/")) {
      return withHeaders(await handleApi(req, env, exec), corsHeaders(req, env));
    }
    return serveAssets(req, env.ASSETS);
  },

  async scheduled(controller, env, exec): Promise<void> {
    await schedule(controller, env, exec);
  },

  async queue(batch, env, exec): Promise<void> {
    await consume(batch, env, exec);
  },
} satisfies ExportedHandler<Env, TrackJob>;
