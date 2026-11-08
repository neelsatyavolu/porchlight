// Single-key shortcuts for the package pages: "/" search, "n" add, Escape close.
import { useEffect, useRef } from "react";

export interface Hotkey {
  key: string;
  run: (e: KeyboardEvent) => void;
  /** Also fire while typing in a field. Only sensible for Escape. */
  inFields?: boolean;
}

function isField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Ignores keys with modifiers, keys while a modal is open (it owns Escape), and repeats. */
export function useHotkeys(hotkeys: readonly Hotkey[]): void {
  const ref = useRef(hotkeys);
  ref.current = hotkeys;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const hit = ref.current.find((h) => h.key === e.key);
      if (!hit) return;
      if (isField(e.target) && !hit.inFields) return;
      e.preventDefault();
      hit.run(e);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
