import { CarrierError, type TrackContext } from "../../types.js";

export interface CachedToken {
  value: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Where OAuth access tokens live between calls. Swap in a KV-backed one if needed. */
export interface TokenCache {
  get(key: string): CachedToken | undefined;
  set(key: string, token: CachedToken): void;
  delete(key: string): void;
}

export function memoryTokenCache(): TokenCache {
  const map = new Map<string, CachedToken>();
  return {
    get: (key) => map.get(key),
    set: (key, token) => void map.set(key, token),
    delete: (key) => void map.delete(key),
  };
}

export interface IssuedToken {
  accessToken: string;
  expiresInSec: number;
}

/** Refresh this long before the carrier's expiry, so a token never dies mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Client-credentials token handling for one adapter: caches by key with expiry,
 * shares one in-flight request between concurrent callers, and retries a call
 * once with a fresh token when the carrier rejects the current one.
 */
export class OAuthTokens {
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly adapter: string,
    private readonly cache: TokenCache,
    private readonly issue: (ctx: TrackContext) => Promise<IssuedToken>,
  ) {}

  async get(ctx: TrackContext, key: string): Promise<string> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > ctx.now().getTime()) return cached.value;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = this.fetchToken(ctx, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  /** Runs `call` with a token; on an auth failure, drops the token and tries once more. */
  async withToken<T>(ctx: TrackContext, key: string, call: (token: string) => Promise<T>): Promise<T> {
    const token = await this.get(ctx, key);
    try {
      return await call(token);
    } catch (error) {
      if (!(error instanceof CarrierError) || error.kind !== "auth") throw error;
      this.cache.delete(key);
      return call(await this.get(ctx, key));
    }
  }

  private async fetchToken(ctx: TrackContext, key: string): Promise<string> {
    const issued = await this.issue(ctx);
    if (!issued.accessToken || !Number.isFinite(issued.expiresInSec)) {
      throw new CarrierError("transient", this.adapter, `${this.adapter} token response was malformed`);
    }
    this.cache.set(key, { value: issued.accessToken, expiresAt: ctx.now().getTime() + issued.expiresInSec * 1000 });
    return issued.accessToken;
  }
}
