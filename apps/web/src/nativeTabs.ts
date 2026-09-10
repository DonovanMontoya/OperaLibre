import type { AppearanceMode } from "./appearance";

export type NativeTab = "shelf" | "reading" | "games" | "ledger" | "admin" | "settings";
export type NativeTabItem = { id: NativeTab; title: string; symbol: string; badge?: string };
export type NativeTabsState = {
  tabs: NativeTabItem[];
  selected: NativeTab;
  visible: boolean;
  blocked?: boolean;
  appearance: AppearanceMode;
};

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
