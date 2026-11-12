/** Remembers which gifts have a download staged on this device, so an
 * abandoned or failed one does not keep its archive on the phone for good. */
const KEY = "operalibre.giftStaged.v1";
// A gift link works for at most 15 minutes; after that nothing can resume it.
const KEEP_MS = 16 * 60 * 1000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createStagedGiftTracker(storage: () => Store, cleanup: (giftId: string) => Promise<void>, importPending: (giftId: string) => boolean = () => false, now: () => number = Date.now) {
  const read = (): Record<string, number> => {
    try {
      const value: unknown = JSON.parse(storage().getItem(KEY) ?? "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, number> : {};
    } catch { return {}; }
  };
  const write = (value: Record<string, number>) => {
    try {
      if (Object.keys(value).length) storage().setItem(KEY, JSON.stringify(value));
      else storage().removeItem(KEY);
    } catch { /* Without storage the archive waits for the app to be reinstalled. */ }
  };
  /** Removes the staged archive. A failure keeps the note, so a later sweep tries again. */
  async function finish(giftId: string) {
    try { await cleanup(giftId); } catch { return; }
    const staged = read();
    delete staged[giftId];
    write(staged);
  }
  return {
    /** Call before the first byte is staged. */
    note(giftId: string) { write({ ...read(), [giftId]: now() }); },
    finish,
    /** Clears downloads whose gift can no longer be resumed. */
    async sweep() {
      for (const [giftId, at] of Object.entries(read())) {
        // An import interrupted mid-extraction still reads its archive when it is recovered.
        if (importPending(giftId)) continue;
        if (typeof at !== "number" || now() - at >= KEEP_MS) await finish(giftId);
      }
    }
  };
}

export type StagedGiftTracker = ReturnType<typeof createStagedGiftTracker>;
