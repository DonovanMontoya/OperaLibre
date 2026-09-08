/**
 * How dense the shelf's rows are.
 *
 * "list" is the roomy default: a row per book with its runtime, read-along and
 * shared-reader badges, which is what browsing a shelf you can see all of wants.
 * "compact" keeps the same rows and takes the air out — title, byline, progress
 * — so a library of hundreds is a scroll rather than an expedition. "grid" is
 * covers.
 */
export type ShelfViewMode = "list" | "compact" | "grid";

export const SHELF_VIEW_MODE_STORAGE_KEY = "operalibre.viewMode";

export const SHELF_VIEW_MODE_OPTIONS: { value: ShelfViewMode; label: string }[] = [
  { value: "list", label: "List view" },
  { value: "compact", label: "Compact view" },
  { value: "grid", label: "Grid view" }
];

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function readShelfViewMode(storage: StorageReader): ShelfViewMode {
  const stored = storage.getItem(SHELF_VIEW_MODE_STORAGE_KEY);
  return SHELF_VIEW_MODE_OPTIONS.some((option) => option.value === stored)
    ? (stored as ShelfViewMode)
    : "list";
}

export function writeShelfViewMode(storage: StorageWriter, mode: ShelfViewMode): void {
  storage.setItem(SHELF_VIEW_MODE_STORAGE_KEY, mode);
}

/**
 * Density is a habit, not a per-visit decision — someone who runs a big shelf
 * compact wants it compact at the next launch too. Blocked site data throws on
 * the mere touch of localStorage, and the shelf still has to paint, so that
 * reads as the roomy default.
 */
export function readStoredShelfViewMode(): ShelfViewMode {
  try {
    return readShelfViewMode(window.localStorage);
  } catch {
    return "list";
  }
}

export function writeStoredShelfViewMode(mode: ShelfViewMode): void {
  try {
    writeShelfViewMode(window.localStorage, mode);
  } catch {
    // A shelf that cannot remember its density still shows the one you picked.
  }
}
