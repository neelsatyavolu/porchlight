// Optimistic state that has to outlive the page that started it: packages
// hidden while their DELETE is in flight, and the note shown when a write
// was rolled back after the user had already moved on.
import { useSyncExternalStore } from "react";

export interface PendingState {
  hidden: ReadonlySet<string>;
  notice: string | null;
}

const INITIAL: PendingState = { hidden: new Set(), notice: null };

let state: PendingState = INITIAL;
const listeners = new Set<() => void>();

function set(next: PendingState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const pending = {
  get: (): PendingState => state,
  hide(id: string): void {
    set({ ...state, hidden: new Set([...state.hidden, id]) });
  },
  unhide(id: string): void {
    if (!state.hidden.has(id)) return;
    set({ ...state, hidden: new Set([...state.hidden].filter((h) => h !== id)) });
  },
  notify(notice: string | null): void {
    set({ ...state, notice });
  },
  /** Tests only. */
  reset(): void {
    set(INITIAL);
  },
};

export function usePending(): PendingState {
  return useSyncExternalStore(subscribe, pending.get, pending.get);
}
