/** A pending seek is authoritative until the media element catches up. */
export function playbackReportPosition(
  itemId: string,
  pendingSeek: { trackId: string; positionSeconds: number } | null,
  clock: number
): number | null {
  const position = pendingSeek?.trackId === itemId ? pendingSeek.positionSeconds : clock;
  return Number.isFinite(position) ? Math.max(0, position) : null;
}

/** Serialize session reports so a slow start cannot arrive after its stop. */
export function createPlaybackReporter(send: (event: "start" | "stop", itemId: string, position: number) => Promise<void>) {
  let pending: Promise<unknown> = Promise.resolve();
  let activeItem: string | null = null;
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  };
  return {
    write: enqueue,
    start(itemId: string, position: number) {
      return enqueue(async () => {
        if (activeItem === itemId) return;
        await send("start", itemId, position);
        activeItem = itemId;
      });
    },
    stop(itemId: string, position: number) {
      return enqueue(async () => {
        if (activeItem !== itemId) return;
        activeItem = null;
        await send("stop", itemId, position);
      });
    }
  };
}
