import type { CarrierEnv, TrackContext } from "../../src/types.js";

export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Route {
  /** Matched against the request URL with `includes`. */
  url: string;
  method?: string;
  /** Replies are used in order; the last one repeats. */
  replies: FakeReply[];
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

/** A fetch that serves recorded fixtures and records every call. Never touches the network. */
export function fakeFetch(routes: Route[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const used = new Map<Route, number>();
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const route = routes.find((r) => url.includes(r.url) && (r.method ?? method) === method);
    if (!route) throw new Error(`fakeFetch: no route for ${method} ${url}`);
    const n = used.get(route) ?? 0;
    used.set(route, n + 1);
    const reply = route.replies[Math.min(n, route.replies.length - 1)] ?? {};
    const body = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

export function makeCtx(fetchImpl: typeof fetch, env: CarrierEnv, now = new Date("2026-11-08T12:00:00Z")): TrackContext & { clock: { now: Date } } {
  const clock = { now };
  return { fetch: fetchImpl, env, now: () => clock.now, clock };
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
