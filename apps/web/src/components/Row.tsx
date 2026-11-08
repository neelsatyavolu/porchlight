import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import "./Row.css";

/**
 * A list row (DESIGN.md §6 "Package row"). Slots:
 *   leading  | title ............ trailing
 *            | meta ......... trailingMeta
 * Pass `to` for a link row, `onClick` for a button row, neither for a static row.
 */
export interface RowProps {
  title: ReactNode;
  meta?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  trailingMeta?: ReactNode;
  to?: string;
  onClick?: () => void;
  selected?: boolean;
  /** Dims the row (archived, deleted while undo is offered). */
  muted?: boolean;
}

export function Row({ title, meta, leading, trailing, trailingMeta, to, onClick, selected = false, muted = false }: RowProps) {
  const className = ["row", selected ? "row--selected" : "", muted ? "row--muted" : "", to || onClick ? "row--interactive" : ""]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      {leading !== undefined ? <span className="row__leading">{leading}</span> : null}
      <span className="row__main">
        <span className="row__line">
          <span className="row__title">{title}</span>
          {trailing !== undefined ? <span className="row__trailing num">{trailing}</span> : null}
        </span>
        {meta !== undefined || trailingMeta !== undefined ? (
          <span className="row__line">
            <span className="row__meta">{meta}</span>
            {trailingMeta !== undefined ? <span className="row__trailing-meta">{trailingMeta}</span> : null}
          </span>
        ) : null}
      </span>
    </>
  );

  if (to) {
    return (
      <Link to={to} className={className} aria-current={selected ? "page" : undefined}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} aria-pressed={selected || undefined}>
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}
