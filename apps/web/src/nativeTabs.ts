import type { AppearanceMode } from "./appearance";
import type { ShelfLayout } from "./shelfSort";

export type NativeTab = "shelf" | "reading" | "games" | "ledger" | "admin" | "settings";
/** A book store group in Settings that another screen can send the listener to. */
export type StoreSettingsTarget = "audible" | "libro";
export type NativeTabItem = { id: NativeTab; title: string; symbol: string; badge?: string };
export type NativeTabsState = {
  tabs: NativeTabItem[];
  selected: NativeTab;
  visible: boolean;
  blocked?: boolean;
  appearance: AppearanceMode;
  /** `#rrggbb` the selected screen shows where the page cannot reach, and
   *  which sets the status bar's polarity. */
  chrome?: string;
  /** `#rrggbb` tint for the floating bar's glass, so it passes for a pane of
   *  the page it floats over. */
  bar?: string;
};

/** The shell publishes each screen's tones as custom properties. Reading them
 *  back keeps the colors in the stylesheet with the rest of the palette. */
export function nativeShellColor(shell: Element | null, name: string): string | undefined {
  if (!shell) return undefined;
  const value = getComputedStyle(shell).getPropertyValue(name).trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
}

// Administration is a destination within Settings, keeping UIKit at five tabs.
export function nativeTabItems(games: boolean, ledger: boolean, alerts: number): NativeTabItem[] {
  return [
    { id: "shelf", title: "Shelf", symbol: "books.vertical", ...(alerts > 0 ? { badge: String(alerts) } : {}) },
    { id: "reading", title: "Reading", symbol: "headphones" },
    ...(games ? [{ id: "games" as const, title: "Games", symbol: "gamecontroller" }] : []),
    ...(ledger ? [{ id: "ledger" as const, title: "Ledger", symbol: "list.bullet.rectangle" }] : []),
    { id: "settings", title: "Settings", symbol: "gearshape" }
  ];
}

/**
 * The tab the listener is on. An iPad wide enough for the spread shows the
 * collection and the player together under either route, so there Shelf means
 * the collection alone and Reading means the spread, whichever route the page
 * was opened through.
 */
export function spreadTab(tab: NativeTab, spread: boolean, layout: ShelfLayout): NativeTab {
  if (!spread || (tab !== "shelf" && tab !== "reading")) return tab;
  return layout === "library" ? "shelf" : "reading";
}

/**
 * Playback and a book's details are set on the player page, which the full
 * collection puts away. Whatever opened them, the spread has to come back.
 */
export function fullShelfMustYield(tab: NativeTab, playerView: string, layout: ShelfLayout): boolean {
  return layout === "library" && (tab === "reading" || playerView !== "now");
}

export function nativeTabSelection(tab: NativeTab, tabs: NativeTabItem[]): NativeTab {
  if (tab === "admin") return "settings";
  return tabs.some((item) => item.id === tab) ? tab : "shelf";
}
