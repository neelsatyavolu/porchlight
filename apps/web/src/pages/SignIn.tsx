// /signin?next=<path> (DESIGN.md §7 "Sign-in"). Email -> 6-digit code or magic
// link, plus Sign in with Apple when VITE_APPLE_CLIENT_ID is set.
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import type { User } from "../api/types";
import { appleConfig as readAppleConfig, signInWithApple, type AppleConfig } from "../auth/apple";
import { signInErrorMessage } from "../auth/errors";
import { rememberNext, safeNext } from "../auth/next";
import { Button, Input } from "../components";
import { useSession } from "../session";
import { AppleButton } from "./signin/AppleButton";
import "./signin/SignIn.css";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;

export interface SignInProps {
  /** Defaults to the build's env. Null hides Sign in with Apple. Injected in tests. */
  apple?: AppleConfig | null;
  startApple?: typeof signInWithApple;
}

export function SignIn({ apple = readAppleConfig(), startApple }: SignInProps) {
  const { state, signedIn, api } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appleError, setAppleError] = useState<string | null>(null);

  if (state.status === "signedIn") return <Navigate to={next} replace />;

  function finish(user: User) {
    signedIn(user);
    navigate(next, { replace: true });
  }

  async function sendLink() {
    const address = email.trim();
    if (!EMAIL_RE.test(address)) {
      setError("Enter an email address like you@example.com.");
      return false;
    }
    setError(null);
    setBusy(true);
    try {
      rememberNext(next);
      await api.emailStart(address);
      return true;
    } catch (err) {
      setError(signInErrorMessage(err, "email"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onEmailSubmit(e: FormEvent) {
    e.preventDefault();
    if (await sendLink()) {
      setResent(false);
      setStep("code");
    }
  }

  async function onCodeSubmit(e: FormEvent) {
    e.preventDefault();
    const digits = code.replace(/\s/g, "");
    if (!CODE_RE.test(digits)) {
      setError("The code is 6 digits.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await api.emailVerifyCode(email.trim(), digits);
      finish(res.user);
    } catch (err) {
      setError(signInErrorMessage(err, "code"));
      setBusy(false);
    }
  }

  async function onResend() {
    if (await sendLink()) setResent(true);
  }

  function onChangeEmail() {
    setStep("email");
    setCode("");
    setError(null);
  }

  if (step === "code") {
    return (
      <main className="signin">
        <div className="signin__col">
          <h1 className="signin__heading">Check your email</h1>
          <p className="signin__lede">
            We sent a sign-in link to <span className="signin__address">{email.trim()}</span>. It works for 15 minutes.
          </p>
          <form className="signin__form" onSubmit={onCodeSubmit} noValidate>
            <Input
              label="Or enter the code from the email"
              mono
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              error={error}
            />
            <Button type="submit" variant="primary" busy={busy}>
              Sign in
            </Button>
          </form>
          <div className="signin__links">
            <button type="button" className="signin__text-button" onClick={onResend} disabled={busy}>
              {resent ? "Sent again" : "Send a new email"}
            </button>
            <button type="button" className="signin__text-button" onClick={onChangeEmail} disabled={busy}>
              Use a different email
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="signin">
      <div className="signin__col">
        <h1 className="serif signin__mark">Porchlight</h1>
        <p className="signin__lede">Sign in to see your packages on any device.</p>
        <form className="signin__form" onSubmit={onEmailSubmit} noValidate>
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={error}
          />
          <Button type="submit" variant="primary" busy={busy}>
            Email me a link
          </Button>
        </form>
        {apple ? (
          <>
            <p className="signin__or" aria-hidden="true">
              or
            </p>
            <AppleButton config={apple} onSignedIn={finish} onError={setAppleError} start={startApple} />
            {appleError ? (
              <p className="signin__error" role="alert">
                {appleError}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </main>
  );
}
