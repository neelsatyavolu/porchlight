import { useId, type InputHTMLAttributes } from "react";
import "./Input.css";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  /** Hide the label visually; it stays for screen readers. */
  hideLabel?: boolean;
  hint?: string;
  /** Shown in red under the field and wired to aria-invalid. */
  error?: string | null;
  /** Geist Mono, for tracking numbers and codes. */
  mono?: boolean;
}

export function Input({ label, hideLabel = false, hint, error, mono = false, className, ...rest }: InputProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={["field", className ?? ""].filter(Boolean).join(" ")}>
      <label htmlFor={id} className={hideLabel ? "visually-hidden" : "field__label"}>
        {label}
      </label>
      <input
        {...rest}
        id={id}
        className={mono ? "field__input field__input--mono" : "field__input"}
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
