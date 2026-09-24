import { CoverArt } from "./CoverArt";
import { ScrubSlider } from "./PlaybackControls";
import { formatTime } from "./formatting";
import { Pause, Play, RotateCcw, RotateCw, SkipBack, SkipForward } from "lucide-react";
import type { ChapterSegment } from "./chapters";
import type { Book, Track } from "./types";
import type { Dispatch, RefObject, SetStateAction } from "react";

export function MiniPlayer({
  activeChapter,
  chapterDuration,
  chapterElapsed,
  currentTrack,
  hasNextChapter,
  hasPreviousChapter,
  isPlaying,
  miniPlayerRef,
  nextChapter,
  playPending,
  playbackBook,
  position,
  restartOrPreviousChapter,
  scrollToPlayer,
  scrubbedElapsed,
  seekBookPosition,
  seekBy,
  seekTo,
  setScrubPreview,
  sliderMax,
  togglePlayback
}: {
  activeChapter: ChapterSegment | null;
  chapterDuration: number;
  chapterElapsed: number;
  currentTrack: Track;
  hasNextChapter: boolean;
  hasPreviousChapter: boolean;
  isPlaying: boolean;
  miniPlayerRef: RefObject<HTMLElement | null>;
  nextChapter: () => void;
  playPending: boolean;
  playbackBook: Book;
  position: number;
  restartOrPreviousChapter: () => void;
  scrollToPlayer: () => void;
  scrubbedElapsed: number;
  seekBookPosition: (value: number, autoPlay?: boolean) => void;
  seekBy: (delta: number) => void;
  seekTo: (value: number) => void;
  setScrubPreview: Dispatch<SetStateAction<number | null>>;
  sliderMax: number;
  togglePlayback: () => void;
}) {
  return (
    <aside ref={miniPlayerRef} className="mini-player" aria-label="Mini player">
      <button className="mini-cover-button" type="button" onClick={scrollToPlayer} aria-label="Open current book">
        <CoverArt book={playbackBook} size="small" />
      </button>

      <button className="mini-meta" type="button" onClick={scrollToPlayer}>
        <strong>{playbackBook.title}</strong>
        <span>{activeChapter?.title ?? currentTrack.title}</span>
      </button>

      <div className="mini-progress">
        <ScrubSlider
          ariaLabel="Mini player progress"
          max={activeChapter ? chapterDuration : Math.max(1, sliderMax)}
          value={activeChapter ? Math.min(chapterElapsed, chapterDuration) : Math.min(position, Math.max(1, sliderMax))}
          onPreview={setScrubPreview}
          onCommit={(nextValue) => {
            if (activeChapter) {
              seekBookPosition(activeChapter.startSeconds + nextValue);
            } else {
              seekTo(nextValue);
            }
          }}
        />
        <span>
          {activeChapter
            ? `${formatTime(scrubbedElapsed)} / ${formatTime(chapterDuration)}`
            : `${formatTime(scrubbedElapsed)} / ${formatTime(sliderMax)}`}
        </span>
      </div>

      <div className="mini-actions">
        {activeChapter ? (
          <button
            type="button"
            className="mini-chapter"
            aria-label={chapterElapsed > 5 ? "Restart chapter" : "Previous chapter"}
            onClick={restartOrPreviousChapter}
            disabled={chapterElapsed <= 5 && !hasPreviousChapter}
          >
            <SkipBack size={17} />
          </button>
        ) : null}
        <button type="button" className="mini-seek" aria-label="Rewind 15 seconds" onClick={() => seekBy(-15)}>
          <RotateCcw size={16} />
          <small>15</small>
        </button>
        <button
          type="button"
          className={`mini-play${playPending ? " play-pending" : ""}`}
          aria-label={playPending ? "Cancel play" : isPlaying ? "Pause" : "Play"}
          aria-busy={playPending}
          onClick={togglePlayback}
        >
          {isPlaying || playPending ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          {playPending ? <span className="play-pending-ring" aria-hidden="true" /> : null}
        </button>
        <button type="button" className="mini-seek" aria-label="Forward 30 seconds" onClick={() => seekBy(30)}>
          <RotateCw size={16} />
          <small>30</small>
        </button>
        {activeChapter ? (
          <button
            type="button"
            className="mini-chapter"
            aria-label="Next chapter"
            onClick={nextChapter}
            disabled={!hasNextChapter}
          >
            <SkipForward size={17} />
          </button>
        ) : null}
      </div>
    </aside>
  );
}
