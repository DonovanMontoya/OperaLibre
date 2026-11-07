/**
 * Covers that fail to load are tried again. Opening the app often races the
 * network (a VPN or Wi-Fi still reconnecting), and without a retry a cover
 * that missed that window stays a placeholder until the book changes.
 */

/** Waits before the automatic retries of one cover; then it waits for a wake. */
export const COVER_RETRY_DELAYS_MS = [2_000, 8_000, 30_000] as const;

export function coverRetryDelay(failures: number): number | null {
  return failures >= 1 && failures <= COVER_RETRY_DELAYS_MS.length ? COVER_RETRY_DELAYS_MS[failures - 1] : null;
}

type WakeTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * One shared wake signal for every cover on screen: the network returning or
 * the app coming back to the foreground retries all failed covers at once.
 * Window listeners exist only while some cover is subscribed.
 */
export function createCoverRetrySignal(win: WakeTarget, doc: WakeTarget & { hidden: boolean }) {
  let generation = 0;
  const listeners = new Set<() => void>();
  const wake = () => {
    if (doc.hidden) return;
    generation += 1;
    listeners.forEach(listener => listener());
  };
  return {
    subscribe(listener: () => void) {
      if (!listeners.size) {
        win.addEventListener("online", wake);
        doc.addEventListener("visibilitychange", wake);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          win.removeEventListener("online", wake);
          doc.removeEventListener("visibilitychange", wake);
        }
      };
    },
    generation: () => generation
  };
}

const noWake: WakeTarget = { addEventListener: () => undefined, removeEventListener: () => undefined };

export const coverRetrySignal = typeof window === "undefined"
  ? createCoverRetrySignal(noWake, { ...noWake, hidden: true })
  : createCoverRetrySignal(window, document);
