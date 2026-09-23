import { LoaderCircle, RotateCcw, Sparkles, X } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { haptic } from "./native";
import type { Book } from "./types";

export type DeviceNotice = { message: string; bookId?: string };

export function SyncConfirmationDialog({
  setSyncConfirmationBook,
  startSyncGeneration,
  syncConfirmationBook
}: {
  setSyncConfirmationBook: Dispatch<SetStateAction<Book | null>>;
  startSyncGeneration: (book: Book) => Promise<void>;
  syncConfirmationBook: Book;
}) {
  return (
    <div className="modal-scrim unplayed-confirm-scrim" role="presentation">
      <section
        className="modal-card unplayed-confirm-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-confirm-title"
        aria-describedby="sync-confirm-description"
        onKeyDown={(event) => {
          if (event.key === "Escape") setSyncConfirmationBook(null);
        }}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow"><Sparkles size={13} /> Follow along</span>
            <h2 id="sync-confirm-title">Re-sync this book?</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Cancel re-sync"
            onClick={() => setSyncConfirmationBook(null)}
          >
            <X size={18} />
          </button>
        </div>
        <p id="sync-confirm-description" className="unplayed-confirm-copy">
          <strong>{syncConfirmationBook.title}</strong> already has sentence-by-sentence
          narration sync. Rebuilding it can take a long time. Start only if the audio or text
          changed, or the current sync needs replacing.
        </p>
        <div className="unplayed-confirm-actions">
          <button
            type="button"
            className="unplayed-confirm-cancel"
            autoFocus
            onClick={() => setSyncConfirmationBook(null)}
          >
            Not now
          </button>
          <button
            type="button"
            className="unplayed-confirm-submit"
            onClick={() => {
              const book = syncConfirmationBook;
              setSyncConfirmationBook(null);
              void startSyncGeneration(book);
            }}
          >
            <Sparkles size={15} /> Start re-sync
          </button>
        </div>
      </section>
    </div>
  );
}

export function UnplayedConfirmationDialog({
  completionError,
  completionPendingBookId,
  confirmBookUnplayed,
  setCompletionError,
  setUnplayedConfirmationBookId,
  unplayedConfirmationBook
}: {
  completionError: DeviceNotice | null;
  completionPendingBookId: string | null;
  confirmBookUnplayed: (book: Book) => Promise<void>;
  setCompletionError: Dispatch<SetStateAction<DeviceNotice | null>>;
  setUnplayedConfirmationBookId: Dispatch<SetStateAction<string | null>>;
  unplayedConfirmationBook: Book;
}) {
  return (
    <div className="modal-scrim unplayed-confirm-scrim" role="presentation">
      <section
        className="modal-card unplayed-confirm-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unplayed-confirm-title"
        aria-describedby="unplayed-confirm-description"
        aria-busy={completionPendingBookId === unplayedConfirmationBook.id}
        onKeyDown={(event) => {
          if (event.key === "Escape" && completionPendingBookId !== unplayedConfirmationBook.id) {
            setUnplayedConfirmationBookId(null);
            setCompletionError(null);
          }
        }}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow"><RotateCcw size={13} /> Listening progress</span>
            <h2 id="unplayed-confirm-title">Mark as unplayed?</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Cancel marking book unplayed"
            disabled={completionPendingBookId === unplayedConfirmationBook.id}
            onClick={() => {
              haptic("light");
              setUnplayedConfirmationBookId(null);
              setCompletionError(null);
            }}
          >
            <X size={18} />
          </button>
        </div>
        <p id="unplayed-confirm-description" className="unplayed-confirm-copy">
          <strong>{unplayedConfirmationBook.title}</strong> will return to the beginning. This
          stops playback and removes it from Now Playing.
        </p>
        <div className="unplayed-confirm-summary" aria-label="Changes made by marking the book unplayed">
          <span>Listening position</span><strong>Beginning</strong>
          <span>Now Playing</span><strong>Cleared</strong>
          <span>Library status</span><strong>Not started</strong>
        </div>
        {completionError?.bookId === unplayedConfirmationBook.id ? (
          <p className="auth-error" role="alert">{completionError.message}</p>
        ) : null}
        <div className="unplayed-confirm-actions">
          <button
            type="button"
            className="unplayed-confirm-cancel"
            autoFocus
            disabled={completionPendingBookId === unplayedConfirmationBook.id}
            onClick={() => {
              haptic("light");
              setUnplayedConfirmationBookId(null);
              setCompletionError(null);
            }}
          >
            Keep listening
          </button>
          <button
            type="button"
            className="unplayed-confirm-submit"
            disabled={completionPendingBookId === unplayedConfirmationBook.id}
            onClick={() => void confirmBookUnplayed(unplayedConfirmationBook)}
          >
            {completionPendingBookId === unplayedConfirmationBook.id ? (
              <><LoaderCircle size={15} className="spin-icon" /> Resetting…</>
            ) : (
              <><RotateCcw size={15} /> Mark unplayed</>
            )}
          </button>
        </div>
      </section>
    </div>
  );
}
