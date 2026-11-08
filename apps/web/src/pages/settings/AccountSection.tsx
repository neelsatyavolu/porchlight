import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { isApiError } from "../../api/client";
import { Button, Row } from "../../components";
import { useSession, useUser } from "../../session";
import { DeleteAccountSheet } from "./DeleteAccountSheet";
import { errorText } from "./errors";

export function AccountSection() {
  const user = useUser();
  const { signOut, expired, api } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function onSignOut() {
    setError(null);
    setBusy(true);
    try {
      await signOut();
      navigate("/signin", { replace: true });
    } catch (err) {
      setError(`Couldn't sign out. ${errorText(err)}`);
      setBusy(false);
    }
  }

  async function onDelete() {
    try {
      await api.deleteAccount();
    } catch (err) {
      if (!isApiError(err, "unauthorized")) throw err;
    }
    navigate("/signin", { replace: true });
    expired();
  }

  const how = user.hasApple ? "Signed in with Apple" : "Signed in by email";

  return (
    <section className="settings__section" aria-labelledby="settings-account">
      <h2 id="settings-account" className="settings__title">
        Account
      </h2>
      <div className="settings__list">
        <Row
          title={user.email ?? "No email on this account"}
          meta={how}
          trailing={
            <Button size="sm" busy={busy} onClick={onSignOut}>
              Sign out
            </Button>
          }
        />
      </div>
      {error ? (
        <p className="settings__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="settings__actions">
        <Button variant="danger" onClick={() => setDeleting(true)}>
          Delete account
        </Button>
      </div>
      <DeleteAccountSheet open={deleting} onClose={() => setDeleting(false)} onConfirm={onDelete} />
    </section>
  );
}
