import { useEffect, useMemo, useState } from "react";
import { ChevronRight, LoaderCircle, Pencil, Play, Square } from "lucide-react";
import { getServerStorageKey, listClips } from "./api";
import { buildChapterSegments, chapterAtBookPosition } from "./chapters";
import { CLIP_LEAD_SECONDS, CLIP_TAIL_SECONDS, type Clip, clipName, clipSpan, clipsForBook, pendingClipStorageKey, readPendingClips } from "./clips";
import { durationFromTracks, errorMessage, formatTime } from "./formatting";
import type { Book } from "./types";

/**
 * A book's clips, loaded once when its page opens so the Clips tab can show a
 * count before it is chosen. Nothing is requested while `book` is null.
 */
export function useBookClips(book: Book | null, userId: string, refreshKey: string | null) {
  const [saved, setSaved] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const [retry, setRetry] = useState(0);
  const bookId = book?.id ?? null;
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    setSaved([]);
    setLoading(true);
    setError(null);
    void listClips(bookId).then((result) => {
      if (cancelled) return;
      setSupported(result !== null);
      setSaved(result?.clips ?? []);
    }).catch((failure) => {
      if (!cancelled) setError(errorMessage(failure, "Saved clips could not be loaded."));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [bookId, refreshKey, retry]);
  const pending = bookId ? readPendingClips(window.localStorage, pendingClipStorageKey(getServerStorageKey(), userId)) : [];
  const clips = bookId ? clipsForBook(saved, pending, bookId) : [];
  return { clips, loading, error, supported, retry: () => setRetry((value) => value + 1) };
}

export type BookClipsState = ReturnType<typeof useBookClips>;

export function BookClips({ book, state, open, preview, stop, playingClipId, previewPending }: {
  book: Book;
  state: BookClipsState;
  open: (clipId?: string) => void;
  preview: (clip: Clip) => void;
  stop: () => void;
  playingClipId: string | null;
  previewPending: boolean;
}) {
  const { clips: passages, loading, error, supported } = state;
  const segments = useMemo(
    () => buildChapterSegments(book.chapters, book.durationSeconds ?? durationFromTracks(book)),
    [book]
  );
  return (
    <div className="book-clips">
      {loading ? <p role="status"><LoaderCircle size={16} className="spin" /> Loading clips…</p> : null}
      {error ? <div role="alert"><p>{error}</p><button type="button" className="download-btn" onClick={state.retry}>Try again</button></div> : null}
      {!loading && !error && !supported ? <p>Update your OperaLibre server to use clips.</p> : null}
      {!loading && !error && supported && passages.length === 0 ? (
        <div className="book-clips-empty">
          <span className="clip-ribbon-glyph" aria-hidden="true" />
          <div>
            <strong>No clips yet</strong>
            <p>While listening, press the gold ribbon on the cover to save the last {CLIP_LEAD_SECONDS} seconds and the next {CLIP_TAIL_SECONDS}.</p>
          </div>
        </div>
      ) : null}
      {passages.length > 0 ? <p className="book-clips-intro">Previewing a clip leaves your place in the book where it is.</p> : null}
      <ul className="book-clips-list">
        {passages.map((clip) => {
          const name = clipName(clip, chapterAtBookPosition(segments, clip.startSeconds)?.title);
          const span = clipSpan(clip);
          return (
            <li key={clip.id}>
              <button type="button" className="book-clip-play" disabled={previewPending}
                aria-label={playingClipId === clip.id ? "Stop clip preview" : `Preview ${name}`}
                onClick={() => playingClipId === clip.id ? stop() : preview(clip)}>
                {playingClipId === clip.id ? <Square size={15} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
              </button>
              <button type="button" className="book-clip-detail" aria-label={`Edit ${name}`} onClick={() => open(clip.id)}>
                <span>
                  <strong>{name}</strong>
                  <small>{formatTime(span.start)} – {formatTime(span.end)} · {span.length}{clip.pending ? " · Waiting to sync" : ""}</small>
                  {clip.note ? <em className="book-clip-note">{clip.note}</em> : null}
                </span>
                <Pencil size={15} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      {previewPending ? <p role="status">Opening this book for preview…</p> : null}
      {passages.length > 0 ? <button type="button" className="book-clips-manage" onClick={() => open()}>All clips in one list <ChevronRight size={15} /></button> : null}
    </div>
  );
}
