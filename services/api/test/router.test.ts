import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { Router } from "../src/lib/router.js";

describe("Router", () => {
  it("answers 400, not a thrown URIError, for a malformed percent-escape in a param", async () => {
    const router = new Router().on("GET", "/v1/things/:id", ({ params }) => new Response(params.id));
    const res = await router.handle(new Request("https://porchlight.test/v1/things/%E0%A4%A"), {} as Env, {} as ExecutionContext);
    expect(res?.status).toBe(400);
  });
});
