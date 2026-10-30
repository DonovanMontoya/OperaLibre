const CONTINUE_READING_AUTOPLAY_KEY = "operalibre.continueReading.autoplay";
const BOOK_PREVIEWS_KEY = "operalibre.bookPreviews.enabled";

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

const PLAYER_VISUALIZER_KEY = "operalibre.player.visualizer";

export const PLAYER_VISUALIZERS = ["off", "halo", "blocks", "bloom"] as const;
export type PlayerVisualizerMode = (typeof PLAYER_VISUALIZERS)[number];

export function readPlayerVisualizer(storage?: PreferenceStorage): PlayerVisualizerMode {
  try {
    const stored = (storage ?? window.localStorage).getItem(PLAYER_VISUALIZER_KEY);
    return PLAYER_VISUALIZERS.find((mode) => mode === stored) ?? "off";
  } catch {
    return "off";
  }
}

export function writePlayerVisualizer(mode: PlayerVisualizerMode, storage?: PreferenceStorage): void {
  try {
    (storage ?? window.localStorage).setItem(PLAYER_VISUALIZER_KEY, mode);
  } catch {
    // The visualizer still switches for this session when storage is unavailable.
  }
}
