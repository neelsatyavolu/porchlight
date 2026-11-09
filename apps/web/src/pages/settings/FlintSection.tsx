// Flint (SPEC §7, DESIGN.md §7 "Settings"): one "Connect Flint" button that
// opens Flint with a one-time code, and the API tokens Flint holds, with Revoke.
import { useCallback, useEffect, useState } from "react";
import { isApiError } from "../../api/client";
import type { ApiTokenInfo } from "../../api/types";
import { Button, Row, SkeletonRows } from "../../components";
import { useSession } from "../../session";
import { errorText } from "./errors";
import { FlintConnectStatus } from "./FlintConnectStatus";
import { ago, fullDateTime, shortDate } from "./time";
import { useFlintConnect } from "./useFlintConnect";

type Tokens = { status: "loading" } | { status: "ready"; tokens: ApiTokenInfo[] } | { status: "error"; message: string };

export function FlintSection() {
  const { api, expired } = useSession();
  const [tokens, setTokens] = useState<Tokens>({ status: "loading" });
  const [revoking, setRevoking] = useState<string | null>(null);
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

  const loadTokens = useCallback(async () => {
    try {
      setTokens({ status: "ready", tokens: await api.listTokens() });
    } catch (err) {
      const message = fail(err);
      if (message) setTokens({ status: "error", message });
    }
  }, [api, fail]);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  const connect = useFlintConnect(() => void loadTokens());
  const waiting = connect.state.phase === "waiting";

  async function onRevoke(token: ApiTokenInfo) {
    setError(null);
    setRevoking(token.id);
    try {
      await api.deleteToken(token.id);
      setTokens((prev) => (prev.status === "ready" ? { status: "ready", tokens: prev.tokens.filter((t) => t.id !== token.id) } : prev));
    } catch (err) {
      if (isApiError(err, "not_found")) {
        await loadTokens();
      } else {
        const message = fail(err);
        if (message) setError(`Couldn't revoke ${token.label}. ${message}`);
      }
    } finally {
      setRevoking(null);
    }
  }

  return (
    <section className="settings__section" aria-labelledby="settings-flint">
      <h2 id="settings-flint" className="settings__title">
        Flint
      </h2>
      <p className="settings__text">
        Flint can add packages from your shipping mail. It sends only the carrier, tracking number, sender and subject, never the
        message itself.
      </p>

      <FlintConnectStatus state={connect.state} />

      <div className="settings__actions">
        <Button busy={connect.state.phase === "starting"} onClick={() => void connect.start()}>
          {waiting ? "Try again" : "Connect Flint"}
        </Button>
      </div>

      {error ? (
        <p className="settings__error" role="alert">
          {error}
        </p>
      ) : null}

      <TokenList tokens={tokens} revoking={revoking} onRevoke={onRevoke} onRetry={loadTokens} now={Date.now()} />
    </section>
  );
}

interface TokenListProps {
  tokens: Tokens;
  revoking: string | null;
  onRevoke: (token: ApiTokenInfo) => void;
  onRetry: () => void;
  now: number;
}

function TokenList({ tokens, revoking, onRevoke, onRetry, now }: TokenListProps) {
  if (tokens.status === "loading") return <SkeletonRows count={1} dots={false} label="Loading paired apps" />;
  if (tokens.status === "error") {
    return (
      <p className="settings__caption">
        Couldn't load paired apps. {tokens.message}{" "}
        <button type="button" className="settings__text-button" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  }
  if (tokens.tokens.length === 0) return <p className="settings__caption">Nothing is paired yet.</p>;
  return (
    <ul className="settings__list" aria-label="Paired apps">
      {tokens.tokens.map((t) => (
        <li key={t.id}>
          <Row
            title={t.label}
            meta={
              <span title={t.lastUsedAt ? fullDateTime(t.lastUsedAt) : undefined}>
                {t.lastUsedAt ? `Last used ${ago(t.lastUsedAt, now)}` : "Not used yet"} · Paired {shortDate(t.createdAt, now)}
              </span>
            }
            trailing={
              <Button size="sm" busy={revoking === t.id} onClick={() => onRevoke(t)} aria-label={`Revoke ${t.label}`}>
                Revoke
              </Button>
            }
          />
        </li>
      ))}
    </ul>
  );
}
