// CONTRACT: Worker bindings, vars and secrets. Keep in sync with wrangler.jsonc.
import type { CarrierEnv } from "@porchlight/carriers";
import type { TrackJob } from "./poll/types.js";

export interface Env extends CarrierEnv {
  // Bindings
  DB: D1Database;
  RATE: KVNamespace;
  TRACK_QUEUE: Queue<TrackJob>;
  ASSETS: Fetcher;

  // Vars (wrangler.jsonc "vars")
  /** Apple Developer team id, VTQW687WBQ. */
  APNS_TEAM_ID: string;
  /** The only origin CORS allows, e.g. https://porchlight.xanom.co. */
  APP_ORIGIN: string;
  /**
   * apns-topic: the app bundle id. Not set in wrangler.jsonc until the bundle
   * id is chosen; push is skipped while it is missing.
   */
  APNS_TOPIC?: string;
  /**
   * Local dev only: "1" makes /auth/email/start log the link and code instead
   * of sending mail when RESEND_API_KEY is missing. Ignored unless APP_ORIGIN
   * is localhost or 127.0.0.1. Never set in wrangler.jsonc.
   */
  EMAIL_DEV_LOG?: string;

  // Secrets (wrangler secret put). Optional because local dev and tests run
  // without them; code must handle a missing key explicitly.
  /** Comma-separated Sign in with Apple audiences (bundle ids + web services id). */
  APPLE_CLIENT_IDS?: string;
  RESEND_API_KEY?: string;
  AGGREGATOR_API_KEY?: string;
  USPS_CLIENT_ID?: string;
  USPS_CLIENT_SECRET?: string;
  UPS_CLIENT_ID?: string;
  UPS_CLIENT_SECRET?: string;
  FEDEX_CLIENT_ID?: string;
  FEDEX_CLIENT_SECRET?: string;
  DHL_API_KEY?: string;
  APNS_KEY_ID?: string;
  /** PKCS#8 PEM of the APNs .p8 key. */
  APNS_PRIVATE_KEY?: string;
}
