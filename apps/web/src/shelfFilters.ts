import { readingStatus, readingStatusLabel } from "./bookProgress.ts";
import type { ReadingStatus } from "./bookProgress.ts";
import { tagsForBook } from "./bookMetadata.ts";
import type { Book } from "./types.ts";

/**
 * The shelf's filter model.
 *
 * The search box narrows one axis: does this word appear anywhere on the book.
 * These narrow the orthogonal ones — where the book sits in your reading
 * (status), what shelf it belongs to (genre), and which wider world or reading
 * order it is part of (tag) — so "unfinished Cosmere fantasy" is a shelf you can
 * actually reach instead of a query you have to type and hope for.
 */
export type ShelfStatusFilter = ReadingStatus | "all";

export type ShelfFilters = {
  status: ShelfStatusFilter;
  genres: string[];
  tags: string[];
};

/** Which of the two chip groups an action is aimed at. They behave identically. */
export type ShelfFacetGroupKey = "genres" | "tags";

export type ShelfFacetValue = { key: string; label: string };

export type ShelfFacetOption = ShelfFacetValue & { count: number };

export const EMPTY_SHELF_FILTERS: ShelfFilters = { status: "all", genres: [], tags: [] };

export const SHELF_STATUS_OPTIONS: { value: ShelfStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "inProgress", label: readingStatusLabel("inProgress") },
  { value: "notStarted", label: readingStatusLabel("notStarted") },
  { value: "finished", label: readingStatusLabel("finished") }
];

/**
 * How many chips a group shows before it collapses behind "more". Ten is about
 * two rows in the shelf pane — enough to cover the shelves you actually reach
 * for without the panel swallowing the library behind it.
 */
export const SHELF_FACET_PREVIEW_COUNT = 10;

/**
 * Genres and tags are free text typed by whoever edited the book, so "Sci-Fi",
 * "sci-fi" and "Sci-Fi " have to collapse to one chip rather than three. The
 * first spelling seen wins the label; the key is what everything matches on.
 */
export function shelfFacetKey(value: string) {
  return value.trim().toLowerCase();
}

export function shelfFacetValues(values: (string | null | undefined)[]): ShelfFacetValue[] {
  const seen = new Map<string, ShelfFacetValue>();
  for (const value of values) {
    const label = value?.trim();
    if (!label) continue;
    const key = shelfFacetKey(label);
    if (!seen.has(key)) seen.set(key, { key, label });
  }
  return [...seen.values()];
}

export function bookFacetValues(book: Book, group: ShelfFacetGroupKey): ShelfFacetValue[] {
  return group === "genres"
    ? shelfFacetValues(book.genres)
    : shelfFacetValues(tagsForBook(book).map((tag) => tag.name));
}

/**
 * Selections inside a group are an OR — picking Fantasy and Mystery widens the
 * shelf. The groups themselves AND together, which is what makes stacking them
 * useful. An empty group is not a filter at all.
 */
export function bookMatchesFacet(book: Book, group: ShelfFacetGroupKey, selected: string[]) {
  if (selected.length === 0) return true;
  const keys = bookFacetValues(book, group).map((value) => value.key);
  return selected.some((key) => keys.includes(key));
}

export function bookMatchesShelfStatus(book: Book, status: ShelfStatusFilter) {
  return status === "all" || readingStatus(book) === status;
}

/** `query` is already trimmed and lower-cased by the caller; empty matches all. */
export function bookMatchesShelfSearch(book: Book, query: string) {
  if (!query) return true;
  return [
    book.title,
    book.author,
    book.narrator,
    book.metadata.series,
    ...tagsForBook(book).map((tag) => tag.name),
    ...book.genres
  ]
    .filter(Boolean)
    .some((field) => field!.toLowerCase().includes(query));
}

/**
 * Tallies one group's chips over whichever books the *other* filters already
 * allow, so a count reads as "this many if you also pick this" rather than
 * promising books the rest of the panel has ruled out. Callers pass the
 * already-narrowed pool; this only counts it.
 *
 * Busiest shelves come first — the chip you are most likely to want is the one
 * you shouldn't have to hunt for — with alphabetical breaking ties so the order
 * stays put between renders.
 */
export function countShelfFacet(books: Book[], group: ShelfFacetGroupKey): ShelfFacetOption[] {
  const options = new Map<string, ShelfFacetOption>();
  for (const book of books) {
    for (const { key, label } of bookFacetValues(book, group)) {
      const existing = options.get(key);
      if (existing) existing.count += 1;
      else options.set(key, { key, label, count: 1 });
    }
  }
  return [...options.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Keep choices in their library order while other filters change their counts. */
export function updateShelfFacetCounts(
  options: ShelfFacetOption[],
  books: Book[],
  group: ShelfFacetGroupKey
): ShelfFacetOption[] {
  const counts = new Map(countShelfFacet(books, group).map((option) => [option.key, option.count]));
  return options.map((option) => ({ ...option, count: counts.get(option.key) ?? 0 }));
}

/** A selected reading order can be any of a book's tags, not just its first. */
export function tagForShelfSort(book: Book, selected: string[]) {
  const tags = tagsForBook(book);
  for (const key of selected) {
    const tag = tags.find((candidate) => shelfFacetKey(candidate.name) === key);
    if (tag) return tag;
  }
  return tags[0];
}

export function countActiveShelfFilters(filters: ShelfFilters) {
  return (filters.status === "all" ? 0 : 1) + filters.genres.length + filters.tags.length;
}

export function toggleShelfFacet(
  filters: ShelfFilters,
  group: ShelfFacetGroupKey,
  key: string
): ShelfFilters {
  const selected = filters[group];
  return {
    ...filters,
    [group]: selected.includes(key) ? selected.filter((value) => value !== key) : [...selected, key]
  };
}
