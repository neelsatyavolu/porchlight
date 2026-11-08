import type { PackageEvent, Status } from "../../api/types";
import { statusTone } from "../../lib/status";
import { timelineDays } from "../../packages/format";

export interface TimelineProps {
  /** Newest first. */
  events: readonly PackageEvent[];
  /** The package's status; the newest dot takes its tone. */
  status: Status;
  now: Date;
  timeZone: string;
}

/** Carrier scans grouped by local day, newest first (DESIGN.md §6 "Timeline"). */
export function Timeline({ events, status, now, timeZone }: TimelineProps) {
  const days = timelineDays(events, now, timeZone);
  const newestId = events[0]?.id;
  return (
    <div className="timeline">
      {days.map((day) => (
        <section key={day.day} className="timeline__day" aria-label={day.label}>
          <h3 className="timeline__header">{day.label}</h3>
          <ol className="timeline__events">
            {day.events.map((e) => {
              const newest = e.id === newestId;
              return (
                <li key={e.id} className={newest ? "timeline__event timeline__event--newest" : "timeline__event"}>
                  <span className="timeline__dot" data-tone={newest ? statusTone(status) : "old"} aria-hidden="true" />
                  <p className="timeline__text">{e.description}</p>
                  <p className="timeline__meta num">{e.location ? `${e.location} · ${e.time}` : e.time}</p>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
