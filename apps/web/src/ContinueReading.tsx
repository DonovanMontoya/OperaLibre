import { memo, useMemo } from "react";
import { Play } from "lucide-react";
import { CoverArt } from "./CoverArt";
import { bookProgressLabel } from "./formatting";
import { progressTimestamp } from "./reliability";
import type { Book } from "./types";

export const ContinueReading = memo(function ContinueReading({
  books,
  onContinue
}: {
  books: Book[];
  onContinue: (book: Book, play?: boolean) => void;
}) {
  const reading = useMemo(() => books
    .filter((book) => book.progress?.status === "inProgress")
    .sort((a, b) => progressTimestamp(b.progress!.updatedAt) - progressTimestamp(a.progress!.updatedAt)), [books]);

  if (reading.length === 0) return null;

  return (
    <>
      <section className="continue-reading" aria-labelledby="continue-reading-title">
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
      </section>
      <h2 className="continue-reading-library-heading">Library</h2>
    </>
  );
});
