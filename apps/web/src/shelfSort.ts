import { readingStatus, readingStatusLabel } from "./bookProgress";
import { SHELF_VIEW_MODE_OPTIONS, type ShelfViewMode } from "./shelfView";
import { tagForShelfSort } from "./shelfFilters";
import type { Book } from "./types";
import { readStoredValue } from "./appStorage";

export type SortMode = "title" | "author" | "series" | "tag" | "genre" | "progress" | "duration" | "account" | "added";
export type LibrarySource = "local" | "audible" | "libro" | "all";

export const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "title", label: "Title" },
  { value: "author", label: "Author" },
  { value: "series", label: "Series" },
  { value: "tag", label: "Tag" },
  { value: "genre", label: "Genre" },
  { value: "progress", label: "Progress" },
  { value: "account", label: "Account" },
  { value: "duration", label: "Length" },
  { value: "added", label: "Newest" }
];

const SORT_MODE_STORAGE_KEY = "operalibre.sortMode";
export const PURCHASE_VIEW_MODE_STORAGE_KEY = "operalibre.purchaseViewMode";
const LIBRARY_SOURCES: LibrarySource[] = ["local", "audible", "libro", "all"];

export function readStoredPurchaseViewMode(): ShelfViewMode {
  const stored = readStoredValue(PURCHASE_VIEW_MODE_STORAGE_KEY);
  return SHELF_VIEW_MODE_OPTIONS.some((option) => option.value === stored)
    ? (stored as ShelfViewMode)
    : "list";
}

// "account" only makes sense for the Audible shelf; "series"/"genre"/"progress" only
// for the local library — an Audible row is a purchase that has not been downloaded yet,
// so it carries no progress to sort on. Sort mode is persisted per source so switching
// shelves — including across restarts, since librarySource itself always starts back at
// "local" — restores what was last chosen there instead of permanently collapsing to
// "title".
const AUDIBLE_ONLY_SORT_MODES: SortMode[] = ["account"];
const LOCAL_ONLY_SORT_MODES: SortMode[] = ["series", "tag", "genre", "progress", "added"];

export function isSortModeSupported(source: LibrarySource, mode: SortMode) {
  if (source === "libro" || source === "all") return ["title", "author", "duration"].includes(mode);
  const unsupported = source === "local" ? AUDIBLE_ONLY_SORT_MODES : LOCAL_ONLY_SORT_MODES;
  return !unsupported.includes(mode);
}

export function sortModeStorageKey(source: LibrarySource) {
  return `${SORT_MODE_STORAGE_KEY}.${source}`;
}

// Sort mode used to live in a single shared key. Seed each per-source key from it once so
// an existing choice survives the upgrade instead of silently resetting to "title".
let legacySortModeMigrated = false;

function migrateLegacySortMode() {
  // Runs from a useState initializer, so a storage failure here would throw during render
  // and blank the app. A lost sort preference is not worth that; swallow and move on. The
  // legacy key is only dropped once the per-source keys are actually written.
  try {
    const legacy = window.localStorage.getItem(SORT_MODE_STORAGE_KEY);
    if (legacy === null) return;
    if (SORT_OPTIONS.some((option) => option.value === legacy)) {
      for (const source of LIBRARY_SOURCES) {
        if (window.localStorage.getItem(sortModeStorageKey(source)) !== null) continue;
        if (!isSortModeSupported(source, legacy as SortMode)) continue;
        window.localStorage.setItem(sortModeStorageKey(source), legacy);
      }
    }
    window.localStorage.removeItem(SORT_MODE_STORAGE_KEY);
  } catch {
    // Storage unavailable or full — the shelf just opens on the default sort.
  }
}

export function readStoredSortMode(source: LibrarySource): SortMode {
  if (!legacySortModeMigrated) {
    legacySortModeMigrated = true;
    migrateLegacySortMode();
  }
  // Storage unavailable reads as null — the shelf opens on the default sort.
  const stored = readStoredValue(sortModeStorageKey(source));
  const isValid = SORT_OPTIONS.some((option) => option.value === stored)
    && isSortModeSupported(source, stored as SortMode);
  return isValid ? (stored as SortMode) : "title";
}

// Built once: localeCompare constructs a collator on every call, and sorting a
// large shelf compares thousands of times.
const SHELF_LABEL_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const SHELF_TEXT_COLLATOR = new Intl.Collator();

export function compareShelfLabels(left: string | null | undefined, right: string | null | undefined) {
  const a = left?.trim() ?? "";
  const b = right?.trim() ?? "";
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return SHELF_LABEL_COLLATOR.compare(a, b);
}

export function bookSortGroupLabel(book: Book, sortMode: SortMode, selectedTags: string[]) {
  if (sortMode === "series") return book.metadata.series?.trim() || "Standalone";
  if (sortMode === "tag") return tagForShelfSort(book, selectedTags)?.name.trim() || "Untagged";
  if (sortMode === "genre") return book.genres[0]?.trim() || "Uncategorized";
  if (sortMode === "progress") return readingStatusLabel(readingStatus(book));
  return null;
}

// The caption above each run of rows, naming what the run is grouped by. Only the
// modes bookSortGroupLabel groups ever reach this.
export function bookSortGroupCaption(sortMode: SortMode) {
  if (sortMode === "series") return "Series";
  if (sortMode === "tag") return "Tag";
  if (sortMode === "genre") return "Genre";
  return "Progress";
}
