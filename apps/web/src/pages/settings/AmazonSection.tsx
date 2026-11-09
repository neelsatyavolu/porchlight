// SPEC §6: Amazon is connected in the native apps only. The web shows how the
// last import went, as the app that ran it reported (GET /v1/integrations/amazon).
import { useCallback, useEffect, useState } from "react";
import { isApiError } from "../../api/client";
import type { AmazonIntegration, Platform } from "../../api/types";
import { useSession } from "../../session";
import { errorText } from "./errors";
import { ago, fullDateTime } from "./time";

type Load = { status: "loading" } | { status: "ready"; amazon: AmazonIntegration | null } | { status: "error"; message: string };

const DEVICE: Record<Platform, string> = { ios: "your iPhone", macos: "your Mac", web: "the web" };

export function AmazonSection() {
  const { api, expired } = useSession();
  const [load, setLoad] = useState<Load>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      setLoad({ status: "ready", amazon: await api.amazonIntegration() });
    } catch (err) {
      if (isApiError(err, "unauthorized")) return expired();
      // A server without the endpoint yet reads as "not connected".
      if (isApiError(err, "not_found")) return setLoad({ status: "ready", amazon: null });
      setLoad({ status: "error", message: errorText(err) });
    }
  }, [api, expired]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="settings__section" aria-labelledby="settings-amazon">
      <h2 id="settings-amazon" className="settings__title">
        Amazon
      </h2>
      <AmazonStatus load={load} onRetry={refresh} />
      <p className="settings__caption">
        Your Amazon sign-in stays on that device. Packages it finds show up here once they sync. Amazon can change its pages at any
        time, so this is best effort.
      </p>
    </section>
  );
}

function AmazonStatus({ load, onRetry }: { load: Load; onRetry: () => void }) {
  if (load.status === "loading") return <p className="settings__caption">Checking Amazon…</p>;
  if (load.status === "error") {
    return (
      <p className="settings__caption">
        Couldn't load the Amazon status. {load.message}{" "}
        <button type="button" className="settings__text-button" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  }
  const amazon = load.amazon;
  if (!amazon) {
    return (
      <p className="settings__text">
        Connect Amazon in the Porchlight app on your Mac or iPhone. The web can't sign in to Amazon for you.
      </p>
    );
  }
  const where = amazon.platform ? DEVICE[amazon.platform] : "your device";
  const last = amazon.lastImportAt ? (
    <span title={fullDateTime(amazon.lastImportAt)}>Last import {ago(amazon.lastImportAt)}</span>
  ) : (
    "No import has worked yet"
  );
  if (amazon.state === "ok") {
    return (
      <p className="settings__text">
        Connected on {where}. {last}.
      </p>
    );
  }
  const problem =
    amazon.state === "needs_sign_in"
      ? `Amazon wants you to sign in again. Open Porchlight on ${where}, then Settings, then Amazon.`
      : `Porchlight couldn't read your Amazon orders. An app update may fix it.`;
  return (
    <>
      <p className="settings__warn" role="status">
        {problem}
      </p>
      <p className="settings__caption">
        {last}. Checked <span title={fullDateTime(amazon.reportedAt)}>{ago(amazon.reportedAt)}</span>.
      </p>
    </>
  );
}
