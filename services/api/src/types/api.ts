// CONTRACT: JSON shapes of the /v1 API. Mirrors docs/API.md exactly; change
// both together. Every response body is wrapped in the Envelope from
// lib/http.ts. All timestamps are ISO 8601 UTC strings ("2026-11-08T17:04:00.000Z"),
// except a date-only ETA, which is a calendar date ("2026-11-10").
import type { CarrierId, DataSource, DeviceCarrier, Status, TrackEvent } from "@porchlight/carriers";

export type { DataSource, DeviceCarrier };

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

/** Which APNs host serves the device's token: development builds use sandbox. */
export type ApnsEnvironment = "sandbox" | "production";

export interface DevicePutRequest {
  platform: Platform;
  apnsToken: string | null;
  appVersion: string | null;
  /** Omitted: "production" on create, unchanged on update. */
  environment?: ApnsEnvironment;
}

export interface Device {
  id: string;
  platform: Platform;
  apnsToken: string | null;
  appVersion: string | null;
  environment: ApnsEnvironment;
}

// ---- Sessions -------------------------------------------------------------

export interface SessionInfo {
  id: string;
  /** The linked device's platform, else the client that signed in; null for old sessions. */
  platform: Platform | null;
  /** From the linked device; null without one. */
  appVersion: string | null;
  createdAt: string;
  lastSeenAt: string;
  /** True for the session making this request. */
  current: boolean;
}

export interface SessionsResponse {
  /** Most recently seen first. */
  sessions: SessionInfo[];
}

export interface SessionDeleteResponse {
  deleted: true;
  /** True when the deleted session was the caller's own: the caller is now signed out. */
  signedOut: boolean;
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
  /**
   * When etaDateOnly is true: calendar dates "YYYY-MM-DD", the carrier's
   * local delivery date, never shifted by time zone. When false: ISO 8601
   * UTC instants.
   */
  etaStart: string | null;
  etaEnd: string | null;
  /** False when there is no ETA. */
  etaDateOnly: boolean;
  deliveredAt: string | null;
  lastCheckedAt: string | null;
  archivedAt: string | null;
  updatedAt: string;
  items: PackageItem[];
  /** Where the current status came from (packages.last_source); null until something is read. */
  dataSource: DataSource | null;
  /**
   * A line the carrier's terms require clients to show in the detail view, as
   * given. Today only "Delivered by Deutsche Post DHL Group" (dataSource "api",
   * carrier "dhl" or "dhl_ecommerce"); null otherwise.
   */
  attribution: string | null;
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

/** GET /v1/packages/:id */
export interface PackageResponse {
  package: Package;
  /** Newest first. */
  events: PackageEvent[];
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

// ---- Device tracking ------------------------------------------------------

/**
 * Why the server wants the device to look:
 * - `new`: a device-carrier package that has never been read.
 * - `scheduled`: the per-package cadence is due (scraping.md "Polling limits").
 * - `manual`: the user asked for a refresh.
 * - `server_blocked`: web:ups threw device_required.
 */
export type DeviceJobReason = "new" | "scheduled" | "manual" | "server_blocked";

export interface DeviceJob {
  packageId: string;
  carrier: DeviceCarrier;
  trackingNumber: string;
  reason: DeviceJobReason;
}

/** GET /v1/device-tracking/due: at most 10, oldest device_needed_at first. */
export interface DeviceJobsResponse {
  jobs: DeviceJob[];
}

/**
 * - `ok`: the page loaded and was parsed; status, ETA and events apply.
 * - `not_found`: the carrier said it doesn't know the number.
 * - `challenged`: a bot check or CAPTCHA stopped the read.
 * - `failed`: anything else (timeout, page layout the parser doesn't know).
 */
export type DeviceOutcome = "ok" | "not_found" | "challenged" | "failed";

/**
 * POST /v1/packages/:id/observed. Every key is sent. When outcome isn't "ok"
 * the server ignores status, ETA, deliveredAt and events (send "unknown",
 * nulls, false and []).
 */
export interface DeviceObservation {
  /** When the device read the page. ISO 8601 with offset. */
  observedAt: string;
  source: "device";
  status: Status;
  statusDetail: string | null;
  /** Form follows etaDateOnly, as in Package. */
  etaStart: string | null;
  etaEnd: string | null;
  etaDateOnly: boolean;
  deliveredAt: string | null;
  /** Newest first. */
  events: TrackEvent[];
  outcome: DeviceOutcome;
}

export interface DeviceObservedResponse {
  /** False when the outcome wasn't "ok" or observedAt was not newer than the last check. */
  applied: boolean;
  /** When the server next wants a device read; null when none is wanted. */
  deviceNeededAt: string | null;
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
  /** The ETA window Amazon showed; null when it showed none. Form follows etaDateOnly. */
  etaStart: string | null;
  etaEnd: string | null;
  /** True: etaStart/etaEnd are "YYYY-MM-DD". Omitted or false: ISO 8601 instants. */
  etaDateOnly?: boolean;
  /** Status read on-device; sent for Amazon Logistics (TBA) packages. */
  observed?: AmazonObserved;
}

export interface AmazonImportRequest {
  items: AmazonImportItem[];
}

export type ImportOutcome = "created" | "updated" | "unchanged" | "rejected";

// ---- Integrations ---------------------------------------------------------

export type AmazonImportState = "ok" | "needs_sign_in" | "parse_failed";

/** PUT /v1/integrations/amazon: what a device reports after an import. */
export interface AmazonStatusReport {
  state: AmazonImportState;
  /** The last import that worked; null if none has yet. */
  lastImportAt: string | null;
  /** One sentence for Settings when state isn't "ok". */
  lastError?: string | null;
}

export interface AmazonIntegration {
  state: AmazonImportState;
  lastImportAt: string | null;
  lastError: string | null;
  /** When the server received the report. */
  reportedAt: string;
  /** Platform of the device that sent it. */
  platform: Platform | null;
}

export interface AmazonIntegrationResponse {
  /** null until a device reports, and after DELETE. */
  amazon: AmazonIntegration | null;
}

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
