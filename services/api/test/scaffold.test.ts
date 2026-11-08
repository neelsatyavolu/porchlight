import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("applies the 0001 migration", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%' AND name != 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "api_tokens",
      "auth_codes",
      "devices",
      "events",
      "imports",
      "package_items",
      "packages",
      "sessions",
      "users",
    ]);
  });

  it("answers unknown /v1 paths with a 404 envelope", async () => {
    const res = await SELF.fetch("https://porchlight.test/v1/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      data: null,
      error: { code: "not_found", message: "No such endpoint" },
    });
  });
});
