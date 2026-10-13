import { Bookmark, Check, Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { CoverArt } from "./CoverArt";
import { formatTime } from "./formatting";
import type { Book } from "./types";

export function CarPlayer({
  book, chapterTitle, elapsed, duration, isPlaying, playPending, playbackError, sleepStatus,
  seekBy, togglePlayback, onSaveClip, clipSaved, clipError
}: {
  book: Book;
  chapterTitle: string;
  elapsed: number;
  duration: number;
  isPlaying: boolean;
  playPending: boolean;
  playbackError: string | null;
  sleepStatus: string | null;
  seekBy: (seconds: number) => void;
  togglePlayback: () => void;
  onSaveClip?: () => void;
  clipSaved: boolean;
  clipError: string | null;
}) {
  const progress = duration > 0 ? Math.max(0, Math.min(100, elapsed / duration * 100)) : 0;

  return (
    <div className="car-player">
      <div className="car-player-body">
        <div className="car-player-book">
          <CoverArt book={book} size="small" />
          <div className="car-player-copy">
            <h2>{book.title}</h2>
            {book.author ? <p>{book.author}</p> : null}
          </div>
        </div>
        <div className="car-player-chapter">
          <p>{chapterTitle}</p>
          <div className="car-player-progress" role="img" aria-label={`${Math.round(progress)}% through ${chapterTitle}`}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="car-player-times"><span>{formatTime(elapsed)}</span><span>−{formatTime(Math.max(0, duration - elapsed))}</span></div>
        </div>
        <div className="car-player-transport">
          <button type="button" aria-label="Rewind 15 seconds" onClick={() => seekBy(-15)}>
            <span className="car-player-skip-icon"><RotateCcw size={38} aria-hidden="true" /><strong>15</strong></span>
            <span>Back</span>
          </button>
          <button type="button" className="car-player-play"
            aria-label={playPending ? "Cancel play" : isPlaying ? "Pause" : "Play"}
            aria-busy={playPending} onClick={togglePlayback}>
            {isPlaying || playPending
              ? <Pause size={64} strokeWidth={1} fill="currentColor" aria-hidden="true" />
              : <Play size={64} strokeWidth={1} fill="currentColor" aria-hidden="true" />}
          </button>
          <button type="button" aria-label="Forward 30 seconds" onClick={() => seekBy(30)}>
            <span className="car-player-skip-icon"><RotateCw size={38} aria-hidden="true" /><strong>30</strong></span>
            <span>Forward</span>
          </button>
        </div>
        <div className="car-player-secondary">
          {onSaveClip ? (
            <button type="button" className="car-player-bookmark" onClick={onSaveClip}
              aria-label="Save a clip of the last 30 seconds and the next 10">
              {clipSaved ? <Check size={25} strokeWidth={1.7} aria-hidden="true" /> : <Bookmark size={25} strokeWidth={1.7} aria-hidden="true" />}
              <span>{clipSaved ? "Saved" : "Save moment"}</span>
            </button>
          ) : null}
          <p className="car-player-state" role="status">{playPending ? "Preparing audio · tap to cancel" : clipSaved && onSaveClip ? "Clip saved" : isPlaying ? "Playing" : "Paused"}</p>
        </div>
      </div>
      <div className="car-player-notices">
        {clipError ? <p role="alert">{clipError}</p> : null}
        {playbackError ? <p role="alert">{playbackError}</p> : null}
        {sleepStatus ? <p>{sleepStatus}</p> : null}
      </div>
    </div>
  );
}
