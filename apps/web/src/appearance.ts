export const APPEARANCE_STORAGE_KEY = "operalibre.iosDarkMode";

export type AppearanceMode = "light" | "dark" | "system";

export const DARK_THEME_STORAGE_KEY = "operalibre.darkTheme";

export const DARK_THEMES = [
  { id: "warm", label: "Warm" },
  { id: "graphite", label: "Graphite" },
  { id: "midnight", label: "Midnight" },
  { id: "reading-room", label: "Reading Room" },
  { id: "true-black", label: "True Black" }
] as const;

export type DarkTheme = (typeof DARK_THEMES)[number]["id"];

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

export function readDarkTheme(storage: StorageReader): DarkTheme {
  const stored = storage.getItem(DARK_THEME_STORAGE_KEY);
  return DARK_THEMES.find((theme) => theme.id === stored)?.id ?? "warm";
}

export function writeDarkTheme(storage: StorageWriter, theme: DarkTheme): void {
  storage.setItem(DARK_THEME_STORAGE_KEY, theme);
}

export function resolveDarkMode(mode: AppearanceMode, systemPrefersDark: boolean): boolean {
  return mode === "dark" || (mode === "system" && systemPrefersDark);
}

function applyDarkMode(root: HTMLElement, enabled: boolean): void {
  root.classList.toggle("dark-mode", enabled);
}

export function prefersDarkQuery(): MediaQueryList | null {
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

export function readStoredDarkTheme(): DarkTheme {
  try {
    return readDarkTheme(window.localStorage);
  } catch {
    return "warm";
  }
}

/* Warm is the base dark appearance, so it carries no attribute. */
export function applyDarkTheme(theme: DarkTheme): void {
  const root = document.documentElement;
  if (theme === "warm") root.removeAttribute("data-dark-theme");
  else root.setAttribute("data-dark-theme", theme);
}

/* The turn only shows while the app is dark, and it is one snapshot animated
   once, so it stays cheap on old phones. */
export function switchDarkTheme(theme: DarkTheme): void {
  const root = document.documentElement;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!root.classList.contains("dark-mode") || reducedMotion || !document.startViewTransition) {
    applyDarkTheme(theme);
    return;
  }
  root.setAttribute("data-theme-turn", "");
  void document.startViewTransition(() => applyDarkTheme(theme)).finished
    .finally(() => root.removeAttribute("data-theme-turn"));
}

export function applyStoredAppearance(): void {
  if (!document.documentElement.classList.contains("platform-ios")) return;
  applyDarkTheme(readStoredDarkTheme());
  applyAppearanceMode(readStoredAppearanceMode());
}

/* In system mode the WKWebView re-evaluates prefers-color-scheme when the
   device theme changes (sunset, Control Center, Settings), so re-resolving
   the stored mode on that event keeps the app in step without a relaunch.
   A fixed light/dark choice re-resolves to itself, making this a no-op. */
export function watchSystemAppearance(): void {
  prefersDarkQuery()?.addEventListener("change", applyStoredAppearance);
}
