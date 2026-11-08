import { CarrierError, type TrackContext } from "../../types.js";
import { arr, obj, str } from "./json.js";

export interface HttpReply {
  status: number;
  headers: Headers;
  /** Parsed JSON, or null when the body was empty or not JSON. */
  body: unknown;
}

/** Lets an adapter classify a failed reply itself; return undefined to use the default. */
export type Classify = (reply: HttpReply) => CarrierError | undefined;

/** Calls ctx.fetch. Network failures become `transient`. Never throws on HTTP status. */
export async function send(ctx: TrackContext, adapter: string, url: string, init: RequestInit): Promise<HttpReply> {
  let response: Response;
  try {
    response = await ctx.fetch(url, init);
  } catch (cause) {
    throw new CarrierError("transient", adapter, `network error calling ${adapter}`, { cause });
  }
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, headers: response.headers, body };
}

/** Like `send`, but throws a CarrierError for any non-2xx reply. */
export async function requestJson(
  ctx: TrackContext,
  adapter: string,
  url: string,
  init: RequestInit,
  classify?: Classify,
): Promise<HttpReply> {
  const reply = await send(ctx, adapter, url, init);
  if (reply.status >= 200 && reply.status < 300) return reply;
  throw classify?.(reply) ?? errorForReply(adapter, reply, ctx.now());
}

/** Default HTTP status → CarrierError mapping shared by every adapter. */
export function errorForReply(adapter: string, reply: HttpReply, now: Date): CarrierError {
  const detail = errorMessage(reply.body);
  const message = `${adapter} HTTP ${reply.status}${detail ? `: ${detail}` : ""}`;
  const { status } = reply;
  if (status === 401 || status === 403) return new CarrierError("auth", adapter, message);
  if (status === 429) {
    return new CarrierError("rate_limited", adapter, message, {
      retryAfterSec: parseRetryAfter(reply.headers.get("retry-after"), now),
    });
  }
  if (status === 408 || status >= 500) return new CarrierError("transient", adapter, message);
  // Remaining 4xx (404, 400 invalid number, 422): this adapter cannot track the number.
  return new CarrierError("not_found", adapter, message);
}

/** Retry-After as delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: Date): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

/** Best-effort error text from the error shapes the carriers use. */
export function errorMessage(body: unknown): string {
  const b = obj(body);
  const first = (list: unknown) => obj(arr(list)[0]);
  return (
    str(first(b.errors).message) ||
    str(first(obj(b.response).errors).message) ||
    str(obj(b.error).message) ||
    str(b.detail) ||
    str(b.title) ||
    str(b.error_description) ||
    str(b.error) ||
    ""
  ).slice(0, 200);
}
