import { useEffect, useMemo, useRef, useState } from "react";
import {
  bookSortGroupLabel,
  compareShelfLabels,
  type LibrarySource,
  type ShelfLayout,
  PURCHASE_VIEW_MODE_STORAGE_KEY,
  readStoredPurchaseViewMode,
  readStoredSortMode,
  SHELF_TEXT_COLLATOR,
  type SortMode,
  sortModeStorageKey
} from "./shelfSort";
import { readStoredValue, writeStoredValue } from "./appStorage";
import { runShelfLayoutTransition } from "./shelfTransition";
import { readStoredShelfViewMode, type ShelfViewMode, writeStoredShelfViewMode } from "./shelfView";
import {
  bookMatchesFacet,
  bookMatchesShelfDownload,
  bookMatchesShelfReading,
  bookReadingAvailability,
  SHELF_READING_OPTIONS,
  bookMatchesShelfSearch,
  bookMatchesShelfStatus,
  compareShelfAddedAt,
  countActiveShelfFilters,
  countShelfFacet,
  EMPTY_SHELF_FILTERS,
  shelfSearchWords,
  type ShelfFacetGroupKey,
  type ShelfFilters,
  type ShelfStatusFilter,
  tagForShelfSort,
  toggleShelfFacet,
  updateShelfFacetCounts
} from "./shelfFilters";
import { LANDSCAPE_QUERY, readLandscape, readShortLandscape, SHORT_LANDSCAPE_QUERY } from "./useOrientation";
import type { DeviceFoldState } from "./deviceFold";
import type { Book } from "./types";
import { compareReadingStatus, readingStatus, readingStatusLabel } from "./bookProgress";

// The window size at which an iPad opens into the two-page spread.
const SHELF_SPREAD_QUERY = "(min-width: 720px) and (min-height: 500px)";

