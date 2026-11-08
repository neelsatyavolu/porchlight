import type { CarrierId } from "@porchlight/carriers";
import { carrierName } from "../../lib/carriers";
import type { ParsedNumber } from "../../packages/parse";

export interface CarrierPickerProps {
  line: ParsedNumber;
  selected: CarrierId | null;
  onPick: (carrier: CarrierId) => void;
  error?: string | null;
}

/** One pasted number with its detected carriers as selectable chips (a radio group). */
export function CarrierPicker({ line, selected, onPick, error }: CarrierPickerProps) {
  const name = `carrier-${line.number}`;
  return (
    <fieldset className="pick" aria-invalid={error ? true : undefined}>
      <legend className="pick__number mono">{line.number}</legend>
      {line.candidates.length === 0 ? (
        <p className="pick__note">Porchlight doesn't recognize this format. It will still try to track it.</p>
      ) : (
        <div className="pick__chips">
          {line.candidates.map((c) => (
            <label key={c.carrier} className="pick__chip">
              <input
                type="radio"
                name={name}
                value={c.carrier}
                checked={selected === c.carrier}
                onChange={() => onPick(c.carrier)}
                className="pick__radio"
              />
              <span>{carrierName(c.carrier)}</span>
            </label>
          ))}
        </div>
      )}
      {line.ambiguous && !error && selected === null ? <p className="pick__note">This number fits more than one carrier. Pick one.</p> : null}
      {error ? (
        <p className="pick__error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
