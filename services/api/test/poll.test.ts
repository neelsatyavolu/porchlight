import { env } from "cloudflare:test";
import { CarrierError, type CarrierAdapter, type TrackResult } from "@porchlight/carriers";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { consumeBatch, processJob, type ConsumeDeps } from "../src/poll/consume.js";
import { GIVE_UP_MS, nextCheckAt } from "../src/poll/interval.js";
import { enqueueDue } from "../src/poll/schedule.js";
import type { TrackJob } from "../src/poll/types.js";
import { countEvents, fakeQueue, getPackage, seedPackage, seedUser } from "./poll-helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-11-08T18:00:00.000Z");

function result(over: Partial<TrackResult> = {}): TrackResult {
  return {
    status: "in_transit",
    statusDetail: "Departed facility",
    etaStart: "2026-11-10T00:00:00.000Z",
    etaEnd: null,
    etaDateOnly: false,
    deliveredAt: null,
    events: [
      { occurredAt: "2026-11-08T09:12:00.000Z", status: "in_transit", description: "Departed", location: "Oakland, CA" },
      { occurredAt: "2026-11-07T20:00:00.000Z", status: "label_created", description: "Label created", location: null },
    ],
    ...over,
  };
}

function adapter(id: string, track: CarrierAdapter["track"]): CarrierAdapter {
  return { id, supports: () => true, track };
}

function deps(over: Partial<ConsumeDeps> = {}): ConsumeDeps & { notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn(async () => 0);
  return {
    adaptersFor: () => [adapter("ups", async () => result())],
    takeToken: async () => ({ allowed: true, retryAfterSec: 0 }),
    fetch: (async () => new Response("unexpected live call", { status: 599 })) as typeof fetch,
    now: () => NOW,
    notify,
    ...over,
  } as ConsumeDeps & { notify: ReturnType<typeof vi.fn> };
}

function job(packageId: string, userId: string, reason: TrackJob["reason"] = "scheduled"): TrackJob {
  return { packageId, userId, reason, enqueuedAt: NOW };
}

describe("nextCheckAt", () => {
  it("uses the per-status interval", () => {
    expect(nextCheckAt("out_for_delivery", NOW, NOW)).toBe(NOW + 15 * MIN);
    expect(nextCheckAt("in_transit", NOW, NOW)).toBe(NOW + 90 * MIN);
    expect(nextCheckAt("label_created", NOW, NOW)).toBe(NOW + 6 * HOUR);
    expect(nextCheckAt("exception", NOW, NOW)).toBe(NOW + 2 * HOUR);
    expect(nextCheckAt("delivered", NOW, NOW)).toBeNull();
  });

  it("backs off unknown packages as they go quiet", () => {
    expect(nextCheckAt("unknown", NOW, NOW - HOUR)).toBe(NOW + 6 * HOUR);
    expect(nextCheckAt("unknown", NOW, NOW - 2 * 24 * HOUR)).toBe(NOW + 12 * HOUR);
    expect(nextCheckAt("unknown", NOW, NOW - 8 * 24 * HOUR)).toBe(NOW + 24 * HOUR);
  });

  it("gives up after 30 days with no movement", () => {
    expect(nextCheckAt("in_transit", NOW, NOW - GIVE_UP_MS - 1)).toBeNull();
    expect(nextCheckAt("in_transit", NOW, NOW - GIVE_UP_MS + HOUR)).toBe(NOW + 90 * MIN);
  });
});

