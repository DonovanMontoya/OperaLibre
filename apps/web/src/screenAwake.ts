type WakeLockSentinelLike = {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void, options?: AddEventListenerOptions): void;
};

type WakeLockLike = {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
};

type VisibilityDocument = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

/** Keeps the display awake only while an ebook reader is actually open. */
export function createScreenAwakeController(
  documentRef: VisibilityDocument = document,
  wakeLock: WakeLockLike | undefined = navigator.wakeLock
) {
  let readingActive = false;
  let disposed = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let requestPending = false;

  const acquire = async () => {
    if (
      disposed
      || !readingActive
      || documentRef.visibilityState !== "visible"
      || !wakeLock
      || sentinel
      || requestPending
    ) {
      return;
    }

    requestPending = true;
    try {
      const acquired = await wakeLock.request("screen");
      if (disposed || !readingActive) {
        await acquired.release();
        return;
      }
      sentinel = acquired;
      acquired.addEventListener("release", () => {
        if (sentinel === acquired) sentinel = null;
      }, { once: true });
    } catch {
      // Wake lock is optional and can be denied by the OS or browser.
    } finally {
      requestPending = false;
    }
  };

  const release = () => {
    const held = sentinel;
    sentinel = null;
    if (held) void held.release().catch(() => undefined);
  };

  const handleVisibilityChange = () => {
    if (documentRef.visibilityState === "visible") void acquire();
    else release();
  };
  documentRef.addEventListener("visibilitychange", handleVisibilityChange);

  return {
    setReadingActive(active: boolean) {
      readingActive = active;
      if (active) void acquire();
      else release();
    },
    dispose() {
      disposed = true;
      readingActive = false;
      documentRef.removeEventListener("visibilitychange", handleVisibilityChange);
      release();
    }
  };
}
