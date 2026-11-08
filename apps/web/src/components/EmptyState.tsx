import type { ReactNode } from "react";
import "./EmptyState.css";

export interface EmptyStateProps {
  title: string;
  /** One or two plain sentences: what is true, and what to do. */
  children?: ReactNode;
  /** Usually one Button or link. */
  action?: ReactNode;
  /** "page" sets the title in Geist Serif at 40px for a whole-page state; "inline" sits inside a section. */
  size?: "page" | "inline";
}

export function EmptyState({ title, children, action, size = "inline" }: EmptyStateProps) {
  return (
    <section className={`empty empty--${size}`}>
      {size === "page" ? <h1 className="empty__title serif">{title}</h1> : <h2 className="empty__title">{title}</h2>}
      {children ? <div className="empty__body">{children}</div> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </section>
  );
}
