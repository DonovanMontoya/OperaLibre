type ReadalongPreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const READER_FOLLOW_STORAGE_KEY = "operalibre.readerFollow";
const FOLLOW_AGGRESSIVENESS_STORAGE_KEY = "operalibre.readalong.followAggressiveness";

export type FollowAggressiveness = 0 | 1 | 2;

export const FOLLOW_AGGRESSIVENESS_LABELS: Record<FollowAggressiveness, string> = {
  0: "Relaxed",
  1: "Balanced",
  2: "Aggressive"
};

/**
 * How far before the next sentence timestamp its highlight may appear. The
 * maximum is deliberately only a few syllables; this adjusts tuning rather
 * than trying to compensate for a badly aligned sync map.
 */
export const FOLLOW_AGGRESSIVENESS_LEAD_SECONDS: Record<FollowAggressiveness, number> = {
  0: 0,
  1: 0.15,
  2: 0.5
};

/** Follow starts off until the reader presses Follow; later openings keep that choice. */
export function readReaderFollowEnabled(storage?: ReadalongPreferenceStorage): boolean {
  try {
    return (storage ?? window.localStorage).getItem(READER_FOLLOW_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeReaderFollowEnabled(enabled: boolean, storage?: ReadalongPreferenceStorage): void {
  try {
    (storage ?? window.localStorage).setItem(READER_FOLLOW_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Keep the in-memory choice usable when device storage is unavailable.
  }
}

/** Existing installations retain the current timing until this is changed. */
export function readFollowAggressiveness(storage?: ReadalongPreferenceStorage): FollowAggressiveness {
  try {
    const value = Number((storage ?? window.localStorage).getItem(FOLLOW_AGGRESSIVENESS_STORAGE_KEY));
    return value === 1 || value === 2 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeFollowAggressiveness(
  value: FollowAggressiveness,
  storage?: ReadalongPreferenceStorage
): void {
  try {
    const target = storage ?? window.localStorage;
    if (value === 0) {
      target.removeItem(FOLLOW_AGGRESSIVENESS_STORAGE_KEY);
    } else {
      target.setItem(FOLLOW_AGGRESSIVENESS_STORAGE_KEY, String(value));
    }
  } catch {
    // Keep the in-memory setting usable when device storage is unavailable.
  }
}
