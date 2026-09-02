const READALONG_ENABLED_STORAGE_KEY = "operalibre.readalong.enabled";

type ReadalongPreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Whether the read-along reader is exposed. It ships off by default while the
 * follow-along experience is still being refined; the code stays in place and
 * a per-device toggle turns it on for testing.
 */
export function readReadalongEnabled(storage?: ReadalongPreferenceStorage): boolean {
  try {
    // Resolve the default inside the try: merely touching window.localStorage
    // throws under Safari's "Block All Cookies" and sandboxed frames.
    return (storage ?? window.localStorage).getItem(READALONG_ENABLED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeReadalongEnabled(enabled: boolean, storage?: ReadalongPreferenceStorage): void {
  try {
    const target = storage ?? window.localStorage;
    if (enabled) {
      target.setItem(READALONG_ENABLED_STORAGE_KEY, "true");
    } else {
      target.removeItem(READALONG_ENABLED_STORAGE_KEY);
    }
  } catch {
    // Keep the in-memory setting usable when device storage is unavailable.
  }
}

const FOLLOW_SYNC_ENABLED_STORAGE_KEY = "operalibre.readalong.followSync";

/**
 * Whether the reader tries to follow the audiobook: the moving highlight, word
 * marker, tap-to-seek, chapter auto-open, and sync-map generation. A sub-option
 * of the reader, off by default and gated behind a warning, because the
 * following can drift or pull the page while it is still being refined.
 */
export function readFollowSyncEnabled(storage?: ReadalongPreferenceStorage): boolean {
  try {
    return (storage ?? window.localStorage).getItem(FOLLOW_SYNC_ENABLED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeFollowSyncEnabled(enabled: boolean, storage?: ReadalongPreferenceStorage): void {
  try {
    const target = storage ?? window.localStorage;
    if (enabled) {
      target.setItem(FOLLOW_SYNC_ENABLED_STORAGE_KEY, "true");
    } else {
      target.removeItem(FOLLOW_SYNC_ENABLED_STORAGE_KEY);
    }
  } catch {
    // Keep the in-memory setting usable when device storage is unavailable.
  }
}
