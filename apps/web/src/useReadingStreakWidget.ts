import { useEffect } from "react";
import { getProfileStats } from "./api";
import { hasStreakWidget, syncReadingStreak } from "./carPlay";

export function useReadingStreakWidget(enabled: boolean, scope: string) {
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching || document.hidden) return;
      fetching = true;
      try {
        if (await hasStreakWidget() && active) {
          const stats = await getProfileStats();
          if (active) await syncReadingStreak(scope, stats);
        }
      } catch {
        // Offline readers keep the last dated Ledger entry.
      } finally {
        fetching = false;
      }
    };
    void refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    const timer = window.setInterval(refresh, 5 * 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, scope]);
}
