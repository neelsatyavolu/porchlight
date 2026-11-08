import { afterEach, describe, expect, it } from "vitest";
import { rememberNext, safeNext, takeNext } from "./next";

describe("safeNext", () => {
  it.each([
    ["/app/settings", "/app/settings"],
    ["/app", "/app"],
    ["/app?x=1", "/app?x=1"],
    ["/app/p/123", "/app/p/123"],
  ])("keeps app path %s", (raw, want) => expect(safeNext(raw)).toBe(want));

  it.each([null, "", "https://evil.example/app", "//evil.example/app", "/\\evil.example", "/signin", "/application", "app/x"])(
    "falls back to /app for %s",
    (raw) => expect(safeNext(raw)).toBe("/app"),
  );
});

describe("rememberNext / takeNext", () => {
  afterEach(() => localStorage.clear());

  it("hands back the stored path once", () => {
    rememberNext("/app/settings");
    expect(takeNext()).toBe("/app/settings");
    expect(takeNext()).toBe("/app");
  });

  it("refuses a stored path outside the app", () => {
    localStorage.setItem("porchlight.signin.next", "//evil.example");
    expect(takeNext()).toBe("/app");
  });
});
