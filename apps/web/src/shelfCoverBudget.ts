export const SHELF_COVER_MAX_BYTES = 128 * 1024 * 1024;
export const SHELF_COVER_MAX_FILES = 512;

export type CachedShelfCover = { path: string; size: number; mtime: number };

/** Evict oldest copies across servers before reserving room for a new cover. */
export function shelfCoverEvictions(files: CachedShelfCover[], incomingBytes: number): string[] {
  if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 1 || incomingBytes > SHELF_COVER_MAX_BYTES) {
    throw new Error("Invalid cover size");
  }
  let bytes = incomingBytes;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Unknown cached cover size");
    bytes += file.size;
  }
  let count = files.length + 1;
  const evictions: string[] = [];
  for (const file of [...files].sort((a, b) => a.mtime - b.mtime)) {
    if (bytes <= SHELF_COVER_MAX_BYTES && count <= SHELF_COVER_MAX_FILES) break;
    evictions.push(file.path);
    bytes -= file.size;
    count--;
  }
  return evictions;
}

/** Keep every distinct request, but fetch and mutate the cache one at a time. */
export function createShelfCoverQueue() {
  let tail = Promise.resolve();
  const pending = new Map<string, Promise<void>>();
  return (key: string, write: () => Promise<void>): Promise<void> => {
    const existing = pending.get(key);
    if (existing) return existing;
    const job = tail.then(write).finally(() => pending.delete(key));
    pending.set(key, job);
    tail = job.catch(() => undefined);
    return job;
  };
}
