// End-to-end device read through the real Worker entry: a USPS package →
// the poller hands it to the device → GET /v1/device-tracking/due lists it →
// POST /v1/packages/:id/observed (out_for_delivery) → sync shows it with
// dataSource "device" → the push goes out (APNs fetch mocked).
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { setResendFetch } from "../src/lib/resend.js";
import { consumeBatch, defaultDeps, type ConsumeDeps } from "../src/poll/consume.js";
import type { TrackJob } from "../src/poll/types.js";
import { fakeQueue } from "./poll-helpers.js";

// Synthetic USPS IMpb number (also used in packages/carriers/test/detect.test.ts).
const USPS_NUMBER = "9400111206206406260787";
const APNS_TOKEN = "ab".repeat(32);

const queue = fakeQueue();
let testEnv: Env;

let mail = "";
setResendFetch(async (_input, init) => {
  mail = (JSON.parse(String(init?.body)) as { text: string }).text;
  return Response.json({ id: "email_1" });
});

async function makePem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/** Every outbound fetch lands here: APNs is answered, anything else fails the test. */
const pushes: { url: string; body: Record<string, unknown> }[] = [];
const otherCalls: string[] = [];
beforeEach(async () => {
  pushes.length = 0;
  otherCalls.length = 0;
  testEnv = {
    ...env,
    RESEND_API_KEY: "re_test",
    TRACK_QUEUE: queue,
    APNS_KEY_ID: "TESTKEY123",
    APNS_PRIVATE_KEY: await makePem(),
  } as Env;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).host.endsWith("push.apple.com")) {
      pushes.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(null, { status: 200 });
    }
    otherCalls.push(url);
    return new Response("unexpected live call", { status: 599 });
  });
});
afterEach(() => vi.restoreAllMocks());

async function call(method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": "10.9.9.10" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request(`https://porchlight.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req as Request<unknown, IncomingRequestCfProperties>, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = async (res: Response): Promise<any> => ((await res.json()) as { data: unknown }).data;

function batchOf(jobs: readonly TrackJob[]) {
  const acked: string[] = [];
  const retried: string[] = [];
  const messages = jobs.map((body, i) => ({
    id: `m${i}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: () => void acked.push(body.packageId),
    retry: () => void retried.push(body.packageId),
  }));
  const batch = { queue: "porchlight-track", messages, ackAll() {}, retryAll() {} } as unknown as MessageBatch<TrackJob>;
  return { batch, acked, retried };
}

async function signIn(): Promise<string> {
  const email = `e2e-device-${crypto.randomUUID()}@example.com`;
  expect((await call("POST", "/v1/auth/email/start", null, { email, client: "ios" })).status).toBe(202);
  const code = /code: (\d{6})/.exec(mail)?.[1];
  expect(code).toBeDefined();
  const res = await call("POST", "/v1/auth/email/verify", null, { email, code, client: "ios" });
  expect(res.status).toBe(200);
  return (await data(res)).token as string;
}

describe("end to end: device read", () => {
  it("hands a USPS package to the device and applies what it observed", async () => {
    // 1. Session and a registered iPhone with an APNs token.
    const token = await signIn();
    const deviceId = crypto.randomUUID();
    const dev = await call("PUT", `/v1/devices/${deviceId}`, token, {
      platform: "ios",
      apnsToken: APNS_TOKEN,
      appVersion: "1.0 (1)",
      environment: "production",
    });
    expect(dev.status).toBe(200);

    // 2. A USPS package (detected from the number).
    const id = crypto.randomUUID();
    const put = await call("PUT", `/v1/packages/${id}`, token, { trackingNumber: USPS_NUMBER, title: "Boots" });
    expect(put.status).toBe(201);
    expect(await data(put)).toMatchObject({ id, carrier: "usps", status: "unknown" });

    // Nothing is due before the poller has run.
    expect((await data(await call("GET", "/v1/device-tracking/due", token))).jobs).toEqual([]);

    // 3. Cron queues it; the consumer (real adapters, no network) hands it to the device.
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now() + 1000, cron: "*/5 * * * *" }), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    const jobs = queue.sent.filter((j) => j.packageId === id);
    expect(jobs).toEqual([expect.objectContaining({ packageId: id, reason: "scheduled" })]);

    const deps: ConsumeDeps = {
      ...defaultDeps,
      takeToken: async () => ({ allowed: true, retryAfterSec: 0 }),
      reserveAggregator: async () => {
        throw new Error("the aggregator must not be used for a device carrier");
      },
    };
    const { batch, acked, retried } = batchOf(jobs);
    await consumeBatch(batch, testEnv, deps);
    expect(acked).toEqual([id]);
    expect(retried).toEqual([]);
    expect(otherCalls).toEqual([]);

    const row = await testEnv.DB.prepare("SELECT device_needed_at, device_reason, status FROM packages WHERE id = ?")
      .bind(id)
      .first<{ device_needed_at: number | null; device_reason: string | null; status: string }>();
    expect(row?.device_needed_at).not.toBeNull();
    expect(row?.device_reason).toBe("new");
    expect(row?.status).toBe("unknown");

    // 4. The device asks what is due.
    const due = await data(await call("GET", "/v1/device-tracking/due", token));
    expect(due.jobs).toEqual([{ packageId: id, carrier: "usps", trackingNumber: USPS_NUMBER, reason: "new" }]);

    const before = await data(await call("GET", "/v1/sync", token));

    // 5. It posts what the USPS page showed.
    const observedAt = new Date(Date.now() - 1000).toISOString();
    const posted = await call("POST", `/v1/packages/${id}/observed`, token, {
      observedAt,
      source: "device",
      outcome: "ok",
      status: "out_for_delivery",
      statusDetail: "Out for Delivery",
      etaStart: null,
      etaEnd: null,
      etaDateOnly: true,
      deliveredAt: null,
      events: [
        { occurredAt: "2026-11-08T13:05:00.000Z", status: "out_for_delivery", description: "Out for Delivery", location: "San Jose, CA 95112" },
        { occurredAt: "2026-11-07T20:00:00.000Z", status: "in_transit", description: "Arrived at USPS Regional Facility", location: null },
      ],
    });
    expect(posted.status).toBe(200);
    expect(await data(posted)).toEqual({ applied: true, deviceNeededAt: null });

    // No longer due.
    expect((await data(await call("GET", "/v1/device-tracking/due", token))).jobs).toEqual([]);

    // 6. Delta sync shows the new status, source and events.
    const delta = await data(await call("GET", `/v1/sync?since=${encodeURIComponent(before.cursor)}`, token));
    expect(delta.packages).toEqual([
      expect.objectContaining({ id, carrier: "usps", status: "out_for_delivery", statusDetail: "Out for Delivery", dataSource: "device" }),
    ]);
    expect(delta.events).toHaveLength(2);
    expect(delta.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageId: id, status: "out_for_delivery", description: "Out for Delivery", location: "San Jose, CA 95112" }),
      ]),
    );

    // 7. One visible push to the registered device.
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.url).toBe(`https://api.push.apple.com/3/device/${APNS_TOKEN}`);
    expect(pushes[0]?.body).toMatchObject({ packageId: id, aps: { alert: { title: "Boots" } } });
    expect(otherCalls).toEqual([]);
  });
});
