// CONTRACT: messages on TRACK_QUEUE.
export interface TrackJob {
  packageId: string;
  userId: string;
  /** Why the check was queued: cron schedule, manual refresh, or a new import. */
  reason: "scheduled" | "manual" | "import";
  /** Server time (ms) when queued. */
  enqueuedAt: number;
}
