// Signed-in devices (SPEC §8 "settings (sessions ...)"): every session of the
// account from GET /v1/sessions, with Sign out for the others.
import { useCallback, useEffect, useState } from "react";
import { isApiError } from "../../api/client";
import type { Platform, SessionInfo } from "../../api/types";
import { Button, Row, SkeletonRows } from "../../components";
import { useSession } from "../../session";
import { errorText } from "./errors";
import { ago, fullDateTime, shortDate } from "./time";

type Sessions = { status: "loading" } | { status: "ready"; sessions: SessionInfo[] } | { status: "error"; message: string };

const PLATFORM_LABELS: Record<Platform, string> = { ios: "iPhone", macos: "Mac", web: "Web browser" };

function platformLabel(platform: Platform | null): string {
  return platform ? PLATFORM_LABELS[platform] : "Unknown device";
}

function metaLine(s: SessionInfo, now: number): string {
  const parts = [s.current ? "This browser" : `Last active ${ago(s.lastSeenAt, now)}`];
  if (s.appVersion) parts.push(`Version ${s.appVersion}`);
  parts.push(`Signed in ${shortDate(s.createdAt, now)}`);
  return parts.join(" · ");
}

export function SessionsSection() {
  const { api, expired } = useSession();
  const [sessions, setSessions] = useState<Sessions>({ status: "loading" });
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback(
    (err: unknown): string | null => {
      if (isApiError(err, "unauthorized")) {
        expired();
        return null;
      }
      return errorText(err);
    },
    [expired],
  );

  const load = useCallback(async () => {
    try {
      setSessions({ status: "ready", sessions: await api.listSessions() });
    } catch (err) {
      const message = fail(err);
      if (message) setSessions({ status: "error", message });
    }
  }, [api, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSignOut(s: SessionInfo) {
    setError(null);
    setRemoving(s.id);
    try {
      const res = await api.deleteSession(s.id);
      if (res.signedOut) {
        expired();
        return;
      }
      setSessions((prev) => (prev.status === "ready" ? { status: "ready", sessions: prev.sessions.filter((x) => x.id !== s.id) } : prev));
    } catch (err) {
      if (isApiError(err, "not_found")) {
        await load();
      } else {
        const message = fail(err);
        if (message) setError(`Couldn't sign out ${platformLabel(s.platform)}. ${message}`);
      }
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="settings__section" aria-labelledby="settings-sessions">
      <h2 id="settings-sessions" className="settings__title">
        Devices
      </h2>
      <p className="settings__text">Where your account is signed in. Signing a device out also stops its notifications.</p>
      {error ? (
        <p className="settings__error" role="alert">
          {error}
        </p>
      ) : null}
      <SessionList sessions={sessions} removing={removing} onSignOut={onSignOut} onRetry={load} />
    </section>
  );
}

interface SessionListProps {
  sessions: Sessions;
  removing: string | null;
  onSignOut: (s: SessionInfo) => void;
  onRetry: () => void;
}

function SessionList({ sessions, removing, onSignOut, onRetry }: SessionListProps) {
  if (sessions.status === "loading") return <SkeletonRows count={2} dots={false} label="Loading your devices" />;
  if (sessions.status === "error") {
    return (
      <p className="settings__caption">
        Couldn't load your devices. {sessions.message}{" "}
        <button type="button" className="settings__text-button" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  }
  const now = Date.now();
  return (
    <ul className="settings__list" aria-label="Signed-in devices">
      {sessions.sessions.map((s) => {
        const label = platformLabel(s.platform);
        return (
          <li key={s.id}>
            <Row
              title={label}
              meta={<span title={fullDateTime(s.lastSeenAt)}>{metaLine(s, now)}</span>}
              trailing={
                s.current ? undefined : (
                  <Button size="sm" busy={removing === s.id} onClick={() => onSignOut(s)} aria-label={`Sign out ${label}`}>
                    Sign out
                  </Button>
                )
              }
            />
          </li>
        );
      })}
    </ul>
  );
}
