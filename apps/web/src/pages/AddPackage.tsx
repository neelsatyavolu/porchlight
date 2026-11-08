// Add by paste (DESIGN.md §7 "Add"). One number per line; each line shows the
// carriers detectCarrier finds, and an ambiguous number needs a pick. The
// client makes the id (crypto.randomUUID) and PUTs. Escape goes back to the list.
import type { CarrierId } from "@porchlight/carriers";
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { isApiError } from "../api/client";
import { Button, Input } from "../components";
import { usePackageActions, type AddResult } from "../packages/actions";
import { useHotkeys } from "../packages/hotkeys";
import { parseNumbers, type ParsedNumber } from "../packages/parse";
import type { DetailLocationState } from "./PackageDetail";
import { CarrierPicker } from "./add/CarrierPicker";
import { NumbersField } from "./add/NumbersField";
import "./add/Add.css";

export const ALREADY_TRACKING = "You're already tracking this.";

function failureText(err: unknown): string {
  if (isApiError(err, "network")) return "Couldn't reach Porchlight. Check your connection and try again.";
  if (isApiError(err, "rate_limited")) return "Too many at once. Wait a minute and try again.";
  if (err instanceof Error && err.message) return `Couldn't add this number: ${err.message}`;
  return "Couldn't add this number. Try again.";
}

function lineError(line: ParsedNumber, carrier: CarrierId | null): string | null {
  if (line.tooLong) return "This is too long to be a tracking number.";
  if (line.ambiguous && carrier === null) return "Pick a carrier for this number.";
  return null;
}

export function AddPackage() {
  const actions = usePackageActions();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [picks, setPicks] = useState<Readonly<Record<string, CarrierId>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useHotkeys([{ key: "Escape", inFields: true, run: () => navigate("/app") }]);

  const lines = useMemo(() => parseNumbers(text), [text]);
  const single = lines.length <= 1;
  const carrierFor = (line: ParsedNumber): CarrierId | null => picks[line.number] ?? line.preselected;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (lines.length === 0) {
      setFormError("Paste a tracking number.");
      return;
    }
    const invalid: Record<string, string> = {};
    for (const line of lines) {
      const msg = lineError(line, carrierFor(line));
      if (msg) invalid[line.number] = msg;
    }
    setFormError(null);
    setErrors(invalid);
    if (Object.keys(invalid).length > 0) return;

    setSaving(true);
    const failed: Record<string, string> = {};
    let last: AddResult | null = null;
    for (const line of lines) {
      try {
        last = await actions.add({
          trackingNumber: line.number,
          carrier: carrierFor(line) ?? undefined,
          title: single ? title.trim() || undefined : undefined,
        });
      } catch (err) {
        failed[line.number] = failureText(err);
      }
    }
    setSaving(false);

    if (Object.keys(failed).length > 0) {
      // Keep only what failed, so trying again doesn't add the rest twice.
      setText(lines.filter((l) => failed[l.number]).map((l) => l.number).join("\n"));
      setErrors(failed);
      return;
    }
    if (single && last) {
      if (last.kind === "duplicate") {
        const state: DetailLocationState = { note: ALREADY_TRACKING };
        navigate(`/app/p/${last.existingId}`, { state });
      } else {
        navigate(`/app/p/${last.pkg.id}`);
      }
      return;
    }
    navigate("/app");
  }

  return (
    <form className="add" onSubmit={(e) => void submit(e)} noValidate>
      <h1 className="add__title">Add a package</h1>

      <NumbersField
        label="Tracking number"
        hint="Paste one, or several with one per line."
        error={formError}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setFormError(null);
        }}
        autoFocus
        rows={single ? 2 : Math.min(lines.length + 1, 10)}
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />

      {lines.length > 0 ? (
        <div className="add__lines" aria-label="Detected carriers" role="group">
          {lines.map((line) => (
            <CarrierPicker
              key={line.number}
              line={line}
              selected={carrierFor(line)}
              onPick={(carrier) => {
                setPicks((prev) => ({ ...prev, [line.number]: carrier }));
                setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== line.number)));
              }}
              error={errors[line.number] ?? null}
            />
          ))}
        </div>
      ) : null}

      {single ? (
        <Input
          label="Title"
          hint="Optional. Shown in your list instead of the merchant or number."
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          autoComplete="off"
        />
      ) : (
        <p className="add__hint">You can name each package after it's added.</p>
      )}

      <div className="add__actions">
        <Button type="submit" variant="accent" busy={saving}>
          {single ? "Track package" : `Track ${lines.length} packages`}
        </Button>
      </div>
    </form>
  );
}