describe("enqueueDue", () => {
  it("queues only due, live, undelivered, unarchived packages and leases them", async () => {
    const userId = await seedUser(env);
    const due = await seedPackage(env, { userId, status: "in_transit", nextCheckAt: NOW - MIN });
    const future = await seedPackage(env, { userId, nextCheckAt: NOW + HOUR });
    const never = await seedPackage(env, { userId, nextCheckAt: null });
    const delivered = await seedPackage(env, { userId, status: "delivered", nextCheckAt: NOW - MIN });
    const archived = await seedPackage(env, { userId, nextCheckAt: NOW - MIN, archivedAt: NOW - HOUR });
    const deleted = await seedPackage(env, { userId, nextCheckAt: NOW - MIN, deletedAt: NOW - HOUR });
    const queue = fakeQueue();

    const n = await enqueueDue({ ...env, TRACK_QUEUE: queue } as Env, NOW, 500);

    const ids = queue.sent.map((j) => j.packageId);
    expect(ids).toContain(due);
    for (const id of [future, never, delivered, archived, deleted]) expect(ids).not.toContain(id);
    expect(n).toBe(queue.sent.length);
    expect(queue.sent.find((j) => j.packageId === due)).toEqual({ packageId: due, userId, reason: "scheduled", enqueuedAt: NOW });
    // Leased so the next cron run does not queue it again before the consumer runs.
    expect((await getPackage(env, due)).next_check_at).toBeGreaterThan(NOW);
  });

  it("respects the batch limit, oldest first", async () => {
    const userId = await seedUser(env);
    const later = NOW - 1_000;
    const a = await seedPackage(env, { userId, nextCheckAt: NOW - 100 * 24 * HOUR });
    const b = await seedPackage(env, { userId, nextCheckAt: NOW - 99 * 24 * HOUR });
    await seedPackage(env, { userId, nextCheckAt: later });
    const queue = fakeQueue();
    await enqueueDue({ ...env, TRACK_QUEUE: queue } as Env, NOW, 2);
    expect(queue.sent.map((j) => j.packageId)).toEqual([a, b]);
  });
});