export function useShelf({
  books,
  demoMode,
  downloadedBookIds,
  ipad,
  librarySource,
  localMode,
  native,
  playbackFold,
  sentenceFollowAvailable
}: {
  books: Book[];
  demoMode: boolean;
  downloadedBookIds: Set<string>;
  ipad: boolean;
  librarySource: LibrarySource;
  localMode: boolean;
  native: boolean;
  playbackFold: DeviceFoldState;
  sentenceFollowAvailable: boolean;
}) {
  const [sortMode, setSortMode] = useState<SortMode>(() => readStoredSortMode("local"));
  const [sortReversed, setSortReversed] = useState(() => readStoredValue("operalibre.sortReversed.local") === "true");
  // An iPad wide enough for the spread opens on the Shelf tab's full
  // collection; restoring a book to play or read brings the spread back.
  const [startsOnFullShelf] = useState(() => native && ipad && window.matchMedia(SHELF_SPREAD_QUERY).matches);
  const [viewMode, setViewMode] = useState<ShelfViewMode>(() => startsOnFullShelf ? "grid" : readStoredShelfViewMode());
  const [purchaseViewMode, setPurchaseViewMode] = useState<ShelfViewMode>(readStoredPurchaseViewMode);
  // iPad's two-page Shelf can give the whole screen to either page: the
  // player alone, or the collection alone at its larger grid.
  const [shelfLayout, setShelfLayout] = useState<ShelfLayout>(startsOnFullShelf ? "library" : "split");
  const [wideShelf, setWideShelf] = useState(() => native && window.matchMedia(SHELF_SPREAD_QUERY).matches);
  // Where the spread shows, the Shelf and Reading tabs choose its layout
  // rather than a page (see spreadTab).
  const shelfSpread = native && ipad && wideShelf;
  // The view the collection had before it was widened, restored when it
  // folds back, so the grid it widens into never replaces a saved choice.
  const viewBeforeWideShelfRef = useRef<ShelfViewMode | null>(startsOnFullShelf ? readStoredShelfViewMode() : null);
  const [searchQuery, setSearchQuery] = useState("");
  const shelfSearchRef = useRef<HTMLInputElement | null>(null);
  const [shelfFilters, setShelfFilters] = useState<ShelfFilters>(EMPTY_SHELF_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterToggleRef = useRef<HTMLButtonElement | null>(null);

  // Restores whatever sort was last chosen for this shelf rather than collapsing to
  // "title": each source keeps its own persisted sort (see readStoredSortMode).
  useEffect(() => {
    setSortMode(readStoredSortMode(librarySource));
    setSortReversed(readStoredValue(`operalibre.sortReversed.${librarySource}`) === "true");
  }, [librarySource]);

  function selectSortMode(mode: SortMode) {
    setSortMode(mode);
    writeStoredValue(sortModeStorageKey(librarySource), mode);
  }

  function reverseSort() {
    setSortReversed(!sortReversed);
    writeStoredValue(`operalibre.sortReversed.${librarySource}`, String(!sortReversed));
  }

  function selectViewMode(mode: ShelfViewMode) {
    viewBeforeWideShelfRef.current = null;
    setViewMode(mode);
    writeStoredShelfViewMode(mode);
  }

  function selectPurchaseViewMode(mode: ShelfViewMode) {
    setPurchaseViewMode(mode);
    writeStoredValue(PURCHASE_VIEW_MODE_STORAGE_KEY, mode);
  }

  function changeShelfLayout(next: ShelfLayout, animate = true, update?: () => void) {
    if (next === shelfLayout) {
      update?.();
      return;
    }
    const apply = () => {
      if (next === "library") {
        viewBeforeWideShelfRef.current = viewMode;
        setViewMode("grid");
      } else if (shelfLayout === "library" && viewBeforeWideShelfRef.current) {
        setViewMode(viewBeforeWideShelfRef.current);
        viewBeforeWideShelfRef.current = null;
      }
      setShelfLayout(next);
      update?.();
    };
    if (animate) runShelfLayoutTransition(document.documentElement, shelfLayout, next, apply);
    else apply();
  }

  useEffect(() => {
    if (!native) return;
    const wideShelf = window.matchMedia(SHELF_SPREAD_QUERY);
    const restoreSplitLayout = () => {
      setWideShelf(wideShelf.matches);
      if (wideShelf.matches || shelfLayout === "split") return;
      if (shelfLayout === "library" && viewBeforeWideShelfRef.current) {
        setViewMode(viewBeforeWideShelfRef.current);
        viewBeforeWideShelfRef.current = null;
      }
      setShelfLayout("split");
    };
    restoreSplitLayout();
    wideShelf.addEventListener("change", restoreSplitLayout);
    return () => wideShelf.removeEventListener("change", restoreSplitLayout);
  }, [native, shelfLayout]);

  // Landscape shelves trade chrome for covers: a phone on its side, or an
  // iPad in landscape, gets the dense book wall, and any shelf wide enough
  // to run its controls along one toolbar folds its header into it.
  const [landscape, setLandscape] = useState(() => readLandscape());
  const [shortLandscape, setShortLandscape] = useState(() => readShortLandscape());
  useEffect(() => {
    if (!native) return;
    const wide = window.matchMedia(LANDSCAPE_QUERY);
    const short = window.matchMedia(SHORT_LANDSCAPE_QUERY);
    const update = () => {
      setLandscape(wide.matches);
      setShortLandscape(short.matches);
    };
    update();
    wide.addEventListener("change", update);
    short.addEventListener("change", update);
    return () => {
      wide.removeEventListener("change", update);
      short.removeEventListener("change", update);
    };
  }, [native]);
  const shelfLandscape = native && landscape && (ipad || shortLandscape);
  const shelfFolded = native && ((!ipad && shortLandscape) || shelfLayout === "library");

  function closeShelfFilters() {
    setFiltersOpen(false);
    filterToggleRef.current?.focus();
  }

  const sortOrderLabel = sortMode === "duration"
    ? sortReversed ? "Shortest first" : "Longest first"
    : sortMode === "added"
    ? sortReversed ? "Oldest first" : "Newest first"
    : sortMode === "progress"
      ? sortReversed ? "Finished first" : "In progress first"
      : sortMode === "tag" || sortMode === "series"
        ? sortReversed ? "Reverse book order" : "Book order"
        : sortReversed ? "Z–A" : "A–Z";

  const allShelfFacets = useMemo(() => ({
    genres: countShelfFacet(books, "genres"),
    tags: countShelfFacet(books, "tags")
  }), [books]);

  // Each book scored once against every filter axis separately. Keeping the
  // verdicts apart is what lets the panel count a group over the books the
  // *other* groups allow without walking the library again per chip.
  const shelfMatches = useMemo(() => {
    const query = shelfSearchWords(searchQuery);
    return books.map((book) => ({
      book,
      search: bookMatchesShelfSearch(book, query),
      status: bookMatchesShelfStatus(book, shelfFilters.status),
      availableOnDevice:
        demoMode
        || localMode
        || book.source === "device"
        || !!book.deviceBookId
        || downloadedBookIds.has(book.id),
      readAlong: bookMatchesShelfReading(book, shelfFilters.reading, sentenceFollowAvailable),
      genres: bookMatchesFacet(book, "genres", shelfFilters.genres),
      tags: bookMatchesFacet(book, "tags", shelfFilters.tags)
    })).map((match) => ({
      ...match,
      downloaded: bookMatchesShelfDownload(match.availableOnDevice, shelfFilters.downloadedOnly)
    }));
  }, [books, demoMode, downloadedBookIds, localMode, searchQuery, sentenceFollowAvailable, shelfFilters]);

  const shelfFacets = useMemo(() => {
    const forGenres: Book[] = [];
    const forTags: Book[] = [];
    const statusCounts: Record<ShelfStatusFilter, number> = {
      all: 0,
      inProgress: 0,
      notStarted: 0,
      finished: 0
    };
    let downloadedCount = 0;
    const readingCounts = { ebook: 0, followAlong: 0 };
    for (const match of shelfMatches) {
      if (match.search && match.status && match.tags && match.downloaded && match.readAlong) forGenres.push(match.book);
      if (match.search && match.status && match.genres && match.downloaded && match.readAlong) forTags.push(match.book);
      if (match.search && match.genres && match.tags && match.downloaded && match.readAlong) {
        statusCounts.all += 1;
        statusCounts[readingStatus(match.book)] += 1;
      }
      if (match.search && match.status && match.genres && match.tags && match.readAlong && match.availableOnDevice) {
        downloadedCount += 1;
      }
      if (match.search && match.status && match.genres && match.tags && match.downloaded) {
        const availability = bookReadingAvailability(match.book, sentenceFollowAvailable);
        if (availability !== "none") readingCounts[availability] += 1;
      }
    }
    return {
      genres: updateShelfFacetCounts(allShelfFacets.genres, forGenres, "genres"),
      tags: updateShelfFacetCounts(allShelfFacets.tags, forTags, "tags"),
      statusCounts,
      downloadedCount,
      readingCounts
    };
  }, [allShelfFacets, sentenceFollowAvailable, shelfMatches]);

  const activeShelfFilterCount = countActiveShelfFilters(shelfFilters);
  // Genres, tags and progress are all things only your own shelf records; the
  // Audible list keeps its account filter instead. Any shelf with books on it
  // can be filtered — every book has a reading status even when nothing has
  // been given a genre or a tag yet, so this is deliberately not gated on the
  // two chip groups having something in them. Hiding the control until the
  // metadata showed up only made it missing whenever someone went looking.
  const showShelfFilters = librarySource === "local" && books.length > 0;

  // Reads back the chips that are on, so the summary line under the toolbar can
  // name a filter and drop it without the panel being open.
  const activeShelfFilterChips = useMemo(() => {
    const chips: { id: string; caption: string; label: string; clear: () => void }[] = [];
    if (shelfFilters.status !== "all") {
      chips.push({
        id: `status:${shelfFilters.status}`,
        caption: "Status",
        label: readingStatusLabel(shelfFilters.status),
        clear: () => setShelfFilters((filters) => ({ ...filters, status: "all" }))
      });
    }
    if (shelfFilters.downloadedOnly) {
      chips.push({
        id: "availability:downloaded",
        caption: "Availability",
        label: "Downloaded on Device",
        clear: () => setShelfFilters((filters) => ({ ...filters, downloadedOnly: false }))
      });
    }
    if (shelfFilters.reading !== "all") {
      chips.push({
        id: `availability:${shelfFilters.reading}`,
        caption: "Availability",
        label: SHELF_READING_OPTIONS.find((option) => option.value === shelfFilters.reading)!.label,
        clear: () => setShelfFilters((filters) => ({ ...filters, reading: "all" }))
      });
    }
    for (const group of ["genres", "tags"] as ShelfFacetGroupKey[]) {
      const caption = group === "genres" ? "Genre" : "Tag";
      for (const key of shelfFilters[group]) {
        // Keep a removed/renamed value removable until the reader clears it.
        const label = shelfFacets[group].find((option) => option.key === key)?.label ?? key;
        chips.push({
          id: `${group}:${key}`,
          caption,
          label,
          clear: () => setShelfFilters((filters) => toggleShelfFacet(filters, group, key))
        });
      }
    }
    return chips;
  }, [shelfFacets, shelfFilters]);

  function clearShelfFilters() {
    setShelfFilters(EMPTY_SHELF_FILTERS);
  }

  const visibleBooks = useMemo(() => {
    const filtered = shelfMatches
      .filter((match) => match.search && match.status && match.downloaded && match.readAlong && match.genres && match.tags)
      .map((match) => match.book);

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortMode) {
        case "author":
          return SHELF_TEXT_COLLATOR.compare(a.author ?? "", b.author ?? "") || SHELF_TEXT_COLLATOR.compare(a.title, b.title);
        case "series":
          return compareShelfLabels(a.metadata.series, b.metadata.series)
            || compareShelfLabels(a.metadata.seriesPosition, b.metadata.seriesPosition)
            || SHELF_TEXT_COLLATOR.compare(a.title, b.title);
        case "tag": {
          const aTag = tagForShelfSort(a, shelfFilters.tags);
          const bTag = tagForShelfSort(b, shelfFilters.tags);
          return compareShelfLabels(aTag?.name, bTag?.name)
            || compareShelfLabels(aTag?.position, bTag?.position)
            || SHELF_TEXT_COLLATOR.compare(a.title, b.title);
        }
        case "genre":
          return compareShelfLabels(a.genres[0], b.genres[0]) || SHELF_TEXT_COLLATOR.compare(a.title, b.title);
        case "progress":
          return compareReadingStatus(a, b) || SHELF_TEXT_COLLATOR.compare(a.title, b.title);
        case "duration":
          return (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0);
        case "added":
          // A book cached or imported before this field existed has no addedAt
          // once it round-trips through storage, even though the type says it
          // always does; treat that as the oldest possible addition.
          return compareShelfAddedAt(a.addedAt, b.addedAt) || SHELF_TEXT_COLLATOR.compare(a.title, b.title);
        case "title":
        default:
          return SHELF_TEXT_COLLATOR.compare(a.title, b.title);
      }
    });
    return sortReversed ? sorted.reverse() : sorted;
  }, [shelfMatches, shelfFilters.tags, sortMode, sortReversed]);

  const visibleBookRuns = useMemo(() => {
    const runs: Array<{
      label: string | null;
      items: Array<{ book: (typeof visibleBooks)[number]; index: number }>;
    }> = [];
    visibleBooks.forEach((book, index) => {
      const label = bookSortGroupLabel(book, sortMode, shelfFilters.tags);
      const previous = runs[runs.length - 1];
      if (label && previous?.label && compareShelfLabels(label, previous.label) === 0) {
        previous.items.push({ book, index });
      } else {
        runs.push({ label, items: [{ book, index }] });
      }
    });
    return runs;
  }, [shelfFilters.tags, sortMode, visibleBooks]);

  const splitShelfIntoLeaves = native && playbackFold.posture !== "closed" && playbackFold.fold?.axis === "vertical";
  const visibleBookColumns = useMemo(() => {
    if (!splitShelfIntoLeaves) return [visibleBookRuns];
    const columns: typeof visibleBookRuns[] = [[], []];
    const weights = [0, 0];
    for (const run of visibleBookRuns) {
      const column = weights[0] <= weights[1] ? 0 : 1;
      columns[column].push(run);
      weights[column] += run.items.length + 0.5;
    }
    return columns;
  }, [splitShelfIntoLeaves, visibleBookRuns]);

  return {
    activeShelfFilterChips,
    activeShelfFilterCount,
    changeShelfLayout,
    clearShelfFilters,
    closeShelfFilters,
    filterToggleRef,
    filtersOpen,
    purchaseViewMode,
    reverseSort,
    searchQuery,
    selectPurchaseViewMode,
    selectSortMode,
    selectViewMode,
    sentenceFollowAvailable,
    setFiltersOpen,
    setSearchQuery,
    setShelfFilters,
    shelfFacets,
    shelfFilters,
    shelfFolded,
    shelfLandscape,
    shelfLayout,
    shelfSpread,
    shelfSearchRef,
    showShelfFilters,
    sortMode,
    sortOrderLabel,
    sortReversed,
    viewMode,
    visibleBookColumns,
    visibleBooks
  };
}
