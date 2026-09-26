import {
  Bookmark,
  ChevronRight,
  CircleCheck,
  Gauge,
  ListMusic,
  LoaderCircle,
  RotateCcw,
  Timer,
  Volume2,
  X
} from "lucide-react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { ChapterSegment } from "./chapters";
import { CoverArt } from "./CoverArt";
import { bookSubtitle, durationFromTracks, formatDurationLabel, formatTime } from "./formatting";
import { haptic } from "./native";
import { BookVolumeControl, PlaybackSpeedControl } from "./PlaybackControls";
import { formatSleepTimerMinutes, SLEEP_TIMER_MAX_MINUTES, SLEEP_TIMER_MIN_MINUTES } from "./sleepTimer";
import type { Book, Chapter, Progress } from "./types";

export type NativePlayerSheet = "speed" | "sleep" | "chapters" | "details" | null;

export function BookDetailsSheet({
  activeChapter,
  bookCompletionPercent,
  changeBookCompletion,
  closeNativePlayerSheet,
  completionPendingBookId,
  displayBookRemainingSeconds,
  markBookUnplayed,
  openBookDetails,
  playbackBook,
  playbackDescription,
  setNativePlayerSheet
}: {
  activeChapter: ChapterSegment | null;
  bookCompletionPercent: number | null;
  changeBookCompletion: (book: Book, finished: boolean, finalProgress?: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">, resetToUnplayed?: boolean) => Promise<boolean>;
  closeNativePlayerSheet: () => void;
  completionPendingBookId: string | null;
  displayBookRemainingSeconds: number | null;
  markBookUnplayed: (book: Book) => void;
  openBookDetails: (bookId: string) => void;
  playbackBook: Book;
  playbackDescription: string | null;
  setNativePlayerSheet: Dispatch<SetStateAction<NativePlayerSheet>>;
}) {
  return (
    <div className="sleep-sheet-layer" role="presentation">
      <button
        type="button"
        className="sleep-sheet-scrim"
        aria-label="Close book details"
        onClick={() => setNativePlayerSheet(null)}
      />
      <section className="details-sheet" role="dialog" aria-modal="true" aria-labelledby="details-sheet-title">
        <div className="details-sheet-grabber" aria-hidden="true" />
        <header className="details-sheet-header">
          <span className="eyebrow"><Bookmark size={13} /> Listening edition</span>
          <button type="button" className="icon-button" aria-label="Close" onClick={closeNativePlayerSheet}>
            <X size={18} />
          </button>
        </header>

        <div className="details-sheet-hero">
          <CoverArt book={playbackBook} size="small" />
          <div>
            <span>{activeChapter ? `Chapter ${activeChapter.chapterNumber}` : "Now playing"}</span>
            <h2 id="details-sheet-title">{playbackBook.title}</h2>
            <p>{bookSubtitle(playbackBook) || `${playbackBook.trackCount} audio tracks`}</p>
          </div>
        </div>

        {bookCompletionPercent !== null ? (
          <div className="details-sheet-progress">
            <div>
              <span>Listening progress</span>
              <strong>{bookCompletionPercent}%</strong>
            </div>
            <div className="details-sheet-progressbar" role="img" aria-label={`${bookCompletionPercent}% complete`}>
              <i style={{ width: `${bookCompletionPercent}%` }} />
            </div>
            <small>
              {displayBookRemainingSeconds !== null && displayBookRemainingSeconds <= 0
                ? "Complete"
                : displayBookRemainingSeconds !== null
                ? `${formatDurationLabel(displayBookRemainingSeconds) ?? formatTime(displayBookRemainingSeconds)} remaining`
                : "Progress unavailable"}
            </small>
          </div>
        ) : null}

        <div className="details-sheet-facts">
          <div>
            <span>Runtime</span>
            <strong>{formatDurationLabel(playbackBook.durationSeconds ?? durationFromTracks(playbackBook)) ?? "—"}</strong>
          </div>
          <div>
            <span>Published</span>
            <strong>{playbackBook.publishedDate ?? "—"}</strong>
          </div>
          <div>
            <span>Tracks</span>
            <strong>{playbackBook.trackCount}</strong>
          </div>
        </div>

        {playbackBook.metadata.publisher || playbackBook.genres.length > 0 ? (
          <div className="details-sheet-tags" aria-label="Book metadata">
            {playbackBook.metadata.publisher ? <span>{playbackBook.metadata.publisher}</span> : null}
            {playbackBook.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
          </div>
        ) : null}

        {playbackDescription ? <p className="details-sheet-description">{playbackDescription}</p> : null}

        <div className="details-sheet-actions">
          {playbackBook.progress && playbackBook.progress.status !== "notStarted" ? (
            <button
              type="button"
              className="details-sheet-reset"
              disabled={completionPendingBookId === playbackBook.id}
              onClick={() => markBookUnplayed(playbackBook)}
            >
              {completionPendingBookId === playbackBook.id
                ? <LoaderCircle size={15} className="spin-icon" />
                : <RotateCcw size={15} />}
              Mark unplayed
            </button>
          ) : null}
          <button
            type="button"
            className="details-sheet-completion"
            disabled={completionPendingBookId === playbackBook.id}
            aria-pressed={playbackBook.progress?.status === "finished"}
            onClick={() => {
              haptic("light");
              void changeBookCompletion(
                playbackBook,
                playbackBook.progress?.status !== "finished"
              );
            }}
          >
            {completionPendingBookId === playbackBook.id
              ? <LoaderCircle size={15} className="spin-icon" />
              : <CircleCheck size={15} />}
            {playbackBook.progress?.status === "finished" ? "Mark unfinished" : "Mark finished"}
          </button>
          <button
            type="button"
            className="details-sheet-full"
            onClick={() => {
              setNativePlayerSheet(null);
              openBookDetails(playbackBook.id);
            }}
          >
            Full book page <ChevronRight size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}

export function SpeedSheet({
  closeNativePlayerSheet,
  playbackBook,
  playbackCanBoost,
  playbackGain,
  setNativePlayerSheet,
  speed,
  updateBookGain,
  updateSpeed
}: {
  closeNativePlayerSheet: () => void;
  playbackBook: Book | null;
  playbackCanBoost: boolean;
  playbackGain: number;
  setNativePlayerSheet: Dispatch<SetStateAction<NativePlayerSheet>>;
  speed: number;
  updateBookGain: (book: Book, db: number) => void;
  updateSpeed: (value: number) => void;
}) {
  return (
    <div className="sleep-sheet-layer" role="presentation">
      <button
        type="button"
        className="sleep-sheet-scrim"
        aria-label="Close playback settings"
        onClick={() => setNativePlayerSheet(null)}
      />
      <section className="sleep-sheet" role="dialog" aria-modal="true" aria-labelledby="speed-sheet-title">
        <div className="sleep-sheet-grabber" aria-hidden="true" />
        <header>
          <div>
            <span className="eyebrow"><Gauge size={13} /> Cadence</span>
            <h2 id="speed-sheet-title">Playback</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={closeNativePlayerSheet}>
            <X size={18} />
          </button>
        </header>
        <p className="sleep-sheet-hint">Fine-tune the pace in 0.05× steps or jump to a familiar preset.</p>
        <PlaybackSpeedControl value={speed} onChange={updateSpeed} rotary />
        {/* Noticing a book is too quiet happens mid-chapter, so the fix
            lives with the other thing a listener reaches for while the
            book is playing rather than on the book's own page. */}
        {playbackBook ? (
          <div className="speed-sheet-volume">
            {/* The sheet labels its sections with gold eyebrows, not the
                grey card labels used on the book page. */}
            <label className="eyebrow" htmlFor="speed-sheet-book-volume">
              <Volume2 size={13} /> Book Volume
            </label>
            <p className="sleep-sheet-hint">
              Lifts this book alone, for a title mastered quieter than the rest of the shelf.
            </p>
            <BookVolumeControl
              inputId="speed-sheet-book-volume"
              value={playbackGain}
              canBoost={playbackCanBoost}
              onChange={(db) => updateBookGain(playbackBook, db)}
            />
          </div>
        ) : null}
        <button
          type="button"
          className="speed-sheet-done"
          onClick={() => {
            haptic("light");
            setNativePlayerSheet(null);
          }}
        >
          Done
        </button>
      </section>
    </div>
  );
}

export function ChapterSheet({
  activeChapter,
  chapterSegments,
  closeNativePlayerSheet,
  jumpToChapterFromSheet,
  playbackBook,
  setNativePlayerSheet
}: {
  activeChapter: ChapterSegment | null;
  chapterSegments: ChapterSegment[];
  closeNativePlayerSheet: () => void;
  jumpToChapterFromSheet: (chapter: Chapter) => void;
  playbackBook: Book;
  setNativePlayerSheet: Dispatch<SetStateAction<NativePlayerSheet>>;
}) {
  return (
    <div className="sleep-sheet-layer" role="presentation">
      <button
        type="button"
        className="sleep-sheet-scrim"
        aria-label="Close chapters"
        onClick={() => setNativePlayerSheet(null)}
      />
      <section className="sleep-sheet chapter-sheet" role="dialog" aria-modal="true" aria-labelledby="chapter-sheet-title">
        <div className="sleep-sheet-grabber" aria-hidden="true" />
        <header>
          <div>
            <span className="eyebrow"><ListMusic size={13} /> Contents</span>
            <h2 id="chapter-sheet-title">Chapters</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={closeNativePlayerSheet}>
            <X size={18} />
          </button>
        </header>
        <p className="sleep-sheet-hint">{playbackBook.title} · {playbackBook.chapters.length} markers</p>
        <div className="sleep-options chapter-sheet-options">
          {chapterSegments.map((chapter, index) => (
            <button
              type="button"
              key={chapter.id}
              className={activeChapter?.id === chapter.id ? "selected" : ""}
              onClick={() => jumpToChapterFromSheet(chapter)}
            >
              <span className="chapter-sheet-label">
                <small>{String(index + 1).padStart(2, "0")}</small>
                <strong>{chapter.title}</strong>
              </span>
              {activeChapter?.id === chapter.id ? <em>Playing</em> : <span className="chapter-sheet-time">{formatTime(chapter.durationSeconds)}</span>}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export function SleepTimerSheet({
  closeNativePlayerSheet,
  configureSleepTimer,
  setNativePlayerSheet,
  setSleepCustomDraft,
  setSleepCustomOpen,
  sleepChoices,
  sleepCustomDraft,
  sleepCustomMinutes,
  sleepCustomOpen,
  sleepMinutes,
  sleepRemaining,
  startCustomSleepTimer
}: {
  closeNativePlayerSheet: () => void;
  configureSleepTimer: (minutes: number) => void;
  setNativePlayerSheet: Dispatch<SetStateAction<NativePlayerSheet>>;
  setSleepCustomDraft: Dispatch<SetStateAction<string>>;
  setSleepCustomOpen: Dispatch<SetStateAction<boolean>>;
  sleepChoices: number[];
  sleepCustomDraft: string;
  sleepCustomMinutes: number | null;
  sleepCustomOpen: boolean;
  sleepMinutes: number;
  sleepRemaining: number;
  startCustomSleepTimer: (event: FormEvent) => void;
}) {
  return (
    <div className="sleep-sheet-layer" role="presentation">
      <button
        type="button"
        className="sleep-sheet-scrim"
        aria-label="Close sleep timer"
        onClick={() => setNativePlayerSheet(null)}
      />
      <section className="sleep-sheet" role="dialog" aria-modal="true" aria-labelledby="sleep-sheet-title">
        <div className="sleep-sheet-grabber" aria-hidden="true" />
        <header>
          <div>
            <span className="eyebrow"><Timer size={13} /> Nightfall</span>
            <h2 id="sleep-sheet-title">Sleep Timer</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={closeNativePlayerSheet}>
            <X size={18} />
          </button>
        </header>
        <p className="sleep-sheet-hint">The timer only runs while your book is playing.</p>
        <div className="sleep-options">
          {!sleepCustomOpen && sleepChoices.map((minutes) => (
            <button
              type="button"
              key={minutes}
              className={sleepMinutes === minutes && sleepRemaining > 0 ? "selected" : ""}
              onClick={() => configureSleepTimer(minutes)}
            >
              <span>{formatSleepTimerMinutes(minutes)}</span>
              {sleepMinutes === minutes && sleepRemaining > 0 ? (
                <em>{formatTime(sleepRemaining)} left</em>
              ) : (
                <ChevronRight size={17} />
              )}
            </button>
          ))}
          <button
            type="button"
            aria-expanded={sleepCustomOpen}
            aria-controls="sleep-custom-editor"
            onClick={() => {
              haptic("light");
              setSleepCustomOpen((open) => !open);
            }}
          >
            <span>Custom duration</span>
            {sleepCustomOpen ? <X size={17} /> : <ChevronRight size={17} />}
          </button>
          {!sleepCustomOpen && <button
            type="button"
            className={`sleep-off ${sleepRemaining === 0 ? "selected" : ""}`}
            onClick={() => configureSleepTimer(0)}
          >
            <span>Off</span>
            {sleepRemaining === 0 ? <em>Selected</em> : <X size={17} />}
          </button>}
        </div>
        {sleepCustomOpen ? (
          <form id="sleep-custom-editor" className="sleep-custom-editor" onSubmit={startCustomSleepTimer}>
            <label className="eyebrow" htmlFor="sleep-custom-minutes">Duration in minutes</label>
            <div className="sleep-custom sleep-custom-row">
              <input
                id="sleep-custom-minutes"
                autoFocus
                aria-describedby="sleep-custom-hint"
                type="number"
                inputMode="numeric"
                enterKeyHint="done"
                min={SLEEP_TIMER_MIN_MINUTES}
                max={SLEEP_TIMER_MAX_MINUTES}
                step={1}
                placeholder="Minutes"
                value={sleepCustomDraft}
                onChange={(event) => setSleepCustomDraft(event.currentTarget.value)}
              />
              <span className="sleep-custom-unit">min</span>
            </div>
            <p id="sleep-custom-hint" className="sleep-sheet-hint">
              {SLEEP_TIMER_MIN_MINUTES}–{SLEEP_TIMER_MAX_MINUTES} minutes · Saved for next time
            </p>
            <button className="speed-sheet-done" type="submit" disabled={sleepCustomMinutes === null}>Start timer</button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
