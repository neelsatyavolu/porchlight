import { describe, expect, it } from "vitest";
import { isAppRoute, SECURITY_HEADERS, serveAssets } from "../src/lib/assets.js";

const FILES: Record<string, string> = {
  "/": "site home",
  "/privacy": "privacy page",
  "/app/": "spa shell",
  "/app/assets/index.js": "js",
};

/** Stands in for env.ASSETS with not_found_handling "404-page". */
function fakeAssets(): Fetcher & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async fetch(input: RequestInfo | URL) {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      seen.push(path);
      // html_handling "auto-trailing-slash": a directory without its slash redirects.
      if (path === "/app") return new Response(null, { status: 307, headers: { location: "/app/" } });
      const body = FILES[path];
      return body === undefined ? new Response("site 404", { status: 404 }) : new Response(body);
    },
    connect() {
      throw new Error("not used");
    },
  } as unknown as Fetcher & { seen: string[] };
}

async function get(path: string, method = "GET") {
  const assets = fakeAssets();
  const res = await serveAssets(new Request(`https://porchlight.test${path}`, { method }), assets);
  return { status: res.status, body: await res.text(), seen: assets.seen, headers: res.headers };
}

describe("isAppRoute", () => {
  it("matches the web app's routes", () => {
    for (const p of ["/app", "/app/", "/app/p/123", "/app/settings", "/signin", "/signin/verify", "/auth/verify"]) {
      expect(isAppRoute(p), p).toBe(true);
    }
  });

  it("leaves the site, files and look-alike paths alone", () => {
    for (const p of ["/", "/privacy", "/apples", "/signing", "/auth", "/app/assets/x.js", "/app/favicon.ico"]) {
      expect(isAppRoute(p), p).toBe(false);
    }
  });
});

describe("serveAssets", () => {
  it("serves the SPA shell for an app route with no matching file", async () => {
    expect(await get("/app/p/123")).toMatchObject({ status: 200, body: "spa shell", seen: ["/app/p/123", "/app/"] });
    expect((await get("/signin/verify?token=t")).body).toBe("spa shell");
    expect((await get("/auth/verify?token=t")).body).toBe("spa shell");
  });

  it("serves the SPA shell for bare /app instead of a trailing-slash redirect", async () => {
    expect(await get("/app")).toMatchObject({ status: 200, body: "spa shell" });
  });

  it("serves real files as they are", async () => {
    expect(await get("/app/assets/index.js")).toMatchObject({ body: "js", seen: ["/app/assets/index.js"] });
    expect((await get("/privacy")).body).toBe("privacy page");
  });

  it("keeps the site's 404 for unknown site paths and missing app files", async () => {
    expect(await get("/nope")).toMatchObject({ status: 404, body: "site 404" });
    expect(await get("/app/assets/missing.js")).toMatchObject({ status: 404, body: "site 404" });
  });

  it("does not rewrite non-read methods", async () => {
    expect((await get("/app/p/1", "POST")).status).toBe(404);
  });

  it("adds the CSP and other security headers to every response", async () => {
    for (const [path, method] of [["/app/p/1", "GET"], ["/signin", "GET"], ["/auth/verify?token=t", "GET"], ["/app/assets/index.js", "GET"], ["/nope", "GET"], ["/app/p/1", "POST"]]) {
      const { headers } = await get(path!, method);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(headers.get(name), `${method} ${path} ${name}`).toBe(value);
    }
  });

  it("uses a CSP that blocks inline script and framing but allows Sign in with Apple", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"];
    const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";
    expect(directive("script-src")).toBe("script-src 'self' https://appleid.cdn-apple.com");
    expect(directive("script-src")).not.toContain("unsafe");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("connect-src")).toBe("connect-src 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
  });
});