describe("processJob", () => {
  it("stores events, updates status and ETA, schedules by status, and sends a silent push", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, status: "label_created", title: "Headphones", updatedAt: NOW - HOUR });
    const d = deps();

    expect(await processJob(job(id, userId), env, d)).toEqual({ kind: "done" });

    const row = await getPackage(env, id);
    expect(row.status).toBe("in_transit");
    expect(row.status_detail).toBe("Departed facility");
    expect(row.eta_start).toBe(Date.parse("2026-11-10T00:00:00.000Z"));
    expect(row.last_checked_at).toBe(NOW);
    expect(row.updated_at).toBe(NOW);
    expect(row.next_check_at).toBe(NOW + 90 * MIN);
    expect(await countEvents(env, id)).toBe(2);
    expect(d.notify).toHaveBeenCalledWith(env, {
      userId,
      packageId: id,
      title: "Headphones",
      status: "in_transit",
      statusDetail: "Departed facility",
      statusChanged: true,
    });
  });

  it("dedupes events by raw_hash and leaves updated_at alone when nothing changed", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId });
    await processJob(job(id, userId), env, deps());
    const firstUpdatedAt = (await getPackage(env, id)).updated_at;
    const later = deps({ now: () => NOW + HOUR });
    await processJob(job(id, userId), env, later);

    const row = await getPackage(env, id);
    expect(await countEvents(env, id)).toBe(2);
    expect(row.updated_at).toBe(firstUpdatedAt);
    expect(row.last_checked_at).toBe(NOW + HOUR);
    expect(later.notify).not.toHaveBeenCalled();
  });

  it("moves updated_at past the user's newest updated_at so the sync cursor never skips it", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, updatedAt: NOW - HOUR });
    // Another package of the user was written with a later clock.
    await seedPackage(env, { userId, updatedAt: NOW + HOUR });
    await processJob(job(id, userId), env, deps());
    expect((await getPackage(env, id)).updated_at).toBe(NOW + HOUR + 1);
  });

  it("keeps the stored ETA when the carrier gives none", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId });
    await processJob(job(id, userId), env, deps());
    await processJob(job(id, userId), env, deps({ adaptersFor: () => [adapter("ups", async () => result({ etaStart: null }))] }));
    expect((await getPackage(env, id)).eta_start).toBe(Date.parse("2026-11-10T00:00:00.000Z"));
  });

  it("stops polling once delivered and records deliveredAt", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, status: "out_for_delivery" });
    const d = deps({
      adaptersFor: () => [
        adapter("ups", async () =>
          result({
            status: "delivered",
            statusDetail: "Delivered, front door",
            deliveredAt: "2026-11-08T17:30:00.000Z",
            events: [{ occurredAt: "2026-11-08T17:30:00.000Z", status: "delivered", description: "Delivered", location: null }],
          }),
        ),
      ],
    });
    await processJob(job(id, userId), env, d);
    const row = await getPackage(env, id);
    expect(row.status).toBe("delivered");
    expect(row.delivered_at).toBe(Date.parse("2026-11-08T17:30:00.000Z"));
    expect(row.next_check_at).toBeNull();
    expect(d.notify).toHaveBeenCalledWith(env, expect.objectContaining({ status: "delivered", statusChanged: true }));
  });

  it("skips deleted packages and, for scheduled jobs, archived or delivered ones", async () => {
    const userId = await seedUser(env);
    const track = vi.fn(async () => result());
    const d = deps({ adaptersFor: () => [adapter("ups", track)] });
    const deleted = await seedPackage(env, { userId, deletedAt: NOW });
    const archived = await seedPackage(env, { userId, archivedAt: NOW });
    const delivered = await seedPackage(env, { userId, status: "delivered" });
    for (const id of [deleted, archived, delivered]) {
      expect(await processJob(job(id, userId), env, d)).toEqual({ kind: "done" });
    }
    expect(await processJob(job(deleted, userId, "manual"), env, d)).toEqual({ kind: "done" });
    expect(track).not.toHaveBeenCalled();
    // A job naming the wrong user is ignored.
    const other = await seedUser(env);
    const mine = await seedPackage(env, { userId });
    await processJob(job(mine, other), env, d);
    expect(track).not.toHaveBeenCalled();
  });

  it("falls back to the next adapter on a non-retryable error", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId });
    const second = vi.fn(async () => result());
    const d = deps({
      adaptersFor: () => [
        adapter("ups", async () => {
          throw new CarrierError("auth", "ups", "bad key");
        }),
        adapter("aggregator", second),
      ],
    });
    expect(await processJob(job(id, userId), env, d)).toEqual({ kind: "done" });
    expect(second).toHaveBeenCalledOnce();
    expect((await getPackage(env, id)).status).toBe("in_transit");
  });

  it("passes an injected fetch, env and clock to the adapter", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, trackingNumber: "1ZCTXTEST0000000001" });
    const track = vi.fn<CarrierAdapter["track"]>(async () => result());
    const d = deps({ adaptersFor: () => [adapter("ups", track)] });
    await processJob(job(id, userId), env, d);
    const [number, carrier, ctx] = track.mock.calls[0]!;
    expect(number).toBe("1ZCTXTEST0000000001");
    expect(carrier).toBe("ups");
    expect(ctx.fetch).toBe(d.fetch);
    expect(ctx.now().getTime()).toBe(NOW);
  });

  it("asks for a retry on transient errors, using retryAfterSec when given", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId });
    const d = deps({
      adaptersFor: () => [
        adapter("ups", async () => {
          throw new CarrierError("rate_limited", "ups", "slow down", { retryAfterSec: 42 });
        }),
      ],
    });
    expect(await processJob(job(id, userId), env, d)).toEqual({ kind: "retry", delaySec: 42 });
    const t = deps({
      adaptersFor: () => [
        adapter("ups", async () => {
          throw new Error("socket hang up");
        }),
      ],
    });
    expect(await processJob(job(id, userId), env, t)).toEqual({ kind: "retry", delaySec: 60 });
  });

  it("reschedules without calling the carrier when the KV bucket is empty", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId });
    const track = vi.fn(async () => result());
    const takeToken = vi.fn(async () => ({ allowed: false, retryAfterSec: 300 }));
    const d = deps({ adaptersFor: () => [adapter("ups", track)], takeToken });
    expect(await processJob(job(id, userId), env, d)).toEqual({ kind: "done" });
    expect(track).not.toHaveBeenCalled();
    expect(takeToken).toHaveBeenCalledWith(env, "carrier:ups", expect.any(Object), NOW);
    expect((await getPackage(env, id)).next_check_at).toBe(NOW + 300_000);
  });

  it("backs off when no adapter supports the carrier or the number is not found", async () => {
    const userId = await seedUser(env);
    const none = await seedPackage(env, { userId, carrier: "amazon", updatedAt: NOW });
    await processJob(job(none, userId), env, deps({ adaptersFor: () => [] }));
    expect((await getPackage(env, none)).next_check_at).toBe(NOW + 24 * HOUR);
    expect((await getPackage(env, none)).last_checked_at).toBeNull();

    const missing = await seedPackage(env, { userId, updatedAt: NOW - HOUR });
    const nf = deps({
      adaptersFor: () => [
        adapter("ups", async () => {
          throw new CarrierError("not_found", "ups", "no such number");
        }),
      ],
    });
    await processJob(job(missing, userId), env, nf);
    const row = await getPackage(env, missing);
    expect(row.status).toBe("unknown");
    expect(row.last_checked_at).toBe(NOW);
    expect(row.next_check_at).toBe(NOW + 6 * HOUR);
  });

  it("gives up after 30 days without movement", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, status: "in_transit", updatedAt: NOW - 40 * 24 * HOUR });
    const stale = result({
      events: [{ occurredAt: new Date(NOW - 35 * 24 * HOUR).toISOString(), status: "in_transit", description: "Departed", location: null }],
    });
    await processJob(job(id, userId), env, deps({ adaptersFor: () => [adapter("ups", async () => stale)] }));
    expect((await getPackage(env, id)).next_check_at).toBeNull();
  });
});

