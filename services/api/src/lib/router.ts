// Tiny dependency-free router (chosen over Hono to keep the Worker small and
// the contract obvious). Patterns are literal segments plus ":name" params.
import type { Env } from "../env.js";
import { errorResponse } from "./http.js";

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface RouteContext {
  req: Request;
  url: URL;
  env: Env;
  exec: ExecutionContext;
  params: Readonly<Record<string, string>>;
}

export type Handler = (ctx: RouteContext) => Promise<Response> | Response;

interface Route {
  method: Method;
  segments: readonly string[];
  handler: Handler;
}

function split(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

function match(segments: readonly string[], parts: readonly string[]): Record<string, string> | null {
  if (segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as string;
    const part = parts[i] as string;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
    else if (seg !== part) return null;
  }
  return params;
}

export class Router {
  private readonly routes: Route[] = [];

  on(method: Method, pattern: string, handler: Handler): this {
    this.routes.push({ method, segments: split(pattern), handler });
    return this;
  }

  /** Returns null when no route matches the path, so the caller can fall through. */
  async handle(req: Request, env: Env, exec: ExecutionContext): Promise<Response | null> {
    const url = new URL(req.url);
    const parts = split(url.pathname);
    let pathMatched = false;
    for (const route of this.routes) {
      let params: Record<string, string> | null;
      try {
        params = match(route.segments, parts);
      } catch {
        // decodeURIComponent throws URIError on a malformed escape.
        return errorResponse(400, "bad_request", "Malformed URL");
      }
      if (!params) continue;
      pathMatched = true;
      if (route.method === req.method) return route.handler({ req, url, env, exec, params });
    }
    return pathMatched ? errorResponse(405, "method_not_allowed", "Method not allowed") : null;
  }
}
