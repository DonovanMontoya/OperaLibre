import type { AppearanceMode } from "./appearance";

export type NativeTab = "shelf" | "reading" | "games" | "ledger" | "admin" | "settings";
export type NativeTabItem = { id: NativeTab; title: string; symbol: string; badge?: string };
export type NativeTabsState = {
  tabs: NativeTabItem[];
  selected: NativeTab;
  visible: boolean;
  blocked?: boolean;
  appearance: AppearanceMode;
  /** `#rrggbb` the selected screen carries at its edges, for UIKit to paint
   *  the strip under the web view and behind the bar. */
  chrome?: string;
};

/** The shell publishes each screen's edge tone as --native-chrome. Reading it
 *  back keeps the color in the stylesheet with the rest of the palette. */
export function nativeChrome(shell: Element | null): string | undefined {
  if (!shell) return undefined;
  const value = getComputedStyle(shell).getPropertyValue("--native-chrome").trim();
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

export function nativeTabSelection(tab: NativeTab, tabs: NativeTabItem[]): NativeTab {
  if (tab === "admin") return "settings";
  return tabs.some((item) => item.id === tab) ? tab : "shelf";
}
