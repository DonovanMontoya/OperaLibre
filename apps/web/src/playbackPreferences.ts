const CONTINUE_READING_AUTOPLAY_KEY = "operalibre.continueReading.autoplay";
const BOOK_PREVIEWS_KEY = "operalibre.bookPreviews.enabled";
const REMOVE_FINISHED_DOWNLOADS_KEY = "operalibre.downloads.removeWhenFinished";

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

// Previews are on unless this device has explicitly turned them off.
export function readBookPreviewsEnabled(storage?: PreferenceStorage): boolean {
  try {
    return (storage ?? window.localStorage).getItem(BOOK_PREVIEWS_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeBookPreviewsEnabled(enabled: boolean, storage?: PreferenceStorage): void {
  try {
    (storage ?? window.localStorage).setItem(BOOK_PREVIEWS_KEY, String(enabled));
  } catch {
    // The setting remains usable for this session when storage is unavailable.
  }
}

// Off unless this device has explicitly turned it on.
export function readRemoveFinishedDownloads(storage?: PreferenceStorage): boolean {
  try {
    return (storage ?? window.localStorage).getItem(REMOVE_FINISHED_DOWNLOADS_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeRemoveFinishedDownloads(enabled: boolean, storage?: PreferenceStorage): void {
  try {
    (storage ?? window.localStorage).setItem(REMOVE_FINISHED_DOWNLOADS_KEY, String(enabled));
  } catch {
    // The setting remains usable for this session when storage is unavailable.
  }
}
