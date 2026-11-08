// Wire types for the /v1 API, copied by hand from services/api/src/types/api.ts
// and services/api/src/lib/http.ts (docs/API.md is the contract).
// contract.check.ts fails `tsc` if these drift from the server's copies.
import type { CarrierId, Status, TrackEvent } from "@porchlight/carriers";

export type { CarrierId, Status, TrackEvent };

export type Platform = "ios" | "macos" | "web";
export type Client = Platform;
export type PackageSource = "manual" | "amazon" | "flint" | "share";

// ---- Envelope ---------------------------------------------------------------

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

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type Envelope<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: null; error: ApiErrorBody };

// ---- Auth -------------------------------------------------------------------

export interface AppleSignInRequest {
  identityToken: string;
  nonce: string;
  client: Client;
  deviceId?: string;
}

export interface EmailStartRequest {
  email: string;
  client: Client;
}

export type EmailVerifyRequest =
  | { token: string; client: Client; deviceId?: string }
  | { email: string; code: string; client: Client; deviceId?: string };

export interface User {
  id: string;
  email: string | null;
  hasApple: boolean;
  createdAt: string;
}

export interface SignInResponse {
  /** Always null for the web: the session arrives as an HttpOnly cookie. */
  token: string | null;
  user: User;
  created: boolean;
}

export interface MeResponse {
  user: User;
}

// ---- Packages and sync ------------------------------------------------------

export interface PackageItem {
  name: string;
  imageUrl: string | null;
  quantity: number;
}

export interface Package {
  id: string;
  carrier: CarrierId;
  trackingNumber: string;
  title: string | null;
  merchant: string | null;
  orderId: string | null;
  source: PackageSource;
  status: Status;
  statusDetail: string | null;
  etaStart: string | null;
  etaEnd: string | null;
  deliveredAt: string | null;
  lastCheckedAt: string | null;
  archivedAt: string | null;
  updatedAt: string;
  items: PackageItem[];
}

export interface PackageEvent extends TrackEvent {
  id: string;
  packageId: string;
}

export interface PackagePutRequest {
  trackingNumber?: string;
  carrier?: CarrierId;
  title?: string | null;
  merchant?: string | null;
  orderId?: string | null;
  source?: "manual" | "share";
  archived?: boolean;
}

export interface PackageDeleteResponse {
  id: string;
  deletedAt: string;
}

export interface RefreshResponse {
  queued: true;
  nextAllowedAt: string;
}

export interface SyncResponse {
  packages: Package[];
  events: PackageEvent[];
  deleted: string[];
  cursor: string;
  hasMore: boolean;
}

// ---- Pairing and API tokens -------------------------------------------------

export interface PairingStartResponse {
  code: string;
  expiresAt: string;
}

export interface ApiTokenInfo {
  id: string;
  label: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface TokensResponse {
  tokens: ApiTokenInfo[];
}

/** details of a 409 from PUT /v1/packages/:id. */
export type PackageConflict = { reason: "duplicate"; existingId: string } | { reason: "deleted" };
