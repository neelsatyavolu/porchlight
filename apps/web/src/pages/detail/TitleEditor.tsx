import { useRef, useState } from "react";
import { Input } from "../../components";

export interface TitleEditorProps {
  /** What the heading shows (title, merchant or carrier fallback). */
  display: string;
  /** The stored title, used to prefill the field. */
  title: string | null;
  /** Called with the trimmed title, or null to clear it. */
  onSave: (title: string | null) => void;
}

/** The detail heading. Click to rename; Enter or leaving the field saves, Escape cancels. */
export function TitleEditor({ display, title, onSave }: TitleEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const finished = useRef(false);

  function start() {
    finished.current = false;
    setDraft(title ?? "");
    setEditing(true);
  }

  function finish(save: boolean) {
    if (finished.current) return;
    finished.current = true;
    setEditing(false);
    if (!save) return;
    const next = draft.trim() === "" ? null : draft.trim();
    if (next !== title) onSave(next);
  }

  if (editing) {
    return (
      <Input
        label="Title"
        hideLabel
        autoFocus
        value={draft}
        placeholder={display}
        maxLength={200}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
      />
    );
  }

  return (
    <h1 className="detail__title">
      <button type="button" className="detail__title-button" onClick={start} title="Rename">
        {display}
      </button>
    </h1>
  );
}
