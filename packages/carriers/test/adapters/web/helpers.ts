import type { CarrierEnv, TrackContext } from "../../../src/types.js";

/** A recorded reply. `body` is sent as JSON unless `text` is given. `timeout` makes the call fail like AbortSignal.timeout. */
export interface WebFake {
  status?: number;
  body?: unknown;
  text?: string;
  contentType?: string;
  setCookie?: string[];
  headers?: Record<string, string>;
  timeout?: boolean;
  networkError?: boolean;
}

export interface WebRoute {
  url: string;
  method?: string;
  replies: WebFake[];
}

export interface WebCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
  signal: AbortSignal | null;
  redirect: RequestRedirect | undefined;
}

/** Fixture files that hold a whole reply ({ status, contentType, body, setCookie }). */
export function page(fixture: { status: number; contentType: string; body: string; setCookie?: string[] }): WebFake {
  return { status: fixture.status, text: fixture.body, contentType: fixture.contentType, setCookie: fixture.setCookie ?? [] };
}

/** A fetch that serves fixtures and records every call. Never touches the network. */
export function webFetch(routes: WebRoute[]): { fetch: typeof fetch; calls: WebCall[] } {
  const calls: WebCall[] = [];
  const used = new Map<WebRoute, number>();
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
      signal: init?.signal ?? null,
      redirect: init?.redirect,
    });
    const route = routes.find((r) => url.includes(r.url) && (r.method ?? method) === method);
    if (!route) throw new Error(`webFetch: no route for ${method} ${url}`);
    const n = used.get(route) ?? 0;
    used.set(route, n + 1);
    const reply = route.replies[Math.min(n, route.replies.length - 1)] ?? {};
    if (reply.timeout) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (reply.networkError) throw new TypeError("fetch failed");
    const headers = new Headers({ "content-type": reply.contentType ?? "application/json", ...reply.headers });
    for (const cookie of reply.setCookie ?? []) headers.append("set-cookie", cookie);
    const text = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(text, { status: reply.status ?? 200, headers });
  };
  return { fetch: impl as typeof fetch, calls };
}

export function webCtx(fetchImpl: typeof fetch, env: CarrierEnv = {}, now = new Date("2026-11-08T12:00:00Z")): TrackContext {
  return { fetch: fetchImpl, env, now: () => now };
}

/** Awaits a promise that must reject, and returns the error. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/** Fails when any of the placeholder strings the fixtures use for personal data reached the result. */
export function expectNoPrivateData(value: unknown): void {
  const text = JSON.stringify(value);
  for (const marker of ["PRIVATE", "private@", "Synthetic Webshop", "Left by", "***", "Example Shop"]) {
    if (text.includes(marker)) throw new Error(`result leaked "${marker}": ${text.slice(0, 300)}`);
  }
}
