import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Play, Plus, X } from "lucide-react";
import { CoverArt } from "./CoverArt";
import { bookProgressLabel } from "./formatting";
import { progressTimestamp } from "./reliability";
import { readStoredValue } from "./appStorage";
import { moveQueuedBookEarlier, parseReadingQueue, queuedBooks } from "./readingQueue";
import type { Book } from "./types";

export const ContinueReading = memo(function ContinueReading({
  books,
  onContinue,
  storageKey,
  queueBooks,
  onOpenBook,
  onStart
}: {
  books: Book[];
  storageKey: string;
  queueBooks: Book[];
  onOpenBook: (id: string) => void;
  onStart: (book: Book) => void;
  onContinue: (book: Book, play?: boolean) => void;
}) {
  const reading = useMemo(() => books
    .filter((book) => book.progress?.status === "inProgress")
    .sort((a, b) => progressTimestamp(b.progress!.updatedAt) - progressTimestamp(a.progress!.updatedAt)), [books]);

  const [ids, setIds] = useState(() => parseReadingQueue(readStoredValue(storageKey)));
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const addToggleRef = useRef<HTMLButtonElement>(null);
  const queue = queuedBooks(ids, queueBooks);
  // Planned IDs with no book to show (offline, or outside this library view)
  // stay stored; say so rather than letting the plan look silently shorter.
  const knownIds = new Set(queueBooks.map(book => book.id));
  const unavailable = ids.filter(id => !knownIds.has(id)).length;
  const candidates = queueBooks.filter(book => (!book.progress || book.progress.status === "notStarted") && !ids.includes(book.id)
    && `${book.title} ${book.author ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  useEffect(() => {
    // Consume a plan only once the existing playback flow reports real progress.
    const started = new Set(queueBooks.filter(book => book.progress?.status === "inProgress" || book.progress?.status === "finished").map(book => book.id));
    const next = ids.filter(id => !started.has(id));
    if (next.length === ids.length) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      setIds(next);
    } catch {
      setNotice("Your queue could not be saved. Check available device storage and try again.");
    }
  }, [ids, queueBooks, storageKey]);
  function save(next: string[], message: string) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      setIds(next);
      setNotice(message);
    } catch {
      setNotice("Your queue could not be saved. Check available device storage and try again.");
    }
  }

  return (
    <>
      {reading.length > 0 ? <section className="continue-reading" aria-labelledby="continue-reading-title">
        <header className="continue-reading-heading">
          <h2 id="continue-reading-title">Continue Reading</h2>
          <span>{reading.length}</span>
        </header>
        <ul className="continue-reading-list">
          {reading.map((book) => {
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
          })}
        </ul>
      </section> : null}
      <section className="continue-reading reading-queue" aria-labelledby="reading-queue-title">
        <header className="continue-reading-heading">
          <h2 id="reading-queue-title">Up Next</h2>
          <span>{queue.length}</span>
          <button ref={addToggleRef} type="button" className="queue-add" aria-expanded={adding} aria-controls="queue-picker" onClick={() => setAdding(!adding)}>
            {adding ? <X size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}{adding ? "Close" : "Add books"}
          </button>
        </header>
        <p className="queue-description">Books you plan to read next. Saved on this device.</p>
        {adding ? <div
          id="queue-picker"
          className="queue-picker"
          onKeyDown={event => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setAdding(false);
            addToggleRef.current?.focus();
          }}
        >
          <label htmlFor="queue-search">Find a book to add</label>
          <input id="queue-search" type="search" placeholder="Title or author" value={query} onChange={event => setQuery(event.target.value)} />
          <ul className="queue-candidates">
            {candidates.map(book => <li key={book.id}><span><strong>{book.title}</strong>{book.author ? <small>{book.author}</small> : null}</span>
              <button type="button" className="queue-candidate-add" aria-label={`Add ${book.title} to Up Next`} onClick={() => save([...ids, book.id], `${book.title} added to Up Next.`)}><Plus size={14} aria-hidden="true" />Add</button>
            </li>)}
          </ul>
          {candidates.length === 0 ? <p className="queue-picker-empty">No matching books to add. Only books you haven’t started appear here.</p> : null}
        </div> : null}
        {queue.length === 0 ? <div className="queue-empty">
          <strong>{unavailable > 0 ? "No planned books available" : "Nothing planned yet"}</strong>
          <p>{unavailable > 0 ? "Your plan is saved. Add an available book or check back when your library is available." : "Your next read starts here. Add a book from your library."}</p>
        </div> : <ul className="continue-reading-list">
          {queue.map((book, index) => <li key={book.id} className={`continue-reading-row queue-row ${index === 0 ? "is-next" : ""}`}>
            <button type="button" className="continue-reading-book" aria-label={`Open ${book.title}`} onClick={() => onOpenBook(book.id)}>
              <CoverArt book={book} size="small" />
              <span className="continue-reading-copy"><strong>{book.title}</strong>{book.author ? <span className="continue-reading-author">{book.author}</span> : null}<span className="continue-reading-progress">{index === 0 ? "Next in line" : `Up next · ${index + 1}`} · Not started</span></span>
              <ChevronRight className="queue-details-cue" size={16} aria-hidden="true" />
            </button>
            <div className="queue-actions">
              <button type="button" className="queue-start" aria-label={`Start ${book.title}`} onClick={() => onStart(book)}><span className="queue-start-mark" aria-hidden="true"><Play size={11} fill="currentColor" /></span>Start</button>
              <button type="button" className="queue-move" disabled={index === 0} aria-label={`Move ${book.title} earlier`} title="Move earlier" onClick={() => save(moveQueuedBookEarlier(ids, book.id, queue.map(entry => entry.id)), `${book.title} moved earlier.`)}><ArrowUp size={16} aria-hidden="true" /></button>
              <button type="button" className="queue-remove" aria-label={`Remove ${book.title} from Up Next`} title="Remove from Up Next" onClick={() => save(ids.filter(id => id !== book.id), `${book.title} removed from Up Next.`)}><X size={16} aria-hidden="true" /></button>
            </div>
          </li>)}
        </ul>}
        {unavailable > 0 ? <p className="queue-unavailable">{unavailable === 1 ? "1 planned book isn’t available right now." : `${unavailable} planned books aren’t available right now.`} {unavailable === 1 ? "It stays" : "They stay"} in your plan.</p> : null}
        <p className="queue-notice" role="status">{notice}</p>
      </section>
      <h2 className="continue-reading-library-heading">Library</h2>
    </>
  );
});
