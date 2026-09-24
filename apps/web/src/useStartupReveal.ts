import { useCallback, useEffect, useRef, useState } from "react";
import { NATIVE_STARTUP_SETTLE_MS } from "./startup";

export function useStartupReveal({
  native
}: {
  native: boolean;
}) {
  // Authentication can be restored synchronously, but the native destination
  // and playback position depend on cached state. Keep the launch surface
  // visible until both are coherent so neither the default Shelf nor the
  // first track at 0:00 flashes on the way to a restored session.
  const [startupViewReady, setStartupViewReady] = useState(!native);
  const startupViewReadyRef = useRef(!native);
  const startupProgressAppliedRef = useRef(false);
  const startupRevealTimerRef = useRef<number | null>(null);
  const scheduleStartupReveal = useCallback(() => {
    if (!native || startupViewReadyRef.current) return;
    if (startupRevealTimerRef.current !== null) {
      window.clearTimeout(startupRevealTimerRef.current);
    }
    // Progress can arrive from the library summary, IndexedDB, AVPlayer, and
    // the server within a few frames. Reveal only after that burst goes quiet.
    startupRevealTimerRef.current = window.setTimeout(() => {
      startupRevealTimerRef.current = null;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        startupViewReadyRef.current = true;
        setStartupViewReady(true);
      }));
    }, NATIVE_STARTUP_SETTLE_MS);
  }, [native]);
  useEffect(() => () => {
    if (startupRevealTimerRef.current !== null) {
      window.clearTimeout(startupRevealTimerRef.current);
    }
  }, []);

  return {
    scheduleStartupReveal,
    setStartupViewReady,
    startupProgressAppliedRef,
    startupViewReady,
    startupViewReadyRef
  };
}
