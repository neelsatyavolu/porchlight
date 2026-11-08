// Where to go after signing in. `next` comes from the query string, so it is
// untrusted: only same-site app paths are accepted (no open redirect).

export const DEFAULT_NEXT = "/app";
const STORAGE_KEY = "porchlight.signin.next";

/** Returns `raw` if it is a path inside the app, else /app. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_NEXT;
  // Must be a rooted path, not protocol-relative (//host) or a backslash trick (/\host).
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return DEFAULT_NEXT;
  if (raw !== "/app" && !raw.startsWith("/app/") && !raw.startsWith("/app?")) return DEFAULT_NEXT;
  return raw;
}

/**
 * The magic link opens in a new tab with no `next`, so SignIn stores it before
 * sending the email and Verify takes it back. Storage can be unavailable
 * (private mode, blocked site data); then the user lands on /app.
 */
export function rememberNext(next: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not fatal: Verify falls back to /app.
  }
}

export function takeNext(): string {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
    return safeNext(value);
  } catch {
    return DEFAULT_NEXT;
  }
}
