import { isApiError } from "../../api/client";
import { waitPhrase } from "../../auth/errors";

/** One sentence for a failed Settings call. */
export function errorText(err: unknown): string {
  if (isApiError(err, "network")) return "Couldn't reach Porchlight. Check your connection and try again.";
  if (isApiError(err, "rate_limited")) return `Too many tries. Try again ${waitPhrase(err.retryAfter)}.`;
  return err instanceof Error ? err.message : "Something went wrong. Try again.";
}
