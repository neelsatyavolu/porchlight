// Who is signed in. The cookie is HttpOnly, so the only way to know is GET /v1/me.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { api as defaultApi, isApiError, type ApiClient } from "./api/client";
import type { User } from "./api/types";

export type SessionState =
  | { status: "loading" }
  | { status: "signedIn"; user: User }
  | { status: "signedOut" }
  /** /me failed for a reason other than 401 (offline, 5xx). */
  | { status: "error"; message: string };

export interface Session {
  state: SessionState;
  /** Call after a successful sign-in with the user from the response. */
  signedIn: (user: User) => void;
  /** Call when any request answers 401. */
  expired: () => void;
  signOut: () => Promise<void>;
  reload: () => void;
  api: ApiClient;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children, client = defaultApi }: { children: ReactNode; client?: ApiClient }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    client
      .me()
      .then((user) => {
        if (!cancelled) setState({ status: "signedIn", user });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isApiError(err, "unauthorized")) setState({ status: "signedOut" });
        else setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  const signedIn = useCallback((user: User) => setState({ status: "signedIn", user }), []);
  const expired = useCallback(() => setState({ status: "signedOut" }), []);
  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  const signOut = useCallback(async () => {
    try {
      await client.signOut();
    } catch (err) {
      // An expired session is already signed out; anything else is the caller's to show.
      if (!isApiError(err, "unauthorized")) throw err;
    }
    setState({ status: "signedOut" });
  }, [client]);

  const value = useMemo<Session>(
    () => ({ state, signedIn, expired, signOut, reload, api: client }),
    [state, signedIn, expired, signOut, reload, client],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <SessionProvider>");
  return session;
}

/** The signed-in user. Only call below <RequireSession>. */
export function useUser(): User {
  const { state } = useSession();
  if (state.status !== "signedIn") throw new Error("useUser called without a signed-in session");
  return state.user;
}

/** Renders children for a signed-in user and sends everyone else to /signin?next=<here>. */
export function RequireSession({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const { state } = useSession();
  const location = useLocation();
  if (state.status === "signedIn") return <>{children}</>;
  if (state.status === "signedOut") {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/signin?next=${next}`} replace />;
  }
  return <>{fallback}</>;
}
