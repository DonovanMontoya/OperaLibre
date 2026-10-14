import { BookHeadphones, BookOpen, Check, ChevronDown, Cloud, Images, Search, Smartphone, Timer, TriangleAlert, Users } from "lucide-react";
import { hasExtras } from "./readalong";
import { memo, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { compactProgressLabel } from "./bookProgress";
import type { ShelfViewMode } from "./shelfView";
import { bookReadingAvailability, SHELF_FACET_PREVIEW_COUNT, type ShelfFacetOption, type ShelfFilters, tagForShelfSort } from "./shelfFilters";
import type { Book } from "./types";
import { summarizeSharedProgress } from "./sharedProgress";
import { bookSortGroupCaption, shelfLetterIndex, type SortMode } from "./shelfSort";
import { bookProgressLabel, bookSubtitle, durationFromTracks, formatDurationLabel } from "./formatting";
import { CoverArt } from "./CoverArt";
import type { OfflineReadiness } from "./offlineReadiness";

/**
 * One column of the filter panel: a heading and a cloud of toggleable chips.
 * Genre and tag are the same control twice over, so they share this rather than
 * diverging the moment one of them grows a feature.
 */
export function ShelfFacetGroup({
  title,
  hint,
  options,
  selected,
  onToggle
}: {
  title: string;
  hint: string;
  options: ShelfFacetOption[];
  selected: string[];
  onToggle: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const matching = options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()));
  // A chosen chip survives the collapse even when it sits past the preview, so a
  // filter can always be undone where it was set rather than only after
  // expanding a list you may not remember choosing from.
  const visible = expanded || query.trim()
    ? matching
    : matching.filter((option, index) => index < SHELF_FACET_PREVIEW_COUNT || selected.includes(option.key));
  const hiddenCount = matching.length - visible.length;

  return (
    <div className="shelf-facet">
      <div className="shelf-facet-heading">
        <span className="shelf-facet-title">{title}</span>
        {selected.length > 0 ? <span className="shelf-facet-count">{selected.length} selected</span> : null}
      </div>
      {options.length > SHELF_FACET_PREVIEW_COUNT ? (
        <label className="shelf-facet-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            aria-label={`Find ${title.toLowerCase()}`}
            placeholder={`Find ${title.toLowerCase()}…`}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      ) : null}
      {options.length === 0 ? (
        <p className="shelf-facet-hint">{hint}</p>
      ) : (
        <>
          <div className="shelf-facet-chips" role="group" aria-label={`Filter by ${title.toLowerCase()}`}>
            {visible.map((option) => {
              const isSelected = selected.includes(option.key);
              // Zero means this chip adds nothing under the filters already set.
              // It stays put, dimmed, rather than vanishing and shuffling every
              // other chip out from under the pointer.
              const isEmpty = option.count === 0 && !isSelected;
              return (
                <button
                  type="button"
                  key={option.key}
                  className={`facet-chip ${isSelected ? "selected" : ""}`}
                  aria-pressed={isSelected}
                  disabled={isEmpty}
                  onClick={() => onToggle(option.key)}
                >
                  {isSelected ? <Check size={11} strokeWidth={2.5} aria-hidden="true" /> : null}
                  <span className="facet-chip-label">{option.label}</span>
                  <em>{option.count}</em>
                </button>
              );
            })}
          </div>
          {matching.length === 0 ? <p className="shelf-facet-hint">No {title.toLowerCase()} match “{query.trim()}”.</p> : null}
          {!query.trim() && (hiddenCount > 0 || expanded) ? (
            <button type="button" className="shelf-facet-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show fewer" : `${hiddenCount} more`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

type ShelfRun = { label: string | null; collapsed: boolean; items: Array<{ book: Book; index: number }> };

const letterName = (letter: string) => letter === "#" ? "Numbers and symbols" : letter;

/**
 * The A–Z strip beside a lettered shelf. Tapping or dragging along it brings
 * that letter's books to the top, and the letter being read is marked.
 */
const ShelfLetterIndex = memo(function ShelfLetterIndex({ headings, reversed }: { headings: string[]; reversed: boolean }) {
  const navRef = useRef<HTMLElement>(null);
  const lastJump = useRef("");
  const strip = useRef<{ top: number; height: number } | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const letters = useMemo(() => shelfLetterIndex(headings, reversed), [headings, reversed]);
  const current = reading !== null && headings.includes(reading) ? reading : headings[0];

  const section = (letter: string) => navRef.current?.parentElement
    ?.querySelector<HTMLElement>(`[data-letter="${CSS.escape(letter)}"]`);

  useEffect(() => {
    // The letter being read is the first with books still below the top of
    // the page, so the opening letter is marked before anything has moved.
    const inView = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const letter = (entry.target as HTMLElement).dataset.letter!;
        if (entry.isIntersecting) inView.add(letter);
        else inView.delete(letter);
      }
      setReading(headings.find(letter => inView.has(letter)) ?? null);
    }, { rootMargin: "-80px 0px 0px 0px" });
    for (const letter of headings) {
      const target = section(letter);
      if (target) observer.observe(target);
    }
    return () => observer.disconnect();
  }, [headings]);

  function jump(letter: string) {
    if (letter === lastJump.current || !headings.includes(letter)) return;
    lastJump.current = letter;
    section(letter)?.scrollIntoView({ block: "start" });
  }

  // A finger drawn down the strip moves through the letters. The strip is
  // measured once as the finger lands: the page moving under a jump can carry
  // the strip with it, and the letters must not slide out from under the hand.
  function scrub(event: PointerEvent<HTMLElement>) {
    if (event.type === "pointerdown") {
      const { top, height } = event.currentTarget.getBoundingClientRect();
      strip.current = { top, height };
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (!strip.current) return;
    const row = Math.floor((event.clientY - strip.current.top) / strip.current.height * letters.length);
    jump(letters[Math.min(letters.length - 1, Math.max(0, row))]);
  }

  function lift() {
    strip.current = null;
    lastJump.current = "";
  }

  return (
    <nav
      ref={navRef}
      className="book-letter-index"
      aria-label="Jump to a letter"
      onPointerDown={scrub}
      onPointerMove={scrub}
      onPointerUp={lift}
      onPointerCancel={lift}
    >
      {letters.map(letter => (
        <button
          type="button"
          key={letter}
          data-jump={letter}
          aria-label={letterName(letter)}
          aria-current={letter === current ? "true" : undefined}
          disabled={!headings.includes(letter)}
          onClick={() => { lastJump.current = ""; jump(letter); }}
        >
          {letter}
        </button>
      ))}
    </nav>
  );
});

/**
 * The shelf's book rows. Memoized because the rest of MainApp re-renders on
 * every media clock tick, and a large library's rows (covers, icons, labels)
 * are the costliest thing on screen that never depends on the position. Every
 * prop here stays referentially stable while a book plays.
 */
export const ShelfBookList = memo(function ShelfBookList({
  columns,
  viewMode,
  sortMode,
  lettered,
  sortReversed,
  shelfTags,
  selectedBookId,
  playbackBookId,
  downloadedBookIds,
  offlineReadiness,
  isOffline,
  demoMode,
  localMode,
  native,
  readalongEnabled,
  sentenceFollowAvailable,
  onSelectBook,
  onToggleGroup
}: {
  columns: ShelfRun[][];
  viewMode: ShelfViewMode;
  sortMode: SortMode;
  lettered: boolean;
  sortReversed: boolean;
  shelfTags: ShelfFilters["tags"];
  selectedBookId: string | null;
  playbackBookId: string | null;
  downloadedBookIds: Set<string>;
  offlineReadiness: Record<string, OfflineReadiness>;
  isOffline: boolean;
  demoMode: boolean;
  localMode: boolean;
  native: boolean;
  readalongEnabled: boolean;
  sentenceFollowAvailable: boolean;
  onSelectBook: (book: Book) => void;
  onToggleGroup: (label: string) => void;
}) {
  const isCompactView = viewMode === "compact";
  // A tile keeps one line for its facts, so what a row spells out is a glyph
  // there; the wording stays on the tooltip.
  const isGridView = viewMode === "grid";
  const glyphTags = isCompactView || isGridView;
  const letterHeadings = useMemo(() => lettered
    ? [...new Set(columns.flat().map(run => run.label ?? "#"))]
    : [], [columns, lettered]);
  // A series or a tag's reading order is a sequence; the books left over
  // under "Standalone" or "Untagged", and every genre or status, are not.
  const isSequence = (book: Book) => sortMode === "series" ? !!book.metadata.series?.trim()
    : sortMode === "tag" && !!tagForShelfSort(book, shelfTags);
  return (
    <div className={`book-list ${viewMode === "grid" ? "is-grid" : viewMode === "compact" ? "is-list is-compact" : "is-list"} ${lettered ? "is-lettered" : ""}`}>
      {columns.map((column, columnIndex) => (
        <div className="book-leaf" key={`leaf-${columnIndex}`}>
        {column.map((run) => (
        <section className={`book-sort-run ${run.collapsed ? "is-collapsed" : ""} ${isSequence(run.items[0].book) ? "is-sequence" : ""}`} key={`${run.label ?? "book"}-${run.items[0].book.id}`} data-letter={lettered ? run.label ?? undefined : undefined}>
          {lettered ? (
            <div className="book-letter" role="heading" aria-level={2} aria-label={`${letterName(run.label!)}, ${run.items.length} ${run.items.length === 1 ? "book" : "books"}`}>
              <strong>{run.label}</strong>
              <em>{run.items.length}</em>
            </div>
          ) : run.label ? (
            <div className="book-sort-group" role="heading" aria-level={2}>
              <button
                type="button"
                className="book-sort-group-toggle"
                aria-expanded={!run.collapsed}
                onClick={() => onToggleGroup(run.label!)}
              >
                <ChevronDown className="book-sort-group-chevron" size={13} strokeWidth={2} aria-hidden="true" />
                <span>{bookSortGroupCaption(sortMode)}</span>
                <strong>{run.label}</strong>
                <em>{run.items.length} {run.items.length === 1 ? "book" : "books"}</em>
              </button>
            </div>
          ) : null}
          {run.collapsed ? null : <div className="book-run-books">{run.items.map(({ book, index }) => {
        const progressPercent = book.progress?.percentComplete ?? 0;
        const availableOnDevice =
          demoMode
          || localMode
          || book.source === "device"
          || !!book.deviceBookId
          || downloadedBookIds.has(book.id);
        const availableOnServer = !demoMode && !localMode && book.source !== "device";
        const hasMissingOfflineFiles = downloadedBookIds.has(book.id) && book.source !== "device" && !book.deviceBookId && !demoMode && !localMode
          && !!offlineReadiness[book.id]?.missingFiles.length;
        const availabilityLabel = availableOnDevice
          ? availableOnServer
            ? "Available on the server and this device"
            : "Available on this device"
          : "Available from the server";
        const availabilityTitle = hasMissingOfflineFiles
          ? `${availabilityLabel}. Some offline files are missing. Open book details to retry.`
          : availabilityLabel;
        const unavailableOffline = isOffline && !availableOnDevice;
        const shared = isCompactView ? null : summarizeSharedProgress(book.sharedProgress);
        // Compact abbreviates the chip and drops it entirely for a book
        // nobody has opened; the full wording stays on the tooltip so
        // shortening it costs a screen reader nothing.
        const progressLabel = isCompactView ? compactProgressLabel(book) : bookProgressLabel(book);
        const compactProgressTitle = isCompactView ? bookProgressLabel(book) : undefined;
        const followAlong = bookReadingAvailability(book, sentenceFollowAvailable) === "followAlong";
        const readingLabel = followAlong ? "Follow along" : "Ebook";
        const readingTitle = followAlong ? "Synced ebook: text follows the audio" : "Ebook included: read beside the audio";
        const sortTag = tagForShelfSort(book, shelfTags);
        return (
            <button
              key={book.id}
              className={`book-row ${book.id === selectedBookId ? "active" : ""} ${book.id === playbackBookId ? "playing" : ""} ${book.progress?.status === "inProgress" ? "in-progress" : ""} ${unavailableOffline ? "offline-unavailable" : ""} ${hasMissingOfflineFiles ? "has-offline-warning" : ""}`}
              onClick={() => onSelectBook(book)}
            >
              {native || viewMode === "grid" || book.coverArtUrl ? (
                <CoverArt book={book} size="small" />
              ) : (
                <span className="index">{String(index + 1).padStart(2, "0")}</span>
              )}
              <span
                className={`book-availability ${availableOnDevice ? "has-device-copy" : "server-only"} ${
                  availableOnServer && availableOnDevice ? "server-and-device" : ""
                }`}
                role="img"
                aria-label={availabilityTitle}
                title={availabilityTitle}
              >
                {availableOnServer ? <Cloud className="server-availability-icon" size={13} strokeWidth={1.8} /> : null}
                {availableOnDevice ? <Smartphone className="device-availability-icon" size={13} strokeWidth={1.8} /> : null}
                {hasMissingOfflineFiles ? <TriangleAlert className="offline-warning-icon" size={13} strokeWidth={1.8} aria-hidden="true" /> : null}
              </span>
              {/* Compact drops the badge row — runtime, shared readers,
                  series position — and keeps title, byline and progress.
                  Those tags are what a browsing row is for; a row you are
                  scanning past a hundred of is not. Read along survives as
                  a bare glyph: unlike the rest it has no other home on the
                  shelf, so dropping it would make "does this one have the
                  text?" unanswerable without opening every book. */}
              <span className="book-text">
                <strong>{book.title}</strong>
                <span>{bookSubtitle(book) || `${book.trackCount} track${book.trackCount === 1 ? "" : "s"}`}</span>
                {!isCompactView && sortMode === "series" && book.metadata.seriesPosition ? (
                  <span className="book-sort-context">Book {book.metadata.seriesPosition}{isGridView ? null : " in series"}</span>
                ) : null}
                {!isCompactView && sortMode === "tag" && sortTag?.position ? (
                  <span className="book-sort-context">
                    Book {sortTag.position}{isGridView ? null : ` in ${sortTag.name}`}
                  </span>
                ) : null}
                {!isCompactView && formatDurationLabel(book.durationSeconds ?? durationFromTracks(book)) ? (
                  <span className="book-runtime-tag">
                    <Timer size={11} strokeWidth={1.5} />
                    {formatDurationLabel(book.durationSeconds ?? durationFromTracks(book))}
                  </span>
                ) : null}
                {readalongEnabled && book.readingFile ? (
                  <span
                    className={`book-readalong-tag ${glyphTags ? "is-glyph" : ""}`}
                    title={readingTitle}
                    aria-label={glyphTags ? readingTitle : undefined}
                  >
                    {followAlong ? <BookHeadphones size={11} strokeWidth={1.6} /> : <BookOpen size={11} strokeWidth={1.6} />}
                    {glyphTags ? null : readingLabel}
                  </span>
                ) : readalongEnabled && hasExtras(book) ? (
                  <span
                    className={`book-readalong-tag extras ${glyphTags ? "is-glyph" : ""}`}
                    title="Pictures or a supplement are included"
                    aria-label={glyphTags ? "Pictures or a supplement are included" : undefined}
                  >
                    <Images size={11} strokeWidth={1.6} />
                    {glyphTags ? null : "Extras"}
                  </span>
                ) : null}
                {progressLabel ? (
                  <span
                    className={`book-progress ${book.progress?.status ?? "notStarted"}`}
                    title={compactProgressTitle}
                    aria-label={compactProgressTitle}
                  >
                    <em>{progressLabel}</em>
                    {book.progress?.status === "inProgress" && book.progress.percentComplete !== null ? (
                      <i style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }} />
                    ) : null}
                  </span>
                ) : null}
                {shared ? (
                  <span
                    className={`book-shared-readers ${shared.finished > 0 ? "has-finishers" : ""}`}
                    title={shared.detail}
                    aria-label={shared.detail}
                  >
                    <Users size={11} strokeWidth={1.6} aria-hidden="true" />
                    {isGridView ? shared.finished + shared.reading : shared.label}
                  </span>
                ) : null}
              </span>
            </button>
        );
          })}</div>}
        </section>
        ))}
        </div>
      ))}
      {lettered && letterHeadings.length > 0 ? <ShelfLetterIndex headings={letterHeadings} reversed={sortReversed} /> : null}
    </div>
  );
});
