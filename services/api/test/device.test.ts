// GET /v1/device-tracking/due, POST /v1/packages/:id/observed and the
// device path of POST /v1/packages/:id/refresh (docs/API.md "Device tracking").
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { createSession } from "../src/lib/auth.js";
import { errorResponse, HttpError } from "../src/lib/http.js";
import { Router } from "../src/lib/router.js";
import { register, type DeviceDeps } from "../src/routes/device.js";
import * as packageRoutes from "../src/routes/packages.js";
import { countEvents, fakeQueue, getPackage, seedPackage, seedUser } from "./poll-helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-11-09T15:00:00.000Z");

let now = NOW;
const notify = vi.fn(async () => 0);
const deps: DeviceDeps = { notify, now: () => now };
const router = new Router();
register(router, deps);
packageRoutes.register(router);

let queue: ReturnType<typeof fakeQueue>;
let testEnv: Env;
beforeEach(() => {
  now = NOW;
  notify.mockClear();
  queue = fakeQueue();
  testEnv = { ...env, TRACK_QUEUE: queue } as Env;
});

async function call(method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request(`https://porchlight.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    return (await router.handle(req, testEnv, {} as ExecutionContext)) ?? errorResponse(404, "not_found", "No such endpoint");
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, { ...err.headers }, err.details);
    throw err;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = async (res: Response): Promise<any> => ((await res.json()) as { data: unknown }).data;

async function user(): Promise<{ userId: string; token: string }> {
  const userId = await seedUser(env);
  return { userId, token: await createSession(env, userId, null, Date.now(), "ios") };
}

async function setDevice(id: string, neededAt: number | null, reason: string | null, extra = ""): Promise<void> {
  await env.DB.prepare(`UPDATE packages SET device_needed_at = ?, device_reason = ? ${extra} WHERE id = ?`).bind(neededAt, reason, id).run();
}

async function deviceRow(id: string) {
  return env.DB.prepare(
    "SELECT device_needed_at, device_reason, device_failures, last_source, last_checked_at, next_check_at FROM packages WHERE id = ?",
  )
    .bind(id)
    .first<{
      device_needed_at: number | null;
      device_reason: string | null;
      device_failures: number;
      last_source: string | null;
      last_checked_at: number | null;
      next_check_at: number | null;
    }>();
}

function observation(over: Record<string, unknown> = {}) {
  return {
    observedAt: new Date(NOW - MIN).toISOString(),
    source: "device",
    outcome: "ok",
    status: "out_for_delivery",
    statusDetail: "Out for Delivery",
    etaStart: "2026-11-09",
    etaEnd: "2026-11-09",
    etaDateOnly: true,
    deliveredAt: null,
    events: [
      { occurredAt: "2026-11-09T13:05:00.000Z", status: "out_for_delivery", description: "Out for Delivery", location: "San Jose, CA 95112" },
      { occurredAt: "2026-11-08T20:00:00.000Z", status: "in_transit", description: "Arrived at Hub", location: "" },
    ],
    ...over,
  };
}

const failedBody = (outcome: string) =>
  observation({ outcome, status: "unknown", statusDetail: null, etaStart: null, etaEnd: null, etaDateOnly: false, events: [] });

describe("GET /v1/device-tracking/due", () => {
  it("needs a session", async () => {
    expect((await call("GET", "/v1/device-tracking/due", null)).status).toBe(401);
  });

  it("lists the user's due device packages, oldest first, at most 10", async () => {
    const { userId, token } = await user();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = await seedPackage(env, { userId, carrier: i % 2 ? "usps" : "fedex", trackingNumber: `9400${i}0000000000000000` });
      await setDevice(id, NOW - (20 - i) * MIN, "scheduled");
      ids.push(id);
    }
    const res = await call("GET", "/v1/device-tracking/due", token);
    expect(res.status).toBe(200);
    const { jobs } = await data(res);
    expect(jobs).toHaveLength(10);
    expect(jobs.map((j: { packageId: string }) => j.packageId)).toEqual(ids.slice(0, 10));
    expect(jobs[0]).toEqual({ packageId: ids[0], carrier: "fedex", trackingNumber: "940000000000000000000", reason: "scheduled" });
  });

  it("leaves out future, delivered, deleted, non-device and other users' packages", async () => {
    const { userId, token } = await user();
    const other = await user();
    const due = await seedPackage(env, { userId, carrier: "ups" });
    const later = await seedPackage(env, { userId, carrier: "usps" });
    const delivered = await seedPackage(env, { userId, carrier: "usps", status: "delivered" });
    const deleted = await seedPackage(env, { userId, carrier: "usps", deletedAt: NOW });
    const ontrac = await seedPackage(env, { userId, carrier: "ontrac" });
    const theirs = await seedPackage(env, { userId: other.userId, carrier: "usps" });
    await setDevice(due, NOW, "server_blocked");
    await setDevice(later, NOW + MIN, "scheduled");
    for (const id of [delivered, deleted, ontrac, theirs]) await setDevice(id, NOW - HOUR, "scheduled");
    const { jobs } = await data(await call("GET", "/v1/device-tracking/due", token));
    expect(jobs).toEqual([expect.objectContaining({ packageId: due, carrier: "ups", reason: "server_blocked" })]);
  });
});

describe("POST /v1/packages/:id/observed", () => {
  it("applies an ok read: status, ETA, events, lastCheckedAt, dataSource, and a push", async () => {
    const { userId, token } = await user();
    const id = await seedPackage(env, { userId, carrier: "usps", status: "in_transit", title: "Shoes", updatedAt: NOW - HOUR });
    await setDevice(id, NOW - MIN, "scheduled", ", device_failures = 2");

    const res = await call("POST", `/v1/packages/${id}/observed`, token, observation());
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ applied: true, deviceNeededAt: null });

    const row = await getPackage(env, id);
    expect(row.status).toBe("out_for_delivery");
    expect(row.status_detail).toBe("Out for Delivery");
    expect(row.eta_start).toBe(Date.parse("2026-11-09T00:00:00.000Z"));
    expect(row.last_checked_at).toBe(NOW - MIN);
    // USPS device cadence: 30 min out for delivery.
    expect(row.next_check_at).toBe(NOW + 30 * MIN);
    expect(await countEvents(env, id)).toBe(2);
    const loc = await env.DB.prepare("SELECT location FROM events WHERE package_id = ? AND status = 'in_transit'").bind(id).first();
    expect(loc).toEqual({ location: null });
    expect(await deviceRow(id)).toMatchObject({ device_needed_at: null, device_reason: null, device_failures: 0, last_source: "device" });
    expect(notify).toHaveBeenCalledWith(testEnv, {
      userId, packageId: id, title: "Shoes", status: "out_for_delivery", statusDetail: "Out for Delivery", statusChanged: true,
    });
  });

  it("uses the 20 minute cadence for UPS and FedEx out for delivery", async () => {
    const { userId, token } = await user();
    const id = await seedPackage(env, { userId, carrier: "fedex" });
    await call("POST", `/v1/packages/${id}/observed`, token, observation());
    expect((await getPackage(env, id)).next_check_at).toBe(NOW + 20 * MIN);
  });

  it("is idempotent and never moves backwards to an older read", async () => {
    const { userId, token } = await user();
    const id = await seedPackage(env, { userId, carrier: "ups" });
    await call("POST", `/v1/packages/${id}/observed`, token, observation());
    const first = await getPackage(env, id);
    notify.mockClear();

    const again = await call("POST", `/v1/packages/${id}/observed`, token, observation());
    expect(await data(again)).toEqual({ applied: false, deviceNeededAt: null });
    const older = observation({ observedAt: new Date(NOW - HOUR).toISOString(), status: "in_transit", statusDetail: "Older" });
    expect((await data(await call("POST", `/v1/packages/${id}/observed`, token, older))).applied).toBe(false);

    const row = await getPackage(env, id);
    expect(row.status).toBe("out_for_delivery");
    expect(row.updated_at).toBe(first.updated_at);
    expect(await countEvents(env, id)).toBe(2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("dedupes events across newer reads and pushes only when something changed", async () => {
    const { userId, token } = await user();
    const id = await seedPackage(env, { userId, carrier: "usps" });
    await call("POST", `/v1/packages/${id}/observed`, token, observation());
    notify.mockClear();
    const same = observation({ observedAt: new Date(NOW).toISOString() });
    expect((await data(await call("POST", `/v1/packages/${id}/observed`, token, same))).applied).toBe(true);
    expect(await countEvents(env, id)).toBe(2);
    expect(notify).not.toHaveBeenCalled();

    const delivered = observation({
      observedAt: new Date(NOW + MIN).toISOString(),
      status: "delivered", statusDetail: "Delivered, In/At Mailbox", etaStart: null, etaEnd: null, etaDateOnly: false,
      deliveredAt: "2026-11-09T14:50:00.000Z",
      events: [{ occurredAt: "2026-11-09T14:50:00.000Z", status: "delivered", description: "Delivered, In/At Mailbox", location: "San Jose, CA" }],
    });
    now = NOW + 2 * MIN;
    await call("POST", `/v1/packages/${id}/observed`, token, delivered);
    const row = await getPackage(env, id);
    expect(row.status).toBe("delivered");
    expect(row.delivered_at).toBe(Date.parse("2026-11-09T14:50:00.000Z"));
    expect(row.next_check_at).toBeNull();
    expect(await countEvents(env, id)).toBe(3);
    expect(notify).toHaveBeenCalledWith(testEnv, expect.objectContaining({ status: "delivered", statusChanged: true }));
  });

  it("not_found clears the request and records the check without applying", async () => {
    const { userId, token } = await user();
    const id = await seedPackage(env, { userId, carrier: "usps", updatedAt: NOW });
    await setDevice(id, NOW - MIN, "new");
    const res = await call("POST", `/v1/packages/${id}/observed`, token, failedBody("not_found"));
    expect(await data(res)).toEqual({ applied: false, deviceNeededAt: null });
    const row = await deviceRow(id);
    expect(row).toMatchObject({ device_needed_at: null, device_reason: null, last_checked_at: NOW - MIN, last_source: null });
    expect(row?.next_check_at).toBe(NOW + 6 * HOUR);
    expect((await getPackage(env, id)).status).toBe("unknown");
  });

  it("challenged and failed back off: 60 min, doubling", async () => {
    const { userId, token } = await user();
    const id = await seedPackage(env, { userId, carrier: "fedex", status: "in_transit" });
    await setDevice(id, NOW - MIN, "new");
    const first = await data(await call("POST", `/v1/packages/${id}/observed`, token, failedBody("challenged")));
    expect(first).toEqual({ applied: false, deviceNeededAt: new Date(NOW + HOUR).toISOString() });
    const second = await data(await call("POST", `/v1/packages/${id}/observed`, token, failedBody("failed")));
    expect(second.deviceNeededAt).toBe(new Date(NOW + 2 * HOUR).toISOString());
    expect(await deviceRow(id)).toMatchObject({ device_failures: 2, device_reason: "new" });
    expect((await getPackage(env, id)).status).toBe("in_transit");

    // Not due while backing off; an ok read resets the count.
    expect((await data(await call("GET", "/v1/device-tracking/due", token))).jobs).toEqual([]);
    await call("POST", `/v1/packages/${id}/observed`, token, observation());
    expect(await deviceRow(id)).toMatchObject({ device_failures: 0, device_needed_at: null });
  });

  it("ignores status, ETA and events when the outcome is not ok", async () => {
    const { userId, token } = await user();
    const id = await seedPackage(env, { userId, carrier: "usps", status: "in_transit" });
    const res = await call("POST", `/v1/packages/${id}/observed`, token, observation({ outcome: "failed" }));
    expect((await data(res)).applied).toBe(false);
    expect((await getPackage(env, id)).status).toBe("in_transit");
    expect(await countEvents(env, id)).toBe(0);
  });

  it("answers 404 for unknown, deleted or another user's packages", async () => {
    const alice = await user();
    const bob = await user();
    const id = await seedPackage(env, { userId: alice.userId, carrier: "usps" });
    const gone = await seedPackage(env, { userId: alice.userId, carrier: "usps", deletedAt: NOW });
    expect((await call("POST", `/v1/packages/${id}/observed`, bob.token, observation())).status).toBe(404);
    expect((await call("POST", `/v1/packages/${gone}/observed`, alice.token, observation())).status).toBe(404);
    expect((await call("POST", `/v1/packages/${crypto.randomUUID()}/observed`, alice.token, observation())).status).toBe(404);
    expect((await getPackage(env, id)).status).toBe("unknown");
    expect((await call("POST", `/v1/packages/${id}/observed`, null, observation())).status).toBe(401);
  });

  it.each([
    ["a carrier that isn't read on the device", {}, "ontrac"],
    ["a non-UUID id", {}, "bad-id"],
    ["source other than device", { source: "web" }, "usps"],
    ["an unknown outcome", { outcome: "maybe" }, "usps"],
    ["an unknown status", { status: "lost" }, "usps"],
    ["a date-only ETA that is an instant", { etaStart: "2026-11-09T10:00:00Z" }, "usps"],
    ["an instant ETA that is a date", { etaDateOnly: false }, "usps"],
    ["an observedAt without offset", { observedAt: "2026-11-09T14:00:00" }, "usps"],
    ["an observedAt in the future", { observedAt: new Date(NOW + HOUR).toISOString() }, "usps"],
    ["a missing key", { deliveredAt: undefined }, "usps"],
    ["too many events", { events: Array.from({ length: 201 }, (_, i) => ({ occurredAt: new Date(NOW - i * MIN).toISOString(), status: "in_transit", description: "Moved", location: null })) }, "usps"],
    ["an event with no description", { events: [{ occurredAt: "2026-11-09T13:05:00.000Z", status: "in_transit", description: " ", location: null }] }, "usps"],
  ])("answers 400 for %s", async (_name, over, carrier) => {
    const { userId, token } = await user();
    const id = carrier === "bad-id" ? "bad-id" : await seedPackage(env, { userId, carrier });
    const res = await call("POST", `/v1/packages/${id}/observed`, token, observation(over));
    expect(res.status).toBe(400);
    if (carrier !== "bad-id") expect((await getPackage(env, id)).status).toBe("unknown");
  });

  it("limits each user to 60 reports a minute", async () => {
    const { userId, token } = await user();
    const id = await seedPackage(env, { userId, carrier: "usps" });
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) last = await call("POST", `/v1/packages/${id}/observed`, token, failedBody("failed"));
    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("POST /v1/packages/:id/refresh for device carriers", () => {
  it("asks the device instead of queueing a server check", async () => {
    const { userId, token } = await user();
    const usps = await seedPackage(env, { userId, carrier: "usps" });
    await setDevice(usps, NOW + 3 * HOUR, "scheduled");
    const before = Date.now();
    expect((await call("POST", `/v1/packages/${usps}/refresh`, token)).status).toBe(202);
    const row = await deviceRow(usps);
    expect(row?.device_reason).toBe("manual");
    expect(row?.device_needed_at).toBeGreaterThanOrEqual(before);
    expect(row?.device_needed_at).toBeLessThanOrEqual(Date.now());
    expect(queue.sent).toEqual([]);
  });

  it("queues UPS on the server until its read was blocked", async () => {
    const { userId, token } = await user();
    const fresh = await seedPackage(env, { userId, carrier: "ups" });
    const blocked = await seedPackage(env, { userId, carrier: "ups" });
    await env.DB.prepare("UPDATE packages SET last_source = 'device' WHERE id = ?").bind(blocked).run();
    await call("POST", `/v1/packages/${fresh}/refresh`, token);
    await call("POST", `/v1/packages/${blocked}/refresh`, token);
    expect(queue.sent.map((j) => j.packageId)).toEqual([fresh]);
    expect((await deviceRow(fresh))?.device_needed_at).toBeNull();
    expect((await deviceRow(blocked))?.device_reason).toBe("manual");
  });
});
