import { useEffect, useState } from "react";

/** Refresh operator snapshots while visible; returning to the tab catches up immediately. */
export function usePeriodicRefresh(reload: () => void, ms = 30_000) {
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) reload();
    };
    const timer = setInterval(refresh, ms);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload, ms]);
}

/** Lifecycle state changes at the deadline, even if no event or user interaction occurs. */
export function useExpiryClock(deadlines: number[]) {
  const [now, setNow] = useState(Date.now);
  const next = deadlines.reduce((next, at) => (at > now ? Math.min(next, at) : next), Infinity);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = Number.isFinite(next)
      ? setTimeout(update, Math.min(2_147_483_647, Math.max(0, next - Date.now() + 1)))
      : undefined;
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [next, now]);
  return now;
}
