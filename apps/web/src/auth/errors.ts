// Turns API errors from the sign-in calls into one line of UI copy (DESIGN.md §7 "Voice").
import { isApiError } from "../api/client";

export function waitPhrase(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return "in a few minutes";
  if (seconds < 60) return `in ${Math.ceil(seconds)} s`;
  return `in ${Math.ceil(seconds / 60)} min`;
}

/** `context` picks the 401 wording: a code that didn't match, or a link that was spent. */
export function signInErrorMessage(err: unknown, context: "email" | "code" | "apple"): string {
  if (isApiError(err, "rate_limited")) return `Too many tries. Try again ${waitPhrase(err.retryAfter)}.`;
  if (isApiError(err, "unauthorized")) {
    if (context === "code") return "That code is wrong or has expired.";
    if (context === "apple") return "Apple couldn't confirm this sign-in. Try again.";
  }
  if (isApiError(err, "unavailable")) {
    return context === "apple"
      ? "Sign in with Apple isn't set up on this server."
      : "Email sign-in isn't set up on this server yet.";
  }
  if (isApiError(err, "bad_request")) {
    return context === "email" ? "Check the email address and try again." : err.message;
  }
  if (isApiError(err, "network")) return "Couldn't reach Porchlight. Check your connection and try again.";
  return err instanceof Error ? err.message : "Something went wrong. Try again.";
}
