import { CarrierError, type CarrierErrorKind, type TrackContext } from "../../types.js";
import { parseRetryAfter } from "./http.js";

// Helpers for the web adapters (adapters/web/), which read carriers' public
// tracking feeds the way their own pages do. See docs/research/scraping.md.

/** Every web request gives up after this long (scraping.md: 10 s). */
export const WEB_TIMEOUT_MS = 10_000;

/** Replies longer than this are dropped unread. The largest real feed is well under 100 KB. */
export const MAX_WEB_BYTES = 2 * 1024 * 1024;

/** Safari on macOS, matching the device web view's user agent. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";

/** Headers a browser sends with a script's JSON request; `extra` wins. */
export function browserHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "user-agent": BROWSER_USER_AGENT,
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    ...extra,
  };
}

export interface WebReply {
  status: number;
  headers: Headers;
  text: string;
}

export interface WebRequestOptions {
  timeoutMs?: number;
  /** Error kind for a timeout. Default `transient`; web:ups uses `device_required`. */
  onTimeout?: CarrierErrorKind;
  /** Largest body read. Default MAX_WEB_BYTES. */
  maxBytes?: number;
}

function isTimeout(error: unknown): boolean {
  const name = error instanceof Error || (typeof DOMException !== "undefined" && error instanceof DOMException) ? (error as Error).name : "";
  return name === "TimeoutError" || name === "AbortError";
}

/** The body as text, or a `transient` error once it passes `max` bytes. */
async function readCapped(response: Response, adapter: string, max: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new CarrierError("transient", adapter, `${adapter} reply is larger than ${max} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new CarrierError("transient", adapter, `${adapter} reply is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Calls ctx.fetch with a timeout and returns the raw reply. Never throws on
 * HTTP status: each adapter decides what a status means for its feed.
 * Redirects are never followed, so a feed can't send the request to another
 * host; a 3xx comes back as the reply. Bodies over MAX_WEB_BYTES are refused.
 */
export async function fetchWeb(
  ctx: TrackContext,
  adapter: string,
  url: string,
  init: RequestInit,
  options: WebRequestOptions = {},
): Promise<WebReply> {
  const timeoutMs = options.timeoutMs ?? WEB_TIMEOUT_MS;
  let response: Response;
  let text: string;
  try {
    response = await ctx.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    text = await readCapped(response, adapter, options.maxBytes ?? MAX_WEB_BYTES);
  } catch (cause) {
    if (cause instanceof CarrierError) throw cause;
    if (isTimeout(cause)) {
      throw new CarrierError(options.onTimeout ?? "transient", adapter, `${adapter} timed out after ${timeoutMs} ms`, { cause });
    }
    throw new CarrierError("transient", adapter, `network error calling ${adapter}`, { cause });
  }
  return { status: response.status, headers: response.headers, text };
}

/** Parsed JSON, or undefined when the text is empty or not JSON. */
export function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Bot-check pages from Cloudflare, Akamai and Amazon that can stand in for a feed's reply. */
const CHALLENGE =
  /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied)|bm-verify|sec-if-cpt|\/errors\/validateCaptcha|opfcaptcha/i;

export function looksLikeChallenge(text: string): boolean {
  return CHALLENGE.test(text.slice(0, 64_000));
}

/** A reply the adapter did not expect. 429 is a rate limit; everything else is retried later. */
export function unexpectedReply(adapter: string, reply: WebReply, now: Date): CarrierError {
  const message = `${adapter} HTTP ${reply.status}`;
  if (reply.status === 429) {
    return new CarrierError("rate_limited", adapter, message, { retryAfterSec: parseRetryAfter(reply.headers.get("retry-after"), now) });
  }
  return new CarrierError("transient", adapter, message);
}

/** The feed answered in a shape we don't recognise; retry later rather than guess. */
export function malformed(adapter: string, what: string): CarrierError {
  return new CarrierError("transient", adapter, `${adapter}: ${what}`);
}

/** The feed has no single package that is the one we asked for. */
export function notFound(adapter: string, why: string): CarrierError {
  return new CarrierError("not_found", adapter, `${adapter}: ${why}`);
}

/** Tracking numbers compared the way carriers echo them: case, spaces, dots and dashes ignored. */
export function sameNumber(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const clean = (v: string) => v.toUpperCase().replace(/[\s.-]/g, "");
  return clean(a) !== "" && clean(a) === clean(b);
}
