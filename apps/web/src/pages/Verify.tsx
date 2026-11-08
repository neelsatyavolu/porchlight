// /auth/verify?token=... (the link the API emails) and /signin/verify?token=...
// Trades the token once, then goes where SignIn said to go (default /app).
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { isApiError } from "../api/client";
import { signInErrorMessage } from "../auth/errors";
import { takeNext } from "../auth/next";
import { Button } from "../components";
import { useSession } from "../session";
import "./signin/SignIn.css";

type VerifyState = { status: "working" } | { status: "spent" } | { status: "missing" } | { status: "failed"; message: string };

export function Verify() {
  const { api, signedIn } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  // Read once and kept in state: the token is taken out of the address bar below.
  const [token] = useState(() => params.get("token"));
  const [state, setState] = useState<VerifyState>(token ? { status: "working" } : { status: "missing" });
  const [attempt, setAttempt] = useState(0);
  // A link token is single use; StrictMode runs effects twice in dev.
  const tried = useRef<string | null>(null);

  // A sign-in token should not stay in history, bookmarks or a copied address.
  useEffect(() => {
    if (params.has("token")) navigate(pathname, { replace: true });
  }, [params, pathname, navigate]);

  useEffect(() => {
    if (!token) return;
    const key = `${token}#${attempt}`;
    if (tried.current === key) return;
    tried.current = key;
    api
      .emailVerifyToken(token)
      .then((res) => {
        signedIn(res.user);
        navigate(takeNext(), { replace: true });
      })
      .catch((err: unknown) => {
        if (isApiError(err, "unauthorized")) setState({ status: "spent" });
        else setState({ status: "failed", message: signInErrorMessage(err, "email") });
      });
  }, [api, signedIn, navigate, token, attempt]);

  function retry() {
    setState({ status: "working" });
    setAttempt((n) => n + 1);
  }

  return (
    <main className="signin">
      <div className="signin__col" aria-live="polite">
        {state.status === "working" ? <h1 className="signin__heading">Signing you in</h1> : null}
        {state.status === "spent" ? (
          <>
            <h1 className="signin__heading">This link has expired or was already used.</h1>
            <p className="signin__lede">Links work once, for 15 minutes. Ask for a new one.</p>
            <p>
              <Link to="/signin">Send a new link</Link>
            </p>
          </>
        ) : null}
        {state.status === "missing" ? (
          <>
            <h1 className="signin__heading">This link is incomplete.</h1>
            <p className="signin__lede">Open the link from the email again, or enter the code from the email on the sign-in page.</p>
            <p>
              <Link to="/signin">Go to sign in</Link>
            </p>
          </>
        ) : null}
        {state.status === "failed" ? (
          <>
            <h1 className="signin__heading">Couldn't sign you in</h1>
            <p className="signin__lede">{state.message}</p>
            <div>
              <Button variant="primary" onClick={retry}>
                Try again
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
