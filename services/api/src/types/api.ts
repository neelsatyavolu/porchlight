// CONTRACT: JSON shapes of the /v1 API. Mirrors docs/API.md exactly; change
// both together. Every response body is wrapped in the Envelope from
// lib/http.ts. All timestamps are ISO 8601 UTC strings ("2026-11-08T17:04:00.000Z").
import type { CarrierId, Status, TrackEvent } from "@porchlight/carriers";

export type Platform = "ios" | "macos" | "web";
export type Client = Platform;
export type PackageSource = "manual" | "amazon" | "flint" | "share";

// ---- Auth -----------------------------------------------------------------

export interface AppleSignInRequest {
  /** JWT from Sign in with Apple. */
  identityToken: string;
  /** Raw nonce whose SHA-256 the client put in the Apple request. */
  nonce: string;
  client: Client;
  /** Links the session to a device row (native apps). */
  deviceId?: string;
}

export interface EmailStartRequest {
  email: string;
  client: Client;
}

/** Either the token from the emailed link, or the email plus its 6-digit code. */
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
  /** Session token for native clients; null for web (set as HttpOnly cookie). */
  token: string | null;
  user: User;
  /** True when this sign-in created the account. */
  created: boolean;
}

export interface MeResponse {
  user: User;
}

// ---- Devices --------------------------------------------------------------

export interface DevicePutRequest {
  platform: Platform;
  apnsToken: string | null;
  appVersion: string | null;
}

export interface Device {
  id: string;
  platform: Platform;
  apnsToken: string | null;
  appVersion: string | null;
}

// ---- Packages and sync ----------------------------------------------------

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

/** PUT /v1/packages/:id. Only fields present are written. */
export interface PackagePutRequest {
  /** Required when creating. */
  trackingNumber?: string;
  /** Omitted on create: the server runs detectCarrier and takes the top candidate, else "other". */
  carrier?: CarrierId;
  title?: string | null;
  merchant?: string | null;
  orderId?: string | null;
  /** Create only; defaults to "manual". "amazon" and "flint" are reserved for imports. */
  source?: "manual" | "share";
  archived?: boolean;
}

export interface PackageDeleteResponse {
  id: string;
  deletedAt: string;
}

export interface RefreshResponse {
  queued: true;
  /** Earliest time the next manual refresh is allowed. */
  nextAllowedAt: string;
}

export interface SyncResponse {
  /** Changed (or, without `since`, all live) packages, oldest change first. */
  packages: Package[];
  /** Every event of every package in `packages` (full replacement per package). */
  events: PackageEvent[];
  /** Ids of packages deleted since the cursor. Empty on a full sync. */
  deleted: string[];
  /** Opaque; pass as `since` next time. */
  cursor: string;
  /** True when more changes remain; call again with `cursor` right away. */
  hasMore: boolean;
}

// ---- Imports --------------------------------------------------------------

export interface FlintImportItem {
  trackingNumber: string;
  carrier?: CarrierId;
  /** Sender display name. */
  merchant: string | null;
  subject: string | null;
  messageDate: string;
  /** RFC 5322 Message-ID. */
  dedupeKey: string;
}

export interface FlintImportRequest {
  items: FlintImportItem[];
}

export interface AmazonObserved {
  status: Status;
  statusDetail: string;
  /** When the device read the Amazon track page. */
  observedAt: string;
  deliveredAt: string | null;
  /** Newest first, as read from the page. */
  events: TrackEvent[];
}

export interface AmazonImportItem {
  orderId: string;
  shipmentId: string;
  carrier: CarrierId;
  trackingNumber: string;
  title: string | null;
  items: PackageItem[];
  /** The ETA window Amazon showed; null when it showed none. */
  etaStart: string | null;
  etaEnd: string | null;
  /** Status read on-device; sent for Amazon Logistics (TBA) packages. */
  observed?: AmazonObserved;
}

export interface AmazonImportRequest {
  items: AmazonImportItem[];
}

export type ImportOutcome = "created" | "updated" | "unchanged" | "rejected";

export interface ImportResult {
  dedupeKey: string;
  packageId: string | null;
  outcome: ImportOutcome;
  /** Set when outcome is "rejected". */
  reason?: string;
}

export interface ImportResponse {
  results: ImportResult[];
}

// ---- Pairing and API tokens -----------------------------------------------

export interface PairingStartResponse {
  /** 8 Crockford base32 chars shown as "ABCD-EFGH". */
  code: string;
  expiresAt: string;
}

export interface PairingClaimRequest {
  code: string;
  /** e.g. "Flint on Neel's MacBook Pro". */
  label: string;
}

export interface PairingClaimResponse {
  /** "plt_" + random; shown once, store it in the Keychain. */
  token: string;
  tokenId: string;
  scopes: string[];
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
