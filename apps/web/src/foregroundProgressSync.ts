import { NativeForegroundSyncGate } from "./nativeAudioState.ts";

type SyncActions = {
  nativeAudio: boolean;
  persistProgress(): Promise<void>;
  adoptNewerServerProgress(): Promise<void>;
  /**
   * Redraw the progress bar from the media element's live clock. Web audio
   * keeps playing in the background but its first tick after resume can land
   * a frame late; the native player's clock arrives on its own event instead.
   * Display only: a save queued here would block the server adoption below
   * and could stamp a stale paused position over another device's rewind.
   */
  refreshClock(): void;
};

/** Own the resume timer for the mounted app, independently of book updates. */
export function createForegroundProgressSync(
  gate: NativeForegroundSyncGate,
  actions: () => SyncActions,
  documentRef: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
  windowRef: Pick<Window, "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout"> = window
) {
  let timer: number | null = null;
  let disposed = false;
  const cancelRetry = () => {
    if (timer !== null) windowRef.clearTimeout(timer);
    timer = null;
  };
  const retry = () => {
    cancelRetry();
    if (disposed || documentRef.visibilityState !== "visible") return;
    const current = actions();
    if (current.nativeAudio && gate.shouldDeferServerAdoption()) {
      timer = windowRef.setTimeout(retry, gate.msUntilDeadline());
      return;
    }
    void current.adoptNewerServerProgress();
  };
  const save = () => { void actions().persistProgress(); };
  const visibilityChanged = () => {
    if (documentRef.visibilityState === "hidden") {
      gate.backgrounded();
      cancelRetry();
      save();
    } else if (documentRef.visibilityState === "visible") {
      gate.foregrounded();
      const current = actions();
      if (!current.nativeAudio) current.refreshClock();
      retry();
    }
  };
  // Mounting while hidden still requires a native clock on the first resume.
  if (documentRef.visibilityState === "hidden") gate.backgrounded();
  documentRef.addEventListener("visibilitychange", visibilityChanged);
  windowRef.addEventListener("pagehide", save);

  return {
    nativeStateSynchronized() {
      if (disposed || documentRef.visibilityState !== "visible") return;
      if (gate.nativeStateReceived()) retry();
    },
    dispose() {
      disposed = true;
      cancelRetry();
      documentRef.removeEventListener("visibilitychange", visibilityChanged);
      windowRef.removeEventListener("pagehide", save);
    }
  };
}
