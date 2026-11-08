// The current time and zone for package pages. Ticks every 30 s so "checked
// 3 min ago" and day groups stay current. Tests wrap pages in <FixedClock>.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { systemTimeZone } from "./time";

export interface Clock {
  now: Date;
  timeZone: string;
}

const TICK_MS = 30_000;

const FixedClockContext = createContext<Clock | null>(null);

export function FixedClock({ now, timeZone, children }: Clock & { children: ReactNode }) {
  return <FixedClockContext.Provider value={{ now, timeZone }}>{children}</FixedClockContext.Provider>;
}

export function useClock(): Clock {
  const fixed = useContext(FixedClockContext);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (fixed) return;
    const timer = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [fixed]);
  return fixed ?? { now, timeZone: systemTimeZone() };
}
