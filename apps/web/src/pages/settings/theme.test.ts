import { afterEach, describe, expect, it } from "vitest";
import { readTheme, saveTheme, THEME_KEY } from "./theme";

describe("theme", () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("defaults to system with no data-theme", () => {
    expect(readTheme()).toBe("system");
  });

  it("pins dark or light on <html> and remembers it", () => {
    saveTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(readTheme()).toBe("light");
    saveTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("system clears the attribute and the stored value", () => {
    saveTheme("light");
    saveTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("ignores a junk stored value", () => {
    localStorage.setItem(THEME_KEY, "sepia");
    expect(readTheme()).toBe("system");
  });
});