describe("consumeBatch", () => {
  function message(body: TrackJob, attempts = 1) {
    return { id: crypto.randomUUID(), timestamp: new Date(NOW), body, attempts, ack: vi.fn(), retry: vi.fn() };
  }

  it("acks finished jobs and retries transient ones with backoff", async () => {
    const userId = await seedUser(env);
    const ok = await seedPackage(env, { userId });
    const flaky = await seedPackage(env, { userId, carrier: "fedex" });
    const d = deps({
      adaptersFor: (carrier) => [
        adapter(carrier, async () => {
          if (carrier === "fedex") throw new CarrierError("transient", "fedex", "502");
          return result();
        }),
      ],
    });
    const m1 = message(job(ok, userId));
    const m2 = message(job(flaky, userId), 2);
    await consumeBatch({ queue: "porchlight-track", messages: [m1, m2] } as unknown as MessageBatch<TrackJob>, env, d);
    expect(m1.ack).toHaveBeenCalled();
    expect(m2.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
  });

  it("stops retrying after the last attempt and reschedules instead", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, status: "in_transit" });
    const d = deps({
      adaptersFor: () => [
        adapter("ups", async () => {
          throw new CarrierError("transient", "ups", "502");
        }),
      ],
    });
    const m = message(job(id, userId), 3);
    await consumeBatch({ queue: "porchlight-track", messages: [m] } as unknown as MessageBatch<TrackJob>, env, d);
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
    expect((await getPackage(env, id)).next_check_at).toBe(NOW + 90 * MIN);
  });
});

describe("processJob review fixes", () => {
  it("stops retrying a package whose adapters keep failing (auth) once it has been quiet for 30 days", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId, updatedAt: NOW - 40 * 24 * HOUR });
    const broken = deps({
      adaptersFor: () => [
        adapter("ups", async () => {
          throw new CarrierError("auth", "ups", "bad key");
        }),
      ],
    });
    await processJob(job(id, userId), env, broken);
    expect((await getPackage(env, id)).next_check_at).toBeNull();
  });

  it("drops a stored ETA once delivered and keeps a known deliveredAt when the carrier omits it", async () => {
    const userId = await seedUser(env);
    const id = await seedPackage(env, { userId });
    await processJob(job(id, userId), env, deps());
    expect((await getPackage(env, id)).eta_start).not.toBeNull();
    const delivered = result({ status: "delivered", etaStart: null, etaEnd: null, deliveredAt: "2026-11-08T17:00:00.000Z" });
    await processJob(job(id, userId, "manual"), env, deps({ adaptersFor: () => [adapter("ups", async () => delivered)] }));
    const row = await getPackage(env, id);
    expect(row.eta_start).toBeNull();
    expect(row.eta_end).toBeNull();
    expect(row.delivered_at).toBe(Date.parse("2026-11-08T17:00:00.000Z"));
    await processJob(job(id, userId, "manual"), env, deps({ adaptersFor: () => [adapter("ups", async () => ({ ...delivered, deliveredAt: null }))] }));
    expect((await getPackage(env, id)).delivered_at).toBe(Date.parse("2026-11-08T17:00:00.000Z"));
  });
});
