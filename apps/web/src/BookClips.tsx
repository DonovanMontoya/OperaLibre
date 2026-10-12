import { useEffect, useState } from "react";
import { ChevronRight, LoaderCircle, Play, Square } from "lucide-react";
import { getServerStorageKey, listClips } from "./api";
import { type Clip, clipsForBook, pendingClipStorageKey, readPendingClips } from "./clips";
import { errorMessage, formatTime } from "./formatting";
import type { Book } from "./types";

export function BookClips({ book, userId, refreshKey, open, preview, stop, playingClipId, previewPending }: {
  book: Book;
  userId: string;
  refreshKey: string | null;
  open: (clipId?: string) => void;
  preview: (clip: Clip) => void;
  stop: () => void;
  playingClipId: string | null;
  previewPending: boolean;
}) {
  const [saved, setSaved] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const [retry, setRetry] = useState(0);
  const pending = readPendingClips(window.localStorage, pendingClipStorageKey(getServerStorageKey(), userId));
  const passages = clipsForBook(saved, pending, book.id);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listClips(book.id).then((result) => {
      if (cancelled) return;
      setSupported(result !== null);
      setSaved(result?.clips ?? []);
    }).catch((failure) => {
      if (!cancelled) setError(errorMessage(failure, "Saved clips could not be loaded."));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [book.id, refreshKey, retry]);
  return (
    <div className="book-clips">
      {loading ? <p role="status"><LoaderCircle size={16} className="spin" /> Loading saved clips…</p> : null}
      {error ? <div role="alert"><p>{error}</p><button type="button" className="download-btn" onClick={() => setRetry((value) => value + 1)}>Try again</button></div> : null}
      {!loading && !error && !supported ? <p>Update your OperaLibre server to use saved clips.</p> : null}
      {!loading && !error && supported && passages.length === 0 ? <p>No saved clips in this book yet. Tap the gold ribbon while listening to keep a passage.</p> : null}
      <ul className="book-clips-list">
        {passages.map((clip) => (
          <li key={clip.id}>
            <button type="button" className="book-clip-play" disabled={previewPending}
              aria-label={playingClipId === clip.id ? "Stop clip preview" : `Preview ${clip.title || "clip"}`}
              onClick={() => playingClipId === clip.id ? stop() : preview(clip)}>
              {playingClipId === clip.id ? <Square size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
            </button>
            <button type="button" className="book-clip-detail" onClick={() => open(clip.id)}>
              <span><strong>{clip.title || "Saved passage"}</strong><small>{formatTime(clip.startSeconds)}–{formatTime(clip.endSeconds)} · {formatTime(clip.endSeconds - clip.startSeconds)}{clip.pending ? " · Waiting to sync" : ""}</small></span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {previewPending ? <p role="status">Opening this book for preview…</p> : null}
      {passages.length > 0 ? <button type="button" className="book-clips-manage" onClick={() => open()}>Manage clips <ChevronRight size={15} /></button> : null}
    </div>
  );
}
