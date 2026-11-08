// Flint pairing (SPEC §7, DESIGN.md §7 "Settings"): a one-time ABCD-EFGH code
// that expires in 10 minutes, and the API tokens Flint holds, with Revoke.
import { useCallback, useEffect, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import type { ApiTokenInfo, PairingStartResponse } from "../../api/types";
import { Button, Row, SkeletonRows } from "../../components";
import { useSession } from "../../session";
import { errorText } from "./errors";
import { ago, countdown, fullDateTime, shortDate } from "./time";

/** While a code is showing, look for the new token this often so the list updates when Flint claims it. */
export const PAIRING_POLL_MS = 5_000;

type Tokens = { status: "loading" } | { status: "ready"; tokens: ApiTokenInfo[] } | { status: "error"; message: string };

export function FlintSection() {
  const { api, expired } = useSession();
  const [tokens, setTokens] = useState<Tokens>({ status: "loading" });
  const [pairing, setPairing] = useState<PairingStartResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [starting, setStarting] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const knownIds = useRef<Set<string> | null>(null);

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
      const list = await api.listTokens();
      setTokens({ status: "ready", tokens: list });
      return list;
    } catch (err) {
      const message = fail(err);
      if (message) setTokens({ status: "error", message });
      return null;
    }
  }, [api, fail]);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  const expiresAt = pairing ? Date.parse(pairing.expiresAt) : 0;
  const live = pairing !== null && expiresAt > now;

  // Tick the countdown once a second while a code is live.
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);

  // Watch for Flint claiming the code: a token id we haven't seen means it's paired.
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(async () => {
      const list = await loadTokens();
      if (!list) return;
      const seen = knownIds.current;
      if (!seen) knownIds.current = new Set(list.map((t) => t.id));
      else if (list.some((t) => !seen.has(t.id))) setPairing(null);
    }, PAIRING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, loadTokens]);

  async function onPair() {
    setError(null);
    setStarting(true);
    try {
      const res = await api.pairingStart();
      knownIds.current = tokens.status === "ready" ? new Set(tokens.tokens.map((t) => t.id)) : null;
      setNow(Date.now());
      setPairing(res);
    } catch (err) {
      const message = fail(err);
      if (message) setError(`Couldn't start pairing. ${message}`);
    } finally {
      setStarting(false);
    }
  }

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

      {pairing ? (
        <div className="settings__pairing">
          {live ? (
            <>
              <p className="settings__code mono">
                {pairing.code}
              </p>
              <p className="settings__caption num" role="timer" aria-live="off">
                Expires in {countdown(expiresAt - now)}
              </p>
              <p className="settings__text">In Flint, open Settings → Connections → Porchlight and enter this code.</p>
            </>
          ) : (
            <p className="settings__text">This code has expired. Get a new one to pair Flint.</p>
          )}
        </div>
      ) : null}

      <div className="settings__actions">
        <Button busy={starting} onClick={onPair}>
          {pairing ? "Get a new code" : "Pair Flint"}
        </Button>
      </div>

      {error ? (
        <p className="settings__error" role="alert">
          {error}
        </p>
      ) : null}

      <TokenList tokens={tokens} revoking={revoking} onRevoke={onRevoke} onRetry={loadTokens} now={now} />
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
