// Theme choice (DESIGN.md §2): "system" removes <html data-theme> so tokens.css
// follows prefers-color-scheme; "dark" / "light" pin it. The choice is a
// per-browser convenience, kept in localStorage.

export type ThemeChoice = "system" | "dark" | "light";

export const THEME_KEY = "porchlight.theme";
export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "dark", "light"];

function isChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);
}

export function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isChoice(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice, root: HTMLElement = document.documentElement): void {
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function saveTheme(choice: ThemeChoice): void {
  applyTheme(choice);
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Still applied for this visit.
  }
}
