import { afterEach, describe, expect, it } from "vitest";
import { sendMagicLink, setResendFetch } from "../src/lib/resend.js";

const base = { apiKey: "k", to: "a@b.co", appOrigin: "https://porchlight.xanom.co", link: "https://porchlight.xanom.co/auth/verify?token=t", code: "123456" };

async function sentFrom(extra: { from?: string }): Promise<string> {
  let body: { from?: string } = {};
  setResendFetch(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response("{}", { status: 200 });
  });
  await sendMagicLink({ ...base, ...extra });
  return body.from ?? "";
}

afterEach(() => setResendFetch((input, init) => fetch(input, init)));

describe("sendMagicLink sender", () => {
  it("uses the configured sender when one is set", async () => {
    expect(await sentFrom({ from: "Porchlight <signin@n3el.dev>" })).toBe("Porchlight <signin@n3el.dev>");
  });

  it("falls back to signin@ the app host", async () => {
    expect(await sentFrom({})).toBe("Porchlight <signin@porchlight.xanom.co>");
  });
});
