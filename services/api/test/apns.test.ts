import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { buildPush, createProviderToken, notifyPackageChange, type PackageChange } from "../src/lib/apns.js";
import { seedDevice, seedUser } from "./poll-helpers.js";

const NOW_SEC = Date.parse("2026-11-08T18:00:00.000Z") / 1000;

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function makeKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return { pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

function change(over: Partial<PackageChange> = {}): PackageChange {
  return {
    userId: "u",
    packageId: "p-1",
    title: "Headphones",
    status: "in_transit",
    statusDetail: "Departed facility",
    statusChanged: true,
    ...over,
  };
}

describe("createProviderToken", () => {
  it("makes an ES256 JWT with kid, iss and iat that verifies with the key", async () => {
    const { pem, publicKey } = await makeKey();
    const jwt = await createProviderToken("VTQW687WBQ", "KEY123", pem, NOW_SEC);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h)))).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(p)))).toEqual({ iss: "VTQW687WBQ", iat: NOW_SEC });
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      b64urlDecode(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });
});

describe("buildPush", () => {
  it("sends a visible alert for out_for_delivery, delivered and exception transitions", () => {
    for (const status of ["out_for_delivery", "delivered", "exception"] as const) {
      const push = buildPush(change({ status }));
      expect(push.pushType).toBe("alert");
      expect(push.priority).toBe(10);
      const aps = push.payload.aps as { alert: { title: string; body: string } };
      expect(aps.alert.title).toBe("Headphones");
      expect(aps.alert.body.length).toBeGreaterThan(0);
      expect(push.payload.packageId).toBe("p-1");
    }
  });

  it("sends a silent push for other changes, and when the status did not change", () => {
    for (const c of [change(), change({ status: "delivered", statusChanged: false })]) {
      const push = buildPush(c);
      expect(push).toEqual({ pushType: "background", priority: 5, payload: { aps: { "content-available": 1 }, packageId: "p-1" } });
    }
  });
});

describe("notifyPackageChange", () => {
  async function setup() {
    const { pem } = await makeKey();
    const apnsEnv = { ...env, APNS_KEY_ID: "KEY123", APNS_PRIVATE_KEY: pem, APNS_TOPIC: "co.xanom.porchlight" } as Env;
    const userId = await seedUser(env);
    return { apnsEnv, userId };
  }

  it("POSTs to api.push.apple.com for every device with a token", async () => {
    const { apnsEnv, userId } = await setup();
    await seedDevice(env, userId, "aaaa");
    await seedDevice(env, userId, "bbbb");
    await seedDevice(env, userId, null);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));

    const sent = await notifyPackageChange(apnsEnv, change({ userId, status: "delivered" }), {
      fetch: fetchMock as unknown as typeof fetch,
      nowSec: () => NOW_SEC,
    });

    expect(sent).toBe(2);
    const urls = fetchMock.mock.calls.map((c) => String(c[0])).sort();
    expect(urls).toEqual(["https://api.push.apple.com/3/device/aaaa", "https://api.push.apple.com/3/device/bbbb"]);
    const init = fetchMock.mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(init.method).toBe("POST");
    expect(headers.get("authorization")).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(headers.get("apns-topic")).toBe("co.xanom.porchlight");
    expect(headers.get("apns-push-type")).toBe("alert");
    expect(headers.get("apns-priority")).toBe("10");
    expect(JSON.parse(String(init.body)).aps.alert.title).toBe("Headphones");
  });

  it("uses background push headers for silent pushes", async () => {
    const { apnsEnv, userId } = await setup();
    await seedDevice(env, userId, "cccc");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));
    await notifyPackageChange(apnsEnv, change({ userId }), { fetch: fetchMock as unknown as typeof fetch, nowSec: () => NOW_SEC });
    const headers = new Headers(fetchMock.mock.calls[0]![1]!.headers);
    expect(headers.get("apns-push-type")).toBe("background");
    expect(headers.get("apns-priority")).toBe("5");
  });

  it("clears tokens APNs reports as unregistered", async () => {
    const { apnsEnv, userId } = await setup();
    const dead = await seedDevice(env, userId, "dead");
    const fetchMock = vi.fn(async () => Response.json({ reason: "Unregistered" }, { status: 410 }));
    const sent = await notifyPackageChange(apnsEnv, change({ userId }), { fetch: fetchMock as unknown as typeof fetch, nowSec: () => NOW_SEC });
    expect(sent).toBe(0);
    const row = await env.DB.prepare("SELECT apns_token FROM devices WHERE id = ?").bind(dead).first<{ apns_token: string | null }>();
    expect(row?.apns_token).toBeNull();
  });

  it("does nothing when the APNs key or topic is not configured", async () => {
    const userId = await seedUser(env);
    await seedDevice(env, userId, "eeee");
    const fetchMock = vi.fn();
    const sent = await notifyPackageChange(env as Env, change({ userId }), { fetch: fetchMock as unknown as typeof fetch, nowSec: () => NOW_SEC });
    expect(sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
