export const APPEARANCE_STORAGE_KEY = "operalibre.iosDarkMode";

export type AppearanceMode = "light" | "dark" | "system";

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function readAppearanceMode(storage: StorageReader): AppearanceMode {
  const stored = storage.getItem(APPEARANCE_STORAGE_KEY);
  // Earlier builds stored the on/off switch as a boolean. Both spellings were
  // explicit choices, so they keep meaning a fixed appearance.
  if (stored === "dark" || stored === "true") return "dark";
  if (stored === "light" || stored === "false") return "light";
  return "system";
}

export function writeAppearanceMode(storage: StorageWriter, mode: AppearanceMode): void {
  storage.setItem(APPEARANCE_STORAGE_KEY, mode);
}

export function resolveDarkMode(mode: AppearanceMode, systemPrefersDark: boolean): boolean {
  return mode === "dark" || (mode === "system" && systemPrefersDark);
}

export function applyDarkMode(root: HTMLElement, enabled: boolean): void {
  root.classList.toggle("dark-mode", enabled);
}

function prefersDarkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
}

export function applyAppearanceMode(mode: AppearanceMode): void {
  applyDarkMode(document.documentElement, resolveDarkMode(mode, prefersDarkQuery()?.matches ?? false));
}

/**
 * The stored mode, or "system" when site data is blocked: merely touching
 * window.localStorage throws then, and the app still has to paint.
 */
export function readStoredAppearanceMode(): AppearanceMode {
  try {
    return readAppearanceMode(window.localStorage);
  } catch {
    return "system";
  }
}

export function applyStoredAppearance(): void {
  if (!document.documentElement.classList.contains("platform-ios")) return;
  applyAppearanceMode(readStoredAppearanceMode());
}

/* In system mode the WKWebView re-evaluates prefers-color-scheme when the
   device theme changes (sunset, Control Center, Settings), so re-resolving
   the stored mode on that event keeps the app in step without a relaunch.
   A fixed light/dark choice re-resolves to itself, making this a no-op. */
export function watchSystemAppearance(): void {
  prefersDarkQuery()?.addEventListener("change", applyStoredAppearance);
}
