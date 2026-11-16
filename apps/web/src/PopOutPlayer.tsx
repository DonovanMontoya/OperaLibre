import { CornerDownLeft, Pause, Play, RotateCcw, RotateCw, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useRef, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { CoverArt } from "./CoverArt";
import { ScrubSlider } from "./PlaybackControls";
import { formatPlaybackSpeed } from "./playbackSpeed";
import { formatTime } from "./formatting";
import { nextPresetSpeed, popOutKeyAction, type PopOutPlayerWindow } from "./popOutPlayer";
import type { ChapterSegment } from "./chapters";
import type { Book, Track } from "./types";
import "./popOutPlayer.css";

// Past this many chapters the notches would merge into a dotted line.
const MAX_FOIL_NOTCHES = 80;

/**
 * The playing book in its own small window. The layout follows the window,
 * which the listener can resize: cover above the controls when it is tall,
 * beside them when it is wide, and a single strip when it is short.
 */
export function PopOutPlayer({
  activeChapter,
  bookDuration,
  bookPosition,
  chapterDuration,
  chapterElapsed,
  chapterSegments,
  currentTrack,
  hasNextChapter,
  hasPreviousChapter,
  isPlaying,
  nextChapter,
  onReturn,
  playPending,
  playbackBook,
  popOut,
  position,
  restartOrPreviousChapter,
  scrubbedElapsed,
  seekBookPosition,
  seekBy,
  seekTo,
  setScrubPreview,
  sliderMax,
  speed,
  togglePlayback,
  updateSpeed
}: {
  activeChapter: ChapterSegment | null;
  bookDuration: number;
  bookPosition: number;
  chapterDuration: number;
  chapterElapsed: number;
  chapterSegments: ChapterSegment[];
  currentTrack: Track;
  hasNextChapter: boolean;
  hasPreviousChapter: boolean;
  isPlaying: boolean;
  nextChapter: () => void;
  onReturn: () => void;
  playPending: boolean;
  playbackBook: Book;
  popOut: PopOutPlayerWindow;
  position: number;
  restartOrPreviousChapter: () => void;
  scrubbedElapsed: number;
  seekBookPosition: (value: number, autoPlay?: boolean) => void;
  seekBy: (delta: number) => void;
  seekTo: (value: number) => void;
  setScrubPreview: Dispatch<SetStateAction<number | null>>;
  sliderMax: number;
  speed: number;
  togglePlayback: () => void;
  updateSpeed: (value: number) => void;
}) {
  const heading = activeChapter?.title ?? currentTrack.title;
  const span = activeChapter ? chapterDuration : Math.max(1, sliderMax);
  const elapsed = Math.min(scrubbedElapsed, span);
  const nextSpeed = nextPresetSpeed(speed);
  const bookShare = bookDuration > 0 ? Math.min(1, Math.max(0, bookPosition / bookDuration)) : 0;

  useEffect(() => {
    popOut.window.document.title = `${heading} · ${playbackBook.title}`;
  }, [heading, playbackBook.title, popOut.window]);

  const actions = useRef({ togglePlayback, seekBy });
  actions.current = { togglePlayback, seekBy };
  useEffect(() => {
    const doc = popOut.window.document;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const action = popOutKeyAction(event.key, event.target as Element | null);
      if (!action) return;
      event.preventDefault();
      if (action === "toggle") actions.current.togglePlayback();
      else actions.current.seekBy(action === "back" ? -15 : 30);
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => doc.removeEventListener("keydown", onKeyDown);
  }, [popOut.window]);

  return createPortal(
    <main className="popout-player" aria-label={`Now playing ${playbackBook.title}`}>
      <div className="popout-cover">
        <CoverArt book={playbackBook} size="large" />
      </div>

      <div className="popout-body">
        <div className="popout-copy">
          <h1 title={heading}>{heading}</h1>
          <p title={playbackBook.title}>{playbackBook.title}</p>
        </div>

        <div className="popout-timeline">
          <ScrubSlider
            ariaLabel={activeChapter ? `Playback position in ${activeChapter.title}` : "Playback position"}
            max={span}
            value={activeChapter ? Math.min(chapterElapsed, chapterDuration) : Math.min(position, span)}
            onPreview={setScrubPreview}
            onCommit={(value) => {
              if (activeChapter) seekBookPosition(activeChapter.startSeconds + value);
              else seekTo(value);
            }}
          />
          <div className="popout-times">
            <span>{formatTime(elapsed)}</span>
            <span>−{formatTime(Math.max(0, span - elapsed))}</span>
          </div>
        </div>

        <div className="popout-transport">
          <button
            type="button"
            className="popout-chapter"
            aria-label={chapterElapsed > 5 ? "Restart chapter" : "Previous chapter"}
            onClick={restartOrPreviousChapter}
            disabled={!activeChapter || (chapterElapsed <= 5 && !hasPreviousChapter)}
          >
            <SkipBack size={16} strokeWidth={1.6} />
          </button>
          <button type="button" className="popout-seek" aria-label="Rewind 15 seconds" onClick={() => seekBy(-15)}>
            <RotateCcw size={24} strokeWidth={1.4} />
            <small aria-hidden="true">15</small>
          </button>
          <button
            type="button"
            className={`popout-play${playPending ? " play-pending" : ""}`}
            aria-label={playPending ? "Cancel play" : isPlaying ? "Pause" : "Play"}
            aria-busy={playPending}
            onClick={togglePlayback}
          >
            {isPlaying || playPending ? <Pause size={22} fill="currentColor" strokeWidth={0} /> : <Play size={22} fill="currentColor" strokeWidth={0} />}
            {playPending ? <span className="play-pending-ring" aria-hidden="true" /> : null}
          </button>
          <button type="button" className="popout-seek" aria-label="Forward 30 seconds" onClick={() => seekBy(30)}>
            <RotateCw size={24} strokeWidth={1.4} />
            <small aria-hidden="true">30</small>
          </button>
          <button
            type="button"
            className="popout-chapter"
            aria-label="Next chapter"
            onClick={nextChapter}
            disabled={!activeChapter || !hasNextChapter}
          >
            <SkipForward size={16} strokeWidth={1.6} />
          </button>
        </div>

        <div className="popout-footer">
          <button
            type="button"
            className="popout-speed"
            aria-label={`Playback speed ${formatPlaybackSpeed(speed)}×, change to ${formatPlaybackSpeed(nextSpeed)}×`}
            onClick={() => updateSpeed(nextSpeed)}
          >
            {formatPlaybackSpeed(speed)}×
          </button>
          <button type="button" className="popout-return" onClick={onReturn}>
            <CornerDownLeft size={14} strokeWidth={1.6} />
            <span>Back to tab</span>
          </button>
        </div>
      </div>

      {/* Gold foil along the bottom edge: the whole book, notched where each
          chapter begins. */}
      <div
        className="popout-foil"
        role="img"
        aria-label={`${Math.floor(bookShare * 100)}% of the book`}
        style={{ "--book-share": bookShare } as CSSProperties}
      >
        <span className="popout-foil-fill" />
        {bookDuration > 0 && chapterSegments.length > 1 && chapterSegments.length <= MAX_FOIL_NOTCHES
          ? chapterSegments.slice(1).map((chapter) => (
            <span
              key={chapter.id}
              className={`popout-foil-notch${chapter.startSeconds <= bookPosition ? " is-read" : ""}`}
              style={{ left: `${(chapter.startSeconds / bookDuration) * 100}%` }}
            />
          ))
          : null}
      </div>
    </main>,
    popOut.container
  );
}
