// APNs push (SPEC §3 Push, docs/API.md "Push payloads"). Token-based auth:
// an ES256 provider JWT signed with the .p8 key through WebCrypto, sent over
// HTTPS to api.push.apple.com. Visible alerts for out_for_delivery, delivered
// and exception transitions; a silent background push for any other change.
import type { Status } from "@porchlight/carriers";
import type { Env } from "../env.js";

export const APNS_ORIGIN = "https://api.push.apple.com";
export const VISIBLE_STATUSES: ReadonlySet<Status> = new Set(["out_for_delivery", "delivered", "exception"]);
/** Apple rejects provider tokens older than an hour and throttles refreshes under 20 min. */
const TOKEN_REUSE_SEC = 50 * 60;
const MAX_DETAIL_CHARS = 200;

export type ApnsEnv = Pick<Env, "DB" | "APNS_TEAM_ID" | "APNS_KEY_ID" | "APNS_PRIVATE_KEY" | "APNS_TOPIC">;

export interface PackageChange {
  userId: string;
  packageId: string;
  title: string | null;
  status: Status;
  statusDetail: string | null;
  statusChanged: boolean;
}

export interface ApnsPush {
  pushType: "alert" | "background";
  priority: 10 | 5;
  payload: Record<string, unknown>;
}

export interface ApnsDeps {
  fetch: typeof fetch;
  nowSec(): number;
}

const defaultDeps: ApnsDeps = { fetch: (input, init) => fetch(input, init), nowSec: () => Math.floor(Date.now() / 1000) };

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

/** ES256 provider token. WebCrypto's ECDSA signature is already the raw r||s form JWS wants. */
export async function createProviderToken(teamId: string, keyId: string, pkcs8Pem: string, nowSec: number): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(pkcs8Pem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = new TextEncoder();
  const signingInput = `${b64url(enc.encode(JSON.stringify({ alg: "ES256", kid: keyId })))}.${b64url(
    enc.encode(JSON.stringify({ iss: teamId, iat: nowSec })),
  )}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

const tokenCache = new Map<string, { token: string; iat: number }>();

async function providerToken(teamId: string, keyId: string, pem: string, nowSec: number): Promise<string> {
  const cacheKey = `${teamId}|${keyId}|${pem}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && nowSec >= hit.iat && nowSec - hit.iat < TOKEN_REUSE_SEC) return hit.token;
  const token = await createProviderToken(teamId, keyId, pem, nowSec);
  tokenCache.set(cacheKey, { token, iat: nowSec });
  return token;
}

function alertBody(status: Status, detail: string | null): string {
  const d = detail?.slice(0, MAX_DETAIL_CHARS) || null;
  if (status === "out_for_delivery") return d ?? "Out for delivery";
  if (status === "delivered") return d ?? "Delivered";
  return d ? `Delivery problem: ${d}` : "Delivery problem";
}

export function buildPush(c: PackageChange): ApnsPush {
  if (c.statusChanged && VISIBLE_STATUSES.has(c.status)) {
    return {
      pushType: "alert",
      priority: 10,
      payload: {
        aps: { alert: { title: c.title ?? "Your package", body: alertBody(c.status, c.statusDetail) }, sound: "default" },
        packageId: c.packageId,
      },
    };
  }
  return { pushType: "background", priority: 5, payload: { aps: { "content-available": 1 }, packageId: c.packageId } };
}

type SendResult = "sent" | "dead_token" | "failed";

async function sendOne(deviceToken: string, push: ApnsPush, jwt: string, topic: string, packageId: string, deps: ApnsDeps): Promise<SendResult> {
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": topic,
    "apns-push-type": push.pushType,
    "apns-priority": String(push.priority),
    "content-type": "application/json",
  };
  if (push.pushType === "alert") headers["apns-collapse-id"] = packageId;
  const res = await deps.fetch(`${APNS_ORIGIN}/3/device/${encodeURIComponent(deviceToken)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(push.payload),
  });
  if (res.ok) return "sent";
  const reason = ((await res.json().catch(() => ({}))) as { reason?: string }).reason ?? "";
  if (res.status === 410 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic") return "dead_token";
  console.warn("apns: send failed", res.status, reason);
  return "failed";
}

/** Pushes a package change to every device of the user. Returns how many were accepted. */
export async function notifyPackageChange(env: ApnsEnv, change: PackageChange, deps: ApnsDeps = defaultDeps): Promise<number> {
  const { APNS_TEAM_ID: teamId, APNS_KEY_ID: keyId, APNS_PRIVATE_KEY: pem, APNS_TOPIC: topic } = env;
  if (!teamId || !keyId || !pem || !topic) return 0;

  const { results } = await env.DB.prepare("SELECT apns_token FROM devices WHERE user_id = ? AND apns_token IS NOT NULL")
    .bind(change.userId)
    .all<{ apns_token: string }>();
  if (results.length === 0) return 0;

  const jwt = await providerToken(teamId, keyId, pem, deps.nowSec());
  const push = buildPush(change);
  let sent = 0;
  for (const { apns_token: token } of results) {
    const outcome = await sendOne(token, push, jwt, topic, change.packageId, deps).catch((err: unknown) => {
      console.warn("apns: request error", err);
      return "failed" as const;
    });
    if (outcome === "sent") sent += 1;
    if (outcome === "dead_token") {
      await env.DB.prepare("UPDATE devices SET apns_token = NULL WHERE user_id = ? AND apns_token = ?").bind(change.userId, token).run();
    }
  }
  return sent;
}
