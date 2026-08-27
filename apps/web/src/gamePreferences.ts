const GAMES_ENABLED_STORAGE_KEY = "operalibre.games.enabled";

type GamePreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readGamesEnabled(storage?: GamePreferenceStorage): boolean {
  try {
    // Resolve the default inside the try: merely touching window.localStorage
    // throws under Safari's "Block All Cookies" and sandboxed frames.
    return (storage ?? window.localStorage).getItem(GAMES_ENABLED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeGamesEnabled(enabled: boolean, storage?: GamePreferenceStorage): void {
  try {
    const target = storage ?? window.localStorage;
    if (enabled) {
      target.setItem(GAMES_ENABLED_STORAGE_KEY, "true");
    } else {
      target.removeItem(GAMES_ENABLED_STORAGE_KEY);
    }
  } catch {
    // Keep the in-memory setting usable when device storage is unavailable.
  }
}
