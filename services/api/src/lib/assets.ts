// Static serving for everything outside /v1 (README.md, "Serving").
// public/ holds the site at the root and the web app under public/app.
// wrangler.jsonc's run_worker_first sends the web app's routes here; they get
// the matching file if there is one, else the SPA shell instead of a 404.
// Keep APP_ROUTE and run_worker_first in step.
//
// SECURITY_HEADERS (CSP and friends) go on every response this file returns.
// Files served without the Worker get the same headers from public/_headers,
// which site/build.mjs writes from the same JSON.
import SECURITY_HEADERS from "./security-headers.json";

export { SECURITY_HEADERS };

/** Paths the React app owns. /auth/verify is the magic link the API emails. */
const APP_ROUTE = /^\/(?:app|signin|auth\/verify)(?:\/|$)/;

/** True for a web app route that should get /app/index.html. Paths with a file extension never do. */
export function isAppRoute(pathname: string): boolean {
  if (!APP_ROUTE.test(pathname)) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !last.includes(".");
}

function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  return out;
}

export async function serveAssets(req: Request, assets: Fetcher): Promise<Response> {
  const { pathname } = new URL(req.url);
  const isRead = req.method === "GET" || req.method === "HEAD";
  if (!isRead || !isAppRoute(pathname)) return withSecurityHeaders(await assets.fetch(req));

  const res = await assets.fetch(req);
  // A redirect here is html_handling adding a trailing slash (bare "/app"); serve the shell instead.
  const isRedirect = res.status >= 300 && res.status < 400;
  if (res.status !== 404 && !isRedirect) return withSecurityHeaders(res);
  // "/app/" rather than "/app/index.html": the latter redirects under html_handling.
  return withSecurityHeaders(
    await assets.fetch(new Request(new URL("/app/", req.url), { method: req.method, headers: req.headers })),
  );
}
