import { describe, expect, it, vi } from "vitest";
import { AppleCancelled, appleConfig, sha256Hex, signInWithApple } from "./apple";

const CONFIG = { clientId: "co.xanom.porchlight.web", redirectUri: "https://example.test/signin" };

function fakeSdk(signIn: () => Promise<unknown>) {
  const init = vi.fn();
  const sdk = { auth: { init, signIn } } as never;
  return { init, load: () => Promise.resolve(sdk) };
}

describe("appleConfig", () => {
  it("is null without a client id", () => {
    expect(appleConfig({})).toBeNull();
    expect(appleConfig({ VITE_APPLE_CLIENT_ID: "  " })).toBeNull();
  });

  it("defaults the redirect to this origin's /signin", () => {
    expect(appleConfig({ VITE_APPLE_CLIENT_ID: "svc" })).toEqual({
      clientId: "svc",
      redirectUri: `${window.location.origin}/signin`,
    });
  });

  it("takes an explicit redirect", () => {
    expect(appleConfig({ VITE_APPLE_CLIENT_ID: "svc", VITE_APPLE_REDIRECT_URI: "https://x.test/cb" })?.redirectUri).toBe(
      "https://x.test/cb",
    );
  });
});

describe("signInWithApple", () => {
  it("gives Apple the SHA-256 of the nonce and returns the raw nonce with the token", async () => {
    const { init, load } = fakeSdk(async () => ({ authorization: { id_token: "jwt", code: "c" } }));
    const res = await signInWithApple(CONFIG, load);
    expect(res.identityToken).toBe("jwt");
    expect(res.nonce).toMatch(/^[0-9a-f]{64}$/);
    const passed = init.mock.calls[0]?.[0] as { nonce: string; usePopup: boolean; clientId: string };
    expect(passed.nonce).toBe(await sha256Hex(res.nonce));
    expect(passed.usePopup).toBe(true);
    expect(passed.clientId).toBe(CONFIG.clientId);
  });

  it("reports a closed popup as a cancel", async () => {
    const { load } = fakeSdk(async () => Promise.reject({ error: "popup_closed_by_user" }));
    await expect(signInWithApple(CONFIG, load)).rejects.toBeInstanceOf(AppleCancelled);
  });

  it("fails when Apple sends no identity token", async () => {
    const { load } = fakeSdk(async () => ({ authorization: { code: "c" } }));
    await expect(signInWithApple(CONFIG, load)).rejects.toThrow("identity token");
  });
});

describe("sha256Hex", () => {
  it("matches a known digest", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
