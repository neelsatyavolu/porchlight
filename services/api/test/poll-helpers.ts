// Test-only seeding helpers for poll, import and push tests.
import type { Env } from "../src/env.js";
import type { TrackJob } from "../src/poll/types.js";

export async function seedUser(env: Env): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind(id, `${id}@example.test`, Date.now())
    .run();
  return id;
}

export interface SeedPackage {
  userId: string;
  carrier?: string;
  trackingNumber?: string;
  status?: string;
  title?: string | null;
  merchant?: string | null;
  source?: string;
  nextCheckAt?: number | null;
  lastCheckedAt?: number | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
  updatedAt?: number;
}

export async function seedPackage(env: Env, p: SeedPackage): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO packages (id, user_id, carrier, tracking_number, title, merchant, source, status,
       next_check_at, last_checked_at, archived_at, deleted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      p.userId,
      p.carrier ?? "ups",
      p.trackingNumber ?? `1Z${crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`,
      p.title ?? null,
      p.merchant ?? null,
      p.source ?? "manual",
      p.status ?? "unknown",
      p.nextCheckAt ?? null,
      p.lastCheckedAt ?? null,
      p.archivedAt ?? null,
      p.deletedAt ?? null,
      p.updatedAt ?? Date.now(),
    )
    .run();
  return id;
}

export async function seedDevice(env: Env, userId: string, apnsToken: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO devices (id, user_id, platform, apns_token) VALUES (?, ?, 'ios', ?)")
    .bind(id, userId, apnsToken)
    .run();
  return id;
}

export interface PackageRowLite {
  id: string;
  carrier: string;
  tracking_number: string;
  title: string | null;
  merchant: string | null;
  order_id: string | null;
  source: string;
  status: string;
  status_detail: string | null;
  eta_start: number | null;
  eta_end: number | null;
  delivered_at: number | null;
  last_checked_at: number | null;
  next_check_at: number | null;
  updated_at: number;
}

export async function getPackage(env: Env, id: string): Promise<PackageRowLite> {
  const row = await env.DB.prepare("SELECT * FROM packages WHERE id = ?").bind(id).first<PackageRowLite>();
  if (!row) throw new Error(`no package ${id}`);
  return row;
}

export async function countEvents(env: Env, packageId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE package_id = ?")
    .bind(packageId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** A TRACK_QUEUE stand-in that records what was sent. */
export function fakeQueue(): Queue<TrackJob> & { sent: TrackJob[] } {
  const sent: TrackJob[] = [];
  return {
    sent,
    async send(body: TrackJob) {
      sent.push(body);
    },
    async sendBatch(messages: Iterable<MessageSendRequest<TrackJob>>) {
      for (const m of messages) sent.push(m.body);
    },
    async metrics() {
      return { backlogCount: 0, backlogBytes: 0 };
    },
  } as unknown as Queue<TrackJob> & { sent: TrackJob[] };
}
