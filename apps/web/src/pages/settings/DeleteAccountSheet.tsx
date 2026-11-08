import { useEffect, useState, type FormEvent } from "react";
import { Button, Input, Sheet } from "../../components";
import { errorText } from "./errors";

export interface DeleteAccountSheetProps {
  open: boolean;
  onClose: () => void;
  /** Deletes the account. Rejects with the error to show. */
  onConfirm: () => Promise<void>;
}

const CONFIRM_WORD = "delete";
const FORM_ID = "delete-account-form";

export function DeleteAccountSheet({ open, onClose, onConfirm }: DeleteAccountSheetProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setTyped("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const confirmed = typed.trim().toLowerCase() === CONFIRM_WORD;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!confirmed || busy) return;
    setError(null);
    setBusy(true);
    try {
      await onConfirm();
    } catch (err) {
      setError(`Couldn't delete your account. ${errorText(err)}`);
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Delete your account"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} variant="danger" disabled={!confirmed} busy={busy}>
            Delete account
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className="settings__sheet-form" onSubmit={onSubmit}>
        <p>
          This removes your account, every package and every Flint connection right away. It can't be undone. Your Mac and iPhone
          apps will be signed out.
        </p>
        <Input
          label={`Type "${CONFIRM_WORD}" to confirm`}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          error={error}
        />
      </form>
    </Sheet>
  );
}
