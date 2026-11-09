// Connecting Flint (docs/API.md "Pairing and API tokens"): Porchlight makes a
// one-time code and hands it to Flint as a flint: link. Flint asks the user
// before it claims the code.

/** Look for Flint's new token this often while waiting for it to connect. */
export const CONNECT_POLL_MS = 2_000;
/** Stop waiting after this long; the code itself lasts 10 minutes. */
export const CONNECT_TIMEOUT_MS = 2 * 60_000;

export const FLINT_DOWNLOAD_URL = "https://flint.xanom.co";

/** flint://porchlight/pair?code=ABCD-EFGH&host=porchlight.xanom.co */
export function flintPairLink(code: string, host: string): string {
  return `flint://porchlight/pair?code=${encodeURIComponent(code)}&host=${encodeURIComponent(host)}`;
}

/** A top-level navigation to the custom scheme: the OS hands it to Flint and the page stays put. */
export function openFlint(link: string): void {
  window.location.assign(link);
}
