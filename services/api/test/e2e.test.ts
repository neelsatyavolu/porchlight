// End-to-end through the real Worker entry: sign in → PUT package → cron
// enqueues → queue consumer (mocked adapter) updates status → sync shows it.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import type { CarrierAdapter, TrackResult } from "@porchlight/carriers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { setResendFetch } from "../src/lib/resend.js";
import { consumeBatch, defaultDeps, type ConsumeDeps } from "../src/poll/consume.js";
import type { TrackJob } from "../src/poll/types.js";
import { fakeQueue } from "./poll-helpers.js";

const queue = fakeQueue();
const testEnv = { ...env, RESEND_API_KEY: "re_test", TRACK_QUEUE: queue } as Env;

let mail = "";
setResendFetch(async (_input, init) => {
  mail = (JSON.parse(String(init?.body)) as { text: string }).text;
  return Response.json({ id: "email_1" });
});

async function call(method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": "10.9.9.9" };
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

const OUT_FOR_DELIVERY: TrackResult = {
  status: "out_for_delivery",
  statusDetail: "Out for delivery",
  etaStart: null,
  etaEnd: null,
  etaDateOnly: false,
  deliveredAt: null,
  events: [{ occurredAt: "2026-11-08T08:00:00.000Z", status: "out_for_delivery", description: "Out for delivery", location: "Oakland, CA" }],
};

describe("end to end", () => {
  it("tracks a new package from PUT to sync", async () => {
    // 1. Session through email sign-in (Resend faked).
    const email = `e2e-${crypto.randomUUID()}@example.com`;
    expect((await call("POST", "/v1/auth/email/start", null, { email, client: "ios" })).status).toBe(202);
    const code = /code: (\d{6})/.exec(mail)?.[1];
    expect(code).toBeDefined();
    const signIn = await call("POST", "/v1/auth/email/verify", null, { email, code, client: "ios" });
    expect(signIn.status).toBe(200);
    const { token } = await data(signIn);

    // 2. Create a package, then take a full-sync cursor.
    const id = crypto.randomUUID();
    const put = await call("PUT", `/v1/packages/${id}`, token, { trackingNumber: "1Z999AA10123456784", title: "Headphones" });
    expect(put.status).toBe(201);
    expect(await data(put)).toMatchObject({ id, carrier: "ups", status: "unknown" });
    const full = await data(await call("GET", "/v1/sync", token));
    expect(full.packages.map((p: { id: string }) => p.id)).toEqual([id]);

    // 3. The cron run queues it.
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now() + 1000, cron: "*/5 * * * *" }), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    const jobs = queue.sent.filter((j) => j.packageId === id);
    expect(jobs).toEqual([expect.objectContaining({ packageId: id, reason: "scheduled" })]);

    // 4. The consumer tracks it through a mocked adapter.
    const tracked: string[] = [];
    const ups: CarrierAdapter = {
      id: "ups",
      supports: (c) => c === "ups",
      track: async (number) => {
        tracked.push(number);
        return OUT_FOR_DELIVERY;
      },
    };
    const deps: ConsumeDeps = {
      ...defaultDeps,
      adaptersFor: () => [ups],
      takeToken: async () => ({ allowed: true, retryAfterSec: 0 }),
      fetch: (async () => new Response("unexpected live call", { status: 599 })) as typeof fetch,
      notify: async () => 0,
    };
    const { batch, acked, retried } = batchOf(jobs);
    await consumeBatch(batch, testEnv, deps);
    expect(tracked).toEqual(["1Z999AA10123456784"]);
    expect(acked).toEqual([id]);
    expect(retried).toEqual([]);

    // 5. A delta sync from the earlier cursor returns the new status and event.
    const delta = await data(await call("GET", `/v1/sync?since=${encodeURIComponent(full.cursor)}`, token));
    expect(delta.packages).toEqual([expect.objectContaining({ id, status: "out_for_delivery", statusDetail: "Out for delivery" })]);
    expect(delta.events).toEqual([
      expect.objectContaining({ packageId: id, status: "out_for_delivery", description: "Out for delivery", location: "Oakland, CA" }),
    ]);
    expect(delta.deleted).toEqual([]);
  });
});
