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

export const LIGHT_THEME_STORAGE_KEY = "operalibre.lightTheme";

export const LIGHT_THEMES = [
  { id: "parchment", label: "Parchment" },
  { id: "linen", label: "Linen" },
  { id: "sage", label: "Sage" },
  { id: "harbor", label: "Harbor" },
  { id: "pure-white", label: "Pure White" }
] as const;

export type LightTheme = (typeof LIGHT_THEMES)[number]["id"];

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

export function readLightTheme(storage: StorageReader): LightTheme {
  const stored = storage.getItem(LIGHT_THEME_STORAGE_KEY);
  return LIGHT_THEMES.find((theme) => theme.id === stored)?.id ?? "parchment";
}

export function writeLightTheme(storage: StorageWriter, theme: LightTheme): void {
  storage.setItem(LIGHT_THEME_STORAGE_KEY, theme);
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

export function readStoredLightTheme(): LightTheme {
  try {
    return readLightTheme(window.localStorage);
  } catch {
    return "parchment";
  }
}

/* Warm and Parchment are the base appearances, so they carry no attribute. */
function applyDarkTheme(theme: DarkTheme): void {
  const root = document.documentElement;
  if (theme === "warm") root.removeAttribute("data-dark-theme");
  else root.setAttribute("data-dark-theme", theme);
}

function applyLightTheme(theme: LightTheme): void {
  const root = document.documentElement;
  if (theme === "parchment") root.removeAttribute("data-light-theme");
  else root.setAttribute("data-light-theme", theme);
}

/* The turn only shows when the theme being changed is the one on screen, and
   it is one snapshot animated once, so it stays cheap on old phones. */
function turnTheme(visible: boolean, apply: () => void): void {
  const root = document.documentElement;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!visible || reducedMotion || !document.startViewTransition) {
    apply();
    return;
  }
  root.setAttribute("data-theme-turn", "");
  void document.startViewTransition(apply).finished
    .finally(() => root.removeAttribute("data-theme-turn"));
}

export function switchDarkTheme(theme: DarkTheme): void {
  turnTheme(document.documentElement.classList.contains("dark-mode"), () => applyDarkTheme(theme));
}

export function switchLightTheme(theme: LightTheme): void {
  turnTheme(!document.documentElement.classList.contains("dark-mode"), () => applyLightTheme(theme));
}

export function applyStoredAppearance(): void {
  if (!document.documentElement.classList.contains("platform-ios")) return;
  applyDarkTheme(readStoredDarkTheme());
  applyLightTheme(readStoredLightTheme());
  applyAppearanceMode(readStoredAppearanceMode());
}

/* In system mode the WKWebView re-evaluates prefers-color-scheme when the
   device theme changes (sunset, Control Center, Settings), so re-resolving
   the stored mode on that event keeps the app in step without a relaunch.
   A fixed light/dark choice re-resolves to itself, making this a no-op. */
export function watchSystemAppearance(): void {
  prefersDarkQuery()?.addEventListener("change", applyStoredAppearance);
}
