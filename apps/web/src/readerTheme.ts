/**
 * The reader's page colours. Besides the three fixed looks, `auto` follows
 * the app: on iOS that is the appearance chosen in Settings (which itself can
 * track the system theme), elsewhere the browser's colour-scheme preference.
 */
export type ReaderTheme = "paper" | "sepia" | "night";
export type ReaderThemeChoice = ReaderTheme | "auto";

export const READER_THEME_STORAGE_KEY = "operalibre.readerTheme";
export const READER_THEME_CHOICES: readonly ReaderThemeChoice[] = ["auto", "paper", "sepia", "night"];

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function readReaderThemeChoice(storage: StorageReader): ReaderThemeChoice {
  let stored: string | null = null;
  try {
    stored = storage.getItem(READER_THEME_STORAGE_KEY);
  } catch {
    stored = null;
  }
  if (stored === "paper" || stored === "sepia" || stored === "night") return stored;
  // An install that never picked a look follows the app's appearance.
  return "auto";
}

export function writeReaderThemeChoice(storage: StorageWriter, choice: ReaderThemeChoice): void {
  try {
    storage.setItem(READER_THEME_STORAGE_KEY, choice);
  } catch {
    // Keep the in-memory choice usable when device storage is unavailable.
  }
}

export function resolveReaderTheme(choice: ReaderThemeChoice, prefersDark: boolean): ReaderTheme {
  if (choice === "auto") return prefersDark ? "night" : "paper";
  return choice;
}

type ClassRoot = { classList: Pick<DOMTokenList, "contains"> };

/**
 * Whether the app is showing its dark look. The iOS shell resolves its own
 * appearance setting (light, dark, or system) onto the root's `dark-mode`
 * class, so the reader defers to that there; the web build has no dark
 * chrome and takes the system preference directly.
 */
export function appPrefersDark(root: ClassRoot, systemPrefersDark: boolean): boolean {
  if (root.classList.contains("platform-ios")) {
    return root.classList.contains("dark-mode");
  }
  return systemPrefersDark;
}

function prefersDarkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
}

export function currentAppPrefersDark(): boolean {
  return appPrefersDark(document.documentElement, prefersDarkQuery()?.matches ?? false);
}

/**
 * Calls back whenever the app's dark look changes: the system theme flips
 * (sunset, Control Center) or the iOS appearance setting re-resolves onto the
 * root class. Returns the unsubscribe.
 */
export function watchAppPrefersDark(onChange: (prefersDark: boolean) => void): () => void {
  const query = prefersDarkQuery();
  const notify = () => onChange(currentAppPrefersDark());
  query?.addEventListener("change", notify);
  const observer = typeof MutationObserver === "function" ? new MutationObserver(notify) : null;
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => {
    query?.removeEventListener("change", notify);
    observer?.disconnect();
  };
}

/** Page, ink, and link colours of each look, matching the reader chrome in styles.css. */
export const READER_THEME_COLORS: Record<ReaderTheme, { page: string; ink: string; link: string }> = {
  paper: { page: "#fffdf7", ink: "#241b15", link: "#7c2f2a" },
  sepia: { page: "#f2e5c9", ink: "#3b2b1d", link: "#7d3f26" },
  night: { page: "#171411", ink: "#e7dcc8", link: "#d9b574" }
};

type ThemeOverrides = { override(name: string, value: string, priority?: boolean): void };

/**
 * Colours the chapter for `theme` through the custom properties the shared
 * page stylesheet reads. epub.js keeps every stylesheet it has injected, so
 * switching whole themes leaves the earlier ones in place and the last one
 * added wins for good; overriding variables changes the one sheet in place
 * and carries over to chapters opened later.
 */
export function applyReaderThemeColors(themes: ThemeOverrides, theme: ReaderTheme): void {
  const colors = READER_THEME_COLORS[theme];
  themes.override("--reader-page", colors.page);
  themes.override("--reader-ink", colors.ink);
  themes.override("--reader-link", colors.link);
}
