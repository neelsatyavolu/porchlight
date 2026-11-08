import { useState } from "react";
import { AppleCancelled, signInWithApple, type AppleConfig } from "../../auth/apple";
import { signInErrorMessage } from "../../auth/errors";
import { Button } from "../../components";
import type { User } from "../../api/types";
import { useSession } from "../../session";

export interface AppleButtonProps {
  config: AppleConfig;
  onSignedIn: (user: User) => void;
  onError: (message: string | null) => void;
  /** Injected in tests. */
  start?: typeof signInWithApple;
}

/** Ghost button: Apple popup, then POST /v1/auth/apple with the identity token. */
export function AppleButton({ config, onSignedIn, onError, start = signInWithApple }: AppleButtonProps) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    onError(null);
    setBusy(true);
    try {
      const { identityToken, nonce } = await start(config);
      const res = await api.appleSignIn(identityToken, nonce);
      onSignedIn(res.user);
    } catch (err) {
      if (!(err instanceof AppleCancelled)) onError(signInErrorMessage(err, "apple"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="ghost" className="signin__apple" busy={busy} onClick={handleClick}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
        <path d="M11.2 8.5c0-1.5 1.2-2.2 1.3-2.3-.7-1-1.8-1.2-2.2-1.2-.9-.1-1.8.6-2.3.6-.5 0-1.2-.5-2-.5-1 0-2 .6-2.5 1.6-1.1 1.9-.3 4.7.8 6.2.5.7 1.1 1.6 1.9 1.5.8 0 1-.5 2-.5.9 0 1.2.5 2 .5.8 0 1.3-.8 1.8-1.5.6-.8.8-1.6.8-1.7 0 0-1.5-.6-1.6-2.4ZM9.8 4c.4-.5.7-1.2.6-1.9-.6 0-1.3.4-1.8.9-.4.4-.7 1.1-.6 1.8.7.1 1.3-.3 1.8-.8Z" />
      </svg>
      Sign in with Apple
    </Button>
  );
}
