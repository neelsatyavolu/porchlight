// Typed client for the /v1 API (docs/API.md). The web authenticates with the
// porchlight_session HttpOnly cookie, so every call sends credentials and the
// browser adds the Origin header the server checks on writes.
import type {
  ApiErrorBody,
  ApiTokenInfo,
  AppleSignInRequest,
  Envelope,
  ErrorCode,
  MeResponse,
  Package,
  PackageDeleteResponse,
  PackageEvent,
  PackagePutRequest,
  PairingStartResponse,
  RefreshResponse,
  SessionDeleteResponse,
  SessionInfo,
  SessionsResponse,
  SignInResponse,
  SyncResponse,
  TokensResponse,
  User,
} from "./types";

/** `network` means no HTTP response at all; `invalid_response` means a body that isn't an envelope. */
export type ClientErrorCode = ErrorCode | "network" | "invalid_response";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly details: Record<string, unknown> | undefined = undefined,
    /** Seconds from the Retry-After header on a 429. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isApiError(err: unknown, code?: ClientErrorCode): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface ClientOptions {
  /** Defaults to "/v1" (same origin as the page). */
  baseUrl?: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export interface FullSync {
  packages: Package[];
  events: PackageEvent[];
  deleted: string[];
  cursor: string;
}

function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.ok === "boolean" && "data" in v && "error" in v;
}

function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function toError(res: Response, body: ApiErrorBody): ApiError {
  return new ApiError(res.status, body.code, body.message, body.details, parseRetryAfter(res));
}

/**
 * Folds sync pages into one result. A package edited while the pages are being
 * fetched can come back on a later page too, with all of its events again; the
 * later copy wins, so events are never listed twice. Pages are in order, so
 * a later deletion drops an earlier copy and a later copy undoes an earlier deletion.
 */
export function mergePages(pages: readonly SyncResponse[]): Omit<FullSync, "cursor"> {
  const packages = new Map<string, Package>();
  const events = new Map<string, PackageEvent[]>();
  const deleted = new Set<string>();
  for (const page of pages) {
    const pageEvents = new Map<string, PackageEvent[]>();
    for (const e of page.events) pageEvents.set(e.packageId, [...(pageEvents.get(e.packageId) ?? []), e]);
    for (const pkg of page.packages) {
      packages.set(pkg.id, pkg);
      events.set(pkg.id, pageEvents.get(pkg.id) ?? []);
      deleted.delete(pkg.id);
    }
    for (const id of page.deleted) {
      packages.delete(id);
      events.delete(id);
      deleted.add(id);
    }
  }
  return { packages: [...packages.values()], events: [...events.values()].flat(), deleted: [...deleted] };
}

export function createClient(options: ClientOptions = {}) {
  const baseUrl = options.baseUrl ?? "/v1";
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, credentials: "include", headers: { accept: "application/json" } };
    if (body !== undefined) {
      init.headers = { accept: "application/json", "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, init);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ApiError(0, "network", `Couldn't reach Porchlight (${reason})`);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new ApiError(res.status, "invalid_response", `Unexpected response (HTTP ${res.status})`);
    }
    if (!isEnvelope(parsed)) {
      throw new ApiError(res.status, "invalid_response", `Unexpected response (HTTP ${res.status})`);
    }
    if (!parsed.ok) throw toError(res, parsed.error);
    return parsed.data as T;
  }

  const id = encodeURIComponent;

  const sync = (since?: string) =>
    request<SyncResponse>("GET", since === undefined ? "/sync" : `/sync?since=${encodeURIComponent(since)}`);

  /** Follows `hasMore` until the server has nothing left after `since`. */
  async function syncAll(since?: string): Promise<FullSync> {
    const pages: SyncResponse[] = [];
    let cursor = since;
    for (;;) {
      const page = await sync(cursor);
      pages.push(page);
      if (!page.hasMore) break;
      cursor = page.cursor;
    }
    return { ...mergePages(pages), cursor: pages[pages.length - 1]?.cursor ?? since ?? "" };
  }

  return {
    request,

    // Auth
    emailStart: (email: string) => request<{ sent: true }>("POST", "/auth/email/start", { email, client: "web" }),
    emailVerifyToken: (token: string) => request<SignInResponse>("POST", "/auth/email/verify", { token, client: "web" }),
    emailVerifyCode: (email: string, code: string) =>
      request<SignInResponse>("POST", "/auth/email/verify", { email, code, client: "web" }),
    appleSignIn: (identityToken: string, nonce: string) =>
      request<SignInResponse>("POST", "/auth/apple", { identityToken, nonce, client: "web" } satisfies AppleSignInRequest),
    signOut: () => request<{ signedOut: true }>("POST", "/auth/signout"),
    me: async (): Promise<User> => (await request<MeResponse>("GET", "/me")).user,
    deleteAccount: () => request<{ deleted: true }>("DELETE", "/me"),
    listSessions: async (): Promise<SessionInfo[]> => (await request<SessionsResponse>("GET", "/sessions")).sessions,
    deleteSession: (sessionId: string) => request<SessionDeleteResponse>("DELETE", `/sessions/${id(sessionId)}`),

    // Sync
    sync,
    syncAll,

    // Packages
    putPackage: (packageId: string, body: PackagePutRequest) => request<Package>("PUT", `/packages/${id(packageId)}`, body),
    deletePackage: (packageId: string) => request<PackageDeleteResponse>("DELETE", `/packages/${id(packageId)}`),
    refreshPackage: (packageId: string) => request<RefreshResponse>("POST", `/packages/${id(packageId)}/refresh`),

    // Pairing and API tokens
    pairingStart: () => request<PairingStartResponse>("POST", "/pairing/start"),
    listTokens: async (): Promise<ApiTokenInfo[]> => (await request<TokensResponse>("GET", "/tokens")).tokens,
    deleteToken: (tokenId: string) => request<{ deleted: true }>("DELETE", `/tokens/${id(tokenId)}`),
  };
}

export type ApiClient = ReturnType<typeof createClient>;

/** The app's shared client. Tests build their own with createClient({ fetch }). */
export const api = createClient();
