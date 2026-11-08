import "./Skeleton.css";

export interface SkeletonRowsProps {
  /** How many placeholder rows to draw. */
  count?: number;
  /** Read by screen readers while the rows are showing. */
  label?: string;
  /** Leave a status-dot slot at the left, as package rows have. */
  dots?: boolean;
}

/**
 * Static placeholder rows shown while data loads (no spinner, no shimmer).
 * They have the same height and hairlines as Row, so nothing jumps when data arrives.
 */
export function SkeletonRows({ count = 3, label = "Loading", dots = true }: SkeletonRowsProps) {
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton__row" aria-hidden="true">
          {dots ? <span className="skeleton__dot" /> : null}
          <span className="skeleton__lines">
            <span className="skeleton__bar skeleton__bar--title" />
            <span className="skeleton__bar skeleton__bar--meta" />
          </span>
        </div>
      ))}
    </div>
  );
}
