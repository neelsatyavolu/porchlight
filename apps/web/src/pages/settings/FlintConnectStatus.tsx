// What "Connect Flint" shows while it waits: "Opening Flint…", then the token
// that arrived. Under it, a link to get Flint and the code for typing in.
import { useEffect, useState } from "react";
import type { PairingStartResponse } from "../../api/types";
import { FLINT_DOWNLOAD_URL } from "./flint";
import { countdown } from "./time";
import type { FlintConnect } from "./useFlintConnect";

export function FlintConnectStatus({ state }: { state: FlintConnect }) {
  if (state.phase === "connected") {
    return (
      <p className="settings__text settings__connected" role="status">
        Connected to {state.token.label}
      </p>
    );
  }
  if (state.phase === "failed") {
    return (
      <p className="settings__error" role="alert">
        {state.message}
      </p>
    );
  }
  if (state.phase !== "waiting") return null;
  return (
    <div className="settings__pairing">
      <p className="settings__text" role="status">
        {state.stalled ? "Flint hasn't connected yet." : "Opening Flint…"}
      </p>
      <p className="settings__caption">
        Flint not opening?{" "}
        <a href={FLINT_DOWNLOAD_URL} target="_blank" rel="noreferrer">
          Get Flint
        </a>
      </p>
      <CodeDisclosure pairing={state.pairing} />
    </div>
  );
}

function CodeDisclosure({ pairing }: { pairing: PairingStartResponse }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = Date.parse(pairing.expiresAt);
  const live = expiresAt > now;

  useEffect(() => {
    if (!open || !live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, live]);

  return (
    <>
      <button
        type="button"
        className="settings__text-button settings__caption"
        aria-expanded={open}
        aria-controls="flint-code"
        onClick={() => {
          setNow(Date.now());
          setOpen((v) => !v);
        }}
      >
        Use a code instead
      </button>
      {open ? (
        <div id="flint-code" className="settings__code-box">
          {live ? (
            <>
              <p className="settings__code mono">{pairing.code}</p>
              <p className="settings__caption num" role="timer" aria-live="off">
                Expires in {countdown(expiresAt - now)}
              </p>
              <p className="settings__text">In Flint, open Settings, then Porchlight, and enter this code.</p>
            </>
          ) : (
            <p className="settings__text">This code has expired.</p>
          )}
        </div>
      ) : null}
    </>
  );
}
