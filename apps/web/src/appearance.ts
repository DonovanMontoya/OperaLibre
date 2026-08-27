export const DARK_MODE_STORAGE_KEY = "operalibre.iosDarkMode";

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function readDarkMode(storage: StorageReader): boolean {
  return storage.getItem(DARK_MODE_STORAGE_KEY) === "true";
}

export function writeDarkMode(storage: StorageWriter, enabled: boolean): void {
  storage.setItem(DARK_MODE_STORAGE_KEY, String(enabled));
}

export function applyDarkMode(root: HTMLElement, enabled: boolean): void {
  root.classList.toggle("dark-mode", enabled);
}

export function applyStoredDarkMode(): void {
  if (!document.documentElement.classList.contains("platform-ios")) return;
  applyDarkMode(document.documentElement, readDarkMode(window.localStorage));
}
