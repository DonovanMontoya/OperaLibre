const CONTINUE_READING_AUTOPLAY_KEY = "operalibre.continueReading.autoplay";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function readContinueReadingAutoplay(storage?: PreferenceStorage): boolean {
  try {
    return (storage ?? window.localStorage).getItem(CONTINUE_READING_AUTOPLAY_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeContinueReadingAutoplay(enabled: boolean, storage?: PreferenceStorage): void {
  try {
    (storage ?? window.localStorage).setItem(CONTINUE_READING_AUTOPLAY_KEY, String(enabled));
  } catch {
    // The setting remains usable for this session when storage is unavailable.
  }
}
