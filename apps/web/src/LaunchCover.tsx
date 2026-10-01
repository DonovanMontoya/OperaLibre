import { useEffect, useState, type CSSProperties } from "react";
import { LAUNCH_INTRO_MS, LAUNCH_LIFT_MS, launchIntroRemainingMs } from "./startup";

// The cover is mounted first by the sign-in check and again by the shell.
// Timing the intro from the page load keeps the second from starting it over.
let introStartedAt: number | null = null;
function introElapsedMs() {
  introStartedAt ??= performance.now();
  return performance.now() - introStartedAt;
}

/**
 * The native launch surface: it takes over from the iOS launch screen, plays
 * the intro once, and lifts when `ready` and the intro have both arrived.
 * While `settled` is false it holds a little longer for the native bar.
 * `onLift` fires as the fade starts, when the page beneath is first visible.
 */
export function NativeLaunchCover({ ready, settled = true, onLift }: {
  ready: boolean;
  settled?: boolean;
  onLift?: () => void;
}) {
  const [elapsedMs] = useState(() => Math.min(introElapsedMs(), LAUNCH_INTRO_MS));
  const [phase, setPhase] = useState<"covering" | "lifting" | "gone">("covering");
  useEffect(() => {
    if (!ready || phase !== "covering") return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => {
      setPhase("lifting");
      onLift?.();
    }, launchIntroRemainingMs(introElapsedMs(), reducedMotion, settled));
    return () => window.clearTimeout(timer);
  }, [onLift, phase, ready, settled]);
  useEffect(() => {
    if (phase !== "lifting") return;
    // A timer, not animationend: a cover that never left would block the app.
    const timer = window.setTimeout(() => setPhase("gone"), LAUNCH_LIFT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (phase === "gone") return null;
  return (
    <div
      className={`native-launch-cover${phase === "lifting" ? " lifting" : ""}`}
      role="status"
      aria-label="Opening OperaLibre"
      style={{ "--launch-elapsed": `${-elapsedMs}ms` } as CSSProperties}
    >
      <span className="native-launch-word" aria-hidden="true">
        OperaLibre
        <span className="native-launch-ink">OperaLibre</span>
        <span className="native-launch-playhead"><i /></span>
      </span>
    </div>
  );
}
