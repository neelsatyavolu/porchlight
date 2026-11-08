import { useId, type TextareaHTMLAttributes } from "react";
import "../../components/Input.css";

export interface NumbersFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  label: string;
  hint?: string;
  error?: string | null;
}

/**
 * A multi-line Mono field for pasting tracking numbers. It is the shared Input's
 * styling on a <textarea>, kept here because only the add page needs it.
 */
export function NumbersField({ label, hint, error, className, ...rest }: NumbersFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      <textarea
        {...rest}
        id={id}
        className={["field__input", "field__input--mono", "add__numbers", className ?? ""].filter(Boolean).join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {hint && !error ? (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
