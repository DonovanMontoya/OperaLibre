import { BookOpen, Check, Cloud, Images, Search, Smartphone, Timer, Users } from "lucide-react";
import { hasExtras } from "./readalong";
import { memo, useState } from "react";
import { compactProgressLabel } from "./bookProgress";
import type { ShelfViewMode } from "./shelfView";
import { SHELF_FACET_PREVIEW_COUNT, type ShelfFacetOption, type ShelfFilters, tagForShelfSort } from "./shelfFilters";
import type { Book } from "./types";
import { summarizeSharedProgress } from "./sharedProgress";
import { bookSortGroupCaption, type SortMode } from "./shelfSort";
import { bookProgressLabel, bookSubtitle, durationFromTracks, formatDurationLabel } from "./formatting";
import { CoverArt } from "./CoverArt";

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

type ShelfRun = { label: string | null; items: Array<{ book: Book; index: number }> };

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
  shelfTags,
  selectedBookId,
  playbackBookId,
  downloadedBookIds,
  isOffline,
  demoMode,
  localMode,
  native,
  readalongEnabled,
  onSelectBook
}: {
  columns: ShelfRun[][];
  viewMode: ShelfViewMode;
  sortMode: SortMode;
  shelfTags: ShelfFilters["tags"];
  selectedBookId: string | null;
  playbackBookId: string | null;
  downloadedBookIds: Set<string>;
  isOffline: boolean;
  demoMode: boolean;
  localMode: boolean;
  native: boolean;
  readalongEnabled: boolean;
  onSelectBook: (book: Book) => void;
}) {
  const isCompactView = viewMode === "compact";
  return (
    <div className={`book-list ${viewMode === "grid" ? "is-grid" : viewMode === "compact" ? "is-list is-compact" : "is-list"}`}>
      {columns.map((column, columnIndex) => (
        <div className="book-leaf" key={`leaf-${columnIndex}`}>
        {column.map((run) => (
        <section className="book-sort-run" key={`${run.label ?? "book"}-${run.items[0].book.id}`}>
          {run.label ? (
            <div className="book-sort-group" role="heading" aria-level={2}>
              <span>{bookSortGroupCaption(sortMode)}</span>
              <strong>{run.label}</strong>
            </div>
          ) : null}
          {run.items.map(({ book, index }) => {
        const progressPercent = book.progress?.percentComplete ?? 0;
        const availableOnDevice =
          demoMode
          || localMode
          || book.source === "device"
          || !!book.deviceBookId
          || downloadedBookIds.has(book.id);
        const availableOnServer = !demoMode && !localMode && book.source !== "device";
        const availabilityLabel = availableOnDevice
          ? availableOnServer
            ? "Available on the server and this device"
            : "Available on this device"
          : "Available from the server";
        const unavailableOffline = isOffline && !availableOnDevice;
        const shared = isCompactView ? null : summarizeSharedProgress(book.sharedProgress);
        // Compact abbreviates the chip and drops it entirely for a book
        // nobody has opened; the full wording stays on the tooltip so
        // shortening it costs a screen reader nothing.
        const progressLabel = isCompactView ? compactProgressLabel(book) : bookProgressLabel(book);
        const compactProgressTitle = isCompactView ? bookProgressLabel(book) : undefined;
        const sortTag = tagForShelfSort(book, shelfTags);
        return (
            <button
              key={book.id}
              className={`book-row ${book.id === selectedBookId ? "active" : ""} ${book.id === playbackBookId ? "playing" : ""} ${book.progress?.status === "inProgress" ? "in-progress" : ""} ${unavailableOffline ? "offline-unavailable" : ""}`}
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
                aria-label={availabilityLabel}
                title={availabilityLabel}
              >
                {availableOnServer ? <Cloud className="server-availability-icon" size={13} strokeWidth={1.8} /> : null}
                {availableOnDevice ? <Smartphone className="device-availability-icon" size={13} strokeWidth={1.8} /> : null}
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
                  <span className="book-sort-context">Book {book.metadata.seriesPosition} in series</span>
                ) : null}
                {!isCompactView && sortMode === "tag" && sortTag?.position ? (
                  <span className="book-sort-context">
                    Book {sortTag.position} in {sortTag.name}
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
                    className={`book-readalong-tag ${isCompactView ? "is-glyph" : ""}`}
                    title="Ebook included: read along while you listen"
                    aria-label={isCompactView ? "Ebook included: read along while you listen" : undefined}
                  >
                    <BookOpen size={11} strokeWidth={1.6} />
                    {isCompactView ? null : "Read along"}
                  </span>
                ) : readalongEnabled && hasExtras(book) ? (
                  <span
                    className={`book-readalong-tag extras ${isCompactView ? "is-glyph" : ""}`}
                    title="Pictures or a supplement are included"
                    aria-label={isCompactView ? "Pictures or a supplement are included" : undefined}
                  >
                    <Images size={11} strokeWidth={1.6} />
                    {isCompactView ? null : "Extras"}
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
                    {shared.label}
                  </span>
                ) : null}
              </span>
            </button>
        );
          })}
        </section>
        ))}
        </div>
      ))}
    </div>
  );
});
