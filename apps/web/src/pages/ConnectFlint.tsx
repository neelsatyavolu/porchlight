// /app/connect/flint: where Flint's "Connect Porchlight" button lands. Signed
// in (RequireSession sends others to sign-in and back here), it makes a code
// and opens Flint straight away.
import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components";
import { FlintConnectStatus } from "./settings/FlintConnectStatus";
import { useFlintConnect } from "./settings/useFlintConnect";
import "./settings/Settings.css";

export function ConnectFlint() {
  const { state, start } = useFlintConnect();
  const started = useRef(false);

  useEffect(() => {
    // Once per visit, even when StrictMode runs effects twice.
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  const retry = state.phase === "failed" || (state.phase === "waiting" && state.stalled);
  return (
    <div className="settings">
      <h1 className="settings__page-title">Connect Flint</h1>
      <section className="settings__section" aria-label="Connect Flint">
        {state.phase === "starting" || state.phase === "idle" ? (
          <p className="settings__text" role="status">
            Getting a code…
          </p>
        ) : null}
        <FlintConnectStatus state={state} />
        {state.phase === "connected" ? (
          <p className="settings__text">
            You can close this tab and go back to Flint. <Link to="/app/settings">Settings</Link> lists what's connected.
          </p>
        ) : null}
        {retry ? (
          <div className="settings__actions">
            <Button onClick={() => void start()}>Try again</Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
