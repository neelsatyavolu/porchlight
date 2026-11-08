import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./Button.css";

/**
 * primary: ink fill, one per view. accent: the page's single most important action
 * (never next to primary). ghost: secondary. danger: destructive, text only in red.
 */
export type ButtonVariant = "primary" | "accent" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  /** Shows a hairline progress bar and disables the button. */
  busy?: boolean;
  children: ReactNode;
}

export function Button({ variant = "ghost", size = "md", busy = false, disabled, className, type, children, ...rest }: ButtonProps) {
  const classes = ["btn", `btn--${variant}`, `btn--${size}`, busy ? "btn--busy" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button {...rest} type={type ?? "button"} className={classes} disabled={disabled || busy} aria-busy={busy || undefined}>
      {children}
    </button>
  );
}
