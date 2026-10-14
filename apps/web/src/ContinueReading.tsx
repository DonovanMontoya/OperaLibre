import { memo, useMemo, useState } from "react";
import { ArrowUp, Play, X } from "lucide-react";
import { CoverArt } from "./CoverArt";
import { bookProgressLabel } from "./formatting";
import { progressTimestamp } from "./reliability";
import { moveQueuedBookEarlier, queuedBooks } from "./readingQueue";
import { useReadingQueue } from "./useReadingQueue";
import type { Book } from "./types";

export const ContinueReading = memo(function ContinueReading({
  books,
  onContinue,
  storageKey,
  onOpenBook
}: {
  books: Book[];
  storageKey: string;
  onOpenBook: (id: string) => void;
  onContinue: (book: Book, play?: boolean) => void;
}) {
  const reading = useMemo(() => books
    .filter((book) => book.progress?.status === "inProgress")
    .sort((a, b) => progressTimestamp(b.progress!.updatedAt) - progressTimestamp(a.progress!.updatedAt)), [books]);

  const [ids, saveIds] = useReadingQueue(storageKey);
  const [notice, setNotice] = useState("");
  // A planned book that is now in progress is already listed with the others.
  const planned = queuedBooks(ids, books).filter(book => book.progress?.status !== "inProgress");
  // Planned IDs with no book to show (offline, or outside this library view)
  // stay stored; say so rather than letting the plan look silently shorter.
  const knownIds = new Set(books.map(book => book.id));
  const unavailable = ids.filter(id => !knownIds.has(id)).length;
  function save(next: string[], message: string) {
    setNotice(saveIds(next) ? message : "Your queue could not be saved. Check available device storage and try again.");
  }

  const noticeLine = <p className="queue-notice" role="status">{notice}</p>;

  const rows = [
    ...reading.map((book) => {
      const percent = book.progress?.percentComplete;
      const progress = percent == null ? null : Math.min(100, Math.max(0, percent));
      return (
        <li key={book.id} className="continue-reading-row">
          <button
            type="button"
            className="continue-reading-book"
            aria-label={`Continue reading ${book.title}`}
            onClick={() => onContinue(book)}
          >
            <CoverArt book={book} size="small" />
            <span className="continue-reading-copy">
              <strong>{book.title}</strong>
              {book.author ? <span className="continue-reading-author">{book.author}</span> : null}
              <span className="continue-reading-progress">
                <span>{bookProgressLabel(book)}</span>
                {progress !== null ? <span>{Math.round(progress)}%</span> : null}
              </span>
              {progress !== null ? (
                <span className="continue-reading-meter" aria-hidden="true">
                  <i style={{ width: `${progress}%` }} />
                </span>
              ) : null}
            </span>
          </button>
          <button
            type="button"
            className="continue-reading-play"
            aria-label={`Play ${book.title}`}
            onClick={() => onContinue(book, true)}
          >
            <Play size={14} fill="currentColor" aria-hidden="true" />
          </button>
        </li>
      );
    }),
    ...planned.map((book, index) => (
      <li key={book.id} className="continue-reading-row queue-row">
        <button
          type="button"
          className="continue-reading-book"
          aria-label={`Open ${book.title}`}
          onClick={() => onOpenBook(book.id)}
        >
          <CoverArt book={book} size="small" />
          <span className="continue-reading-copy">
            <strong>{book.title}</strong>
            {book.author ? <span className="continue-reading-author">{book.author}</span> : null}
            <span className="continue-reading-progress">{bookProgressLabel(book)}</span>
          </span>
        </button>
        <span className="queue-actions">
          <button type="button" className="queue-move" disabled={index === 0} aria-label={`Move ${book.title} earlier`} title="Move earlier" onClick={() => save(moveQueuedBookEarlier(ids, book.id, planned.map(entry => entry.id)), `${book.title} moved earlier.`)}><ArrowUp size={16} aria-hidden="true" /></button>
          <button type="button" className="queue-remove" aria-label={`Remove ${book.title} from Up Next`} title="Remove from Up Next" onClick={() => save(ids.filter(id => id !== book.id), `${book.title} removed from Up Next.`)}><X size={16} aria-hidden="true" /></button>
        </span>
        <button
          type="button"
          className="continue-reading-play"
          aria-label={`Start ${book.title}`}
          onClick={() => onContinue(book, true)}
        >
          <Play size={14} fill="currentColor" aria-hidden="true" />
        </button>
      </li>
    ))
  ];

  return (
    <>
      {rows.length + unavailable > 0 ? <section className="continue-reading" aria-labelledby="up-next-title">
        <header className="continue-reading-heading">
          <h2 id="up-next-title">Up Next</h2>
          <span>{rows.length}</span>
        </header>
        {/* The first book stands apart so the open Duo can give it a leaf while the
            rest scroll in a row beside it. */}
        {rows.length > 0 ? <ul className="continue-reading-list continue-reading-lead">{rows[0]}</ul> : null}
        {rows.length > 1 ? <ul className="continue-reading-list continue-reading-rest">{rows.slice(1)}</ul> : null}
        {rows.length === 1 ? <p className="queue-hint">Open a book and choose Add to Up Next to line it up here.</p> : null}
        {unavailable > 0 ? <p className="queue-unavailable">{unavailable === 1 ? "1 planned book isn’t available right now." : `${unavailable} planned books aren’t available right now.`} {unavailable === 1 ? "It stays" : "They stay"} in your plan.</p> : null}
        {noticeLine}
      </section> : noticeLine}
      <h2 className="continue-reading-library-heading">Library</h2>
    </>
  );
});
