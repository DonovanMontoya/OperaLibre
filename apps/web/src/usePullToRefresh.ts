import { useRef, useState } from "react";
import { haptic } from "./native";

export const PULL_REFRESH_THRESHOLD = 64;

/**
 * iOS-style pull-to-refresh. Tracks a downward drag that starts with the
 * pane scrolled to the top and fires `onRefresh` once the pull passes the
 * threshold. Disabled (no handlers attached) outside the native shell.
 */
export function usePullToRefresh(enabled: boolean, onRefresh: () => Promise<unknown>) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const pullDistance = useRef(0);

  function updatePull(next: number) {
    if (pullDistance.current < PULL_REFRESH_THRESHOLD && next >= PULL_REFRESH_THRESHOLD) {
      haptic("light");
    }
    pullDistance.current = next;
    setPull(next);
  }

  function onTouchStart(event: React.TouchEvent<HTMLElement>) {
    if (refreshing) {
      return;
    }
    startY.current = event.currentTarget.scrollTop <= 0 ? event.touches[0].clientY : null;
  }

  function onTouchMove(event: React.TouchEvent<HTMLElement>) {
    if (refreshing || startY.current === null) {
      return;
    }
    if (event.currentTarget.scrollTop > 0) {
      startY.current = null;
      updatePull(0);
      return;
    }
    const delta = event.touches[0].clientY - startY.current;
    updatePull(delta > 0 ? Math.min(96, delta * 0.45) : 0);
  }

  function settle() {
    const distance = pullDistance.current;
    startY.current = null;
    updatePull(0);
    if (!refreshing && distance >= PULL_REFRESH_THRESHOLD) {
      haptic("medium");
      setRefreshing(true);
      void onRefresh().finally(() => setRefreshing(false));
    }
  }

  if (!enabled) {
    return { pull: 0, refreshing: false, handlers: {} };
  }
  return {
    pull,
    refreshing,
    handlers: { onTouchStart, onTouchMove, onTouchEnd: settle, onTouchCancel: settle }
  };
}
