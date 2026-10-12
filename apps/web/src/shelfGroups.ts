// Group headings the reader has folded away, per grouping sort, so collapsing a
// series under Series leaves the same name alone under Tag. Kept on the device:
// it is how this screen is arranged, not something another device should inherit.
export const SHELF_COLLAPSED_GROUPS_STORAGE_KEY = "operalibre.collapsedShelfGroups";

export type CollapsedShelfGroups = Record<string, string[]>;

type ShelfGroupStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

// Runs merge labels the way compareShelfLabels does — ignoring case and accents —
// so "Harry Potter" and "harry potter" are one heading and must fold together.
export function shelfGroupKey(label: string) {
  return label.trim().normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

export function readCollapsedShelfGroups(storage: Pick<ShelfGroupStorage, "getItem">): CollapsedShelfGroups {
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

export function writeCollapsedShelfGroups(storage: Pick<ShelfGroupStorage, "setItem">, groups: CollapsedShelfGroups) {
  try {
    storage.setItem(SHELF_COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Storage unavailable or full — the headings just open expanded next time.
  }
}

export function isShelfGroupCollapsed(groups: CollapsedShelfGroups, sortMode: string, label: string) {
  return groups[sortMode]?.includes(shelfGroupKey(label)) ?? false;
}

export function toggleCollapsedShelfGroup(groups: CollapsedShelfGroups, sortMode: string, label: string): CollapsedShelfGroups {
  const key = shelfGroupKey(label);
  const current = groups[sortMode] ?? [];
  const next = current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key];
  const updated = { ...groups, [sortMode]: next };
  if (!next.length) delete updated[sortMode];
  return updated;
}
