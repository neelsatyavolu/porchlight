// The "Connect Flint" flow shared by Settings and /app/connect/flint: make a
// code, open the flint: link, then watch GET /v1/tokens for Flint's new token.
import { useCallback, useEffect, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import type { ApiTokenInfo, PairingStartResponse } from "../../api/types";
import { useSession } from "../../session";
import { errorText } from "./errors";
import { CONNECT_POLL_MS, CONNECT_TIMEOUT_MS, flintPairLink, openFlint } from "./flint";

export type FlintConnect =
  | { phase: "idle" }
  | { phase: "starting" }
  /** `stalled`: CONNECT_TIMEOUT_MS passed with no token, so polling stopped. */
  | { phase: "waiting"; pairing: PairingStartResponse; stalled: boolean }
  | { phase: "connected"; token: ApiTokenInfo }
  | { phase: "failed"; message: string };

export function useFlintConnect(onConnected?: (token: ApiTokenInfo) => void) {
  const { api, expired } = useSession();
  const [state, setState] = useState<FlintConnect>({ phase: "idle" });
  const known = useRef<Set<string>>(new Set());
  const deadline = useRef(0);
  const connected = useRef(onConnected);
  connected.current = onConnected;

  const start = useCallback(async () => {
    setState({ phase: "starting" });
    try {
      const [pairing, tokens] = await Promise.all([api.pairingStart(), api.listTokens()]);
      known.current = new Set(tokens.map((t) => t.id));
      deadline.current = Date.now() + CONNECT_TIMEOUT_MS;
      openFlint(flintPairLink(pairing.code, window.location.host));
      setState({ phase: "waiting", pairing, stalled: false });
    } catch (err) {
      if (isApiError(err, "unauthorized")) {
        expired();
        return;
      }
      setState({ phase: "failed", message: `Couldn't connect Flint. ${errorText(err)}` });
    }
  }, [api, expired]);

  const waiting = state.phase === "waiting" && !state.stalled;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(async () => {
      let tokens: ApiTokenInfo[];
      try {
        tokens = await api.listTokens();
      } catch (err) {
        if (isApiError(err, "unauthorized")) expired();
        return; // A missed poll is fine; the next one tries again.
      }
      const token = tokens.find((t) => !known.current.has(t.id));
      if (token) {
        setState({ phase: "connected", token });
        connected.current?.(token);
      } else if (Date.now() >= deadline.current) {
        setState((prev) => (prev.phase === "waiting" ? { ...prev, stalled: true } : prev));
      }
    }, CONNECT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [waiting, api, expired]);

  return { state, start };
}
