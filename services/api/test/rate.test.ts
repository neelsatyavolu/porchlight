import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { takeToken } from "../src/lib/rate.js";

// takeToken backs the per-carrier poll bucket and the per-user import bucket.
describe("takeToken", () => {
  const spec = { capacity: 2, refillPerSec: 0.5 };
  const T = Date.parse("2026-11-08T18:00:00.000Z");

  it("allows up to capacity, then refuses with a wait, then refills", async () => {
    const key = `test:${crypto.randomUUID()}`;
    expect(await takeToken(env, key, spec, T)).toEqual({ allowed: true, retryAfterSec: 0 });
    expect(await takeToken(env, key, spec, T)).toEqual({ allowed: true, retryAfterSec: 0 });
    expect(await takeToken(env, key, spec, T)).toEqual({ allowed: false, retryAfterSec: 2 });
    expect((await takeToken(env, key, spec, T + 2000)).allowed).toBe(true);
  });

  it("keeps buckets separate per key", async () => {
    const a = `test:${crypto.randomUUID()}`;
    const b = `test:${crypto.randomUUID()}`;
    await takeToken(env, a, spec, T);
    await takeToken(env, a, spec, T);
    expect((await takeToken(env, a, spec, T)).allowed).toBe(false);
    expect((await takeToken(env, b, spec, T)).allowed).toBe(true);
  });
});
