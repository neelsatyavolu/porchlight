import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { WAKE_HOT_MS, WAKE_WARM_MS, wakeDevices } from "../src/poll/wake.js";
import { seedDevice, seedPackage, seedUser } from "./poll-helpers.js";

const NOW = Date.parse("2026-11-09T18:00:00.000Z");
const MIN = 60_000;

async function makePem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
}

let apnsEnv: Env;
let fetchMock: ReturnType<typeof vi.fn>;
const deps = () => ({ fetch: fetchMock as unknown as typeof fetch, nowSec: () => NOW / 1000 });

beforeEach(async () => {
  apnsEnv = { ...env, APNS_KEY_ID: "KEY123", APNS_PRIVATE_KEY: await makePem(), APNS_TOPIC: "co.xanom.porchlight" } as Env;
  fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));
  // Each test starts from a clean slate of wakeable packages.
  await env.DB.prepare("DELETE FROM packages").run();
});

async function userWithPhone(token = `tok-${crypto.randomUUID()}`): Promise<{ userId: string; token: string }> {
  const userId = await seedUser(env);
  await seedDevice(env, userId, token);
  return { userId, token };
}

function wokenTokens(): string[] {
  return fetchMock.mock.calls.map((c) => decodeURIComponent(String(c[0]).split("/3/device/")[1]!));
}

describe("wakeDevices", () => {
  it("sends a silent check push to the iPhones of someone with an Amazon package on the way", async () => {
    const { userId, token } = await userWithPhone();
    await seedPackage(env, { userId, carrier: "amazon", source: "amazon", status: "in_transit", updatedAt: NOW });

    expect(await wakeDevices(apnsEnv, NOW, deps())).toBe(1);
    expect(wokenTokens()).toEqual([token]);
    const init = fetchMock.mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(headers.get("apns-push-type")).toBe("background");
    expect(headers.get("apns-priority")).toBe("5");
    expect(JSON.parse(String(init.body))).toEqual({ aps: { "content-available": 1 }, wake: "check" });
  });

  it("wakes every 20 minutes while something is out for delivery, hourly while it is only in transit", async () => {
    const hot = await userWithPhone();
    await seedPackage(env, { userId: hot.userId, carrier: "amazon", source: "amazon", status: "out_for_delivery", updatedAt: NOW });
    const warm = await userWithPhone();
    await seedPackage(env, { userId: warm.userId, carrier: "amazon", source: "amazon", status: "in_transit", updatedAt: NOW });

    await wakeDevices(apnsEnv, NOW, deps());
    expect(wokenTokens().sort()).toEqual([hot.token, warm.token].sort());

    fetchMock.mockClear();
    await wakeDevices(apnsEnv, NOW + WAKE_HOT_MS, deps());
    expect(wokenTokens()).toEqual([hot.token]);

    fetchMock.mockClear();
    await wakeDevices(apnsEnv, NOW + WAKE_WARM_MS, deps());
    expect(wokenTokens().sort()).toEqual([hot.token, warm.token].sort());
  });

  it("treats a package arriving within the day, or one waiting for a device read, as hot", async () => {
    const soon = await userWithPhone();
    const id = await seedPackage(env, { userId: soon.userId, carrier: "amazon", source: "amazon", status: "in_transit", updatedAt: NOW });
    await env.DB.prepare("UPDATE packages SET eta_start = ? WHERE id = ?").bind(NOW + 6 * 60 * MIN, id).run();
    const usps = await userWithPhone();
    const p = await seedPackage(env, { userId: usps.userId, carrier: "usps", status: "in_transit", updatedAt: NOW });
    await env.DB.prepare("UPDATE packages SET device_needed_at = ? WHERE id = ?").bind(NOW, p).run();

    await wakeDevices(apnsEnv, NOW, deps());
    fetchMock.mockClear();
    await wakeDevices(apnsEnv, NOW + WAKE_HOT_MS, deps());
    expect(wokenTokens().sort()).toEqual([soon.token, usps.token].sort());
  });

  it("leaves people alone when nothing needs a device: delivered, archived, stale, or server-tracked", async () => {
    const a = await userWithPhone();
    await seedPackage(env, { userId: a.userId, carrier: "amazon", source: "amazon", status: "delivered", updatedAt: NOW });
    await seedPackage(env, { userId: a.userId, carrier: "amazon", source: "amazon", status: "in_transit", archivedAt: NOW, updatedAt: NOW });
    await seedPackage(env, { userId: a.userId, carrier: "amazon", source: "amazon", status: "in_transit", updatedAt: NOW - 15 * 24 * 60 * MIN });
    await seedPackage(env, { userId: a.userId, carrier: "dhl", status: "in_transit", updatedAt: NOW });

    expect(await wakeDevices(apnsEnv, NOW, deps())).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wakes only iPhones (the Mac app checks on its own timer) and drops dead tokens", async () => {
    const { userId, token } = await userWithPhone();
    const mac = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO devices (id, user_id, platform, apns_token) VALUES (?, ?, 'macos', 'mac-token')").bind(mac, userId).run();
    await seedPackage(env, { userId, carrier: "amazon", source: "amazon", status: "in_transit", updatedAt: NOW });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ reason: "BadDeviceToken" }), { status: 400 }));

    await wakeDevices(apnsEnv, NOW, deps());
    expect(wokenTokens()).toEqual([token]);
    const row = await env.DB.prepare("SELECT apns_token FROM devices WHERE user_id = ? AND platform = 'ios'").bind(userId).first();
    expect(row).toEqual({ apns_token: null });
  });

  it("does nothing without APNs credentials", async () => {
    const { userId } = await userWithPhone();
    await seedPackage(env, { userId, carrier: "amazon", source: "amazon", status: "in_transit", updatedAt: NOW });
    expect(await wakeDevices({ ...env, APNS_PRIVATE_KEY: undefined } as unknown as Env, NOW, deps())).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
