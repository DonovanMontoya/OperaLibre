import { compareShelfLabels } from "./shelfLabels";

// Group headings the reader has folded away, per grouping sort, so collapsing a
// series under Series leaves the same name alone under Tag. Kept on the device:
// it is how this screen is arranged, not something another device should inherit.
export const SHELF_COLLAPSED_GROUPS_STORAGE_KEY = "operalibre.collapsedShelfGroups";

export type CollapsedShelfGroups = Record<string, string[]>;

type ShelfGroupStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const browserStorage: ShelfGroupStorage = {
  getItem(key) { return window.localStorage.getItem(key); },
  setItem(key, value) { window.localStorage.setItem(key, value); }
};

export function readCollapsedShelfGroups(storage: Pick<ShelfGroupStorage, "getItem"> = browserStorage): CollapsedShelfGroups {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(SHELF_COLLAPSED_GROUPS_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const groups: CollapsedShelfGroups = {};
    for (const [sortMode, keys] of Object.entries(parsed)) {
      if (!Array.isArray(keys)) continue;
      const valid = keys.filter((key): key is string => typeof key === "string" && key.length > 0);
      if (valid.length) groups[sortMode] = valid;
    }
    return groups;
  } catch {
    return {};
  }
}

export function writeCollapsedShelfGroups(groups: CollapsedShelfGroups, storage: Pick<ShelfGroupStorage, "setItem"> = browserStorage) {
  try {
    storage.setItem(SHELF_COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Storage unavailable or full — the headings just open expanded next time.
  }
}

export function isShelfGroupCollapsed(groups: CollapsedShelfGroups, sortMode: string, label: string) {
  return groups[sortMode]?.some((entry) => compareShelfLabels(entry, label) === 0) ?? false;
}

export function expandShelfGroups(groups: CollapsedShelfGroups, sortMode: string): CollapsedShelfGroups {
  const updated = { ...groups };
  delete updated[sortMode];
  return updated;
}

export function toggleCollapsedShelfGroup(groups: CollapsedShelfGroups, sortMode: string, label: string): CollapsedShelfGroups {
  const key = label.trim();
  const current = groups[sortMode] ?? [];
  const next = current.some((entry) => compareShelfLabels(entry, key) === 0)
    ? current.filter((entry) => compareShelfLabels(entry, key) !== 0) : [...current, key];
  const updated = { ...groups, [sortMode]: next };
  if (!next.length) delete updated[sortMode];
  return updated;
}
