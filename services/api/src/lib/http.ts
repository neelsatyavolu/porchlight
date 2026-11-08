// CONTRACT: response envelope for every /v1 endpoint (docs/API.md §Conventions).
import type { z } from "zod";

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "internal";

export interface ApiError {
  code: ErrorCode;
  message: string;
  /** Machine-readable extras, e.g. { existingId } on a 409. */
  details?: Record<string, unknown>;
}

export type Envelope<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: null; error: ApiError };

/** Throw from a handler; src/index.ts turns it into an error envelope. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export function json<T>(data: T, status = 200, headers: Record<string, string> = {}): Response {
  const body: Envelope<T> = { ok: true, data, error: null };
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  headers: Record<string, string> = {},
  details?: Record<string, unknown>,
): Response {
  const error: ApiError = details ? { code, message, details } : { code, message };
  const body: Envelope<never> = { ok: false, data: null, error };
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/** Parses and validates a JSON body; throws HttpError 400 on any problem. */
export async function readJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "bad_request", "Body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
    throw new HttpError(400, "bad_request", `${where}${first?.message ?? "Invalid body"}`);
  }
  return parsed.data;
}
