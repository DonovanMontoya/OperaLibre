import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CoverArt } from "./CoverArt";
import { foldTrace, holdsCoverThroughHandoff, isHingeParted, useDeviceFold } from "./deviceFold";
import { formatTime } from "./formatting";
import { createScreenAwakeController } from "./screenAwake";
import { SHORT_LANDSCAPE_QUERY } from "./useOrientation";
import type { ChapterSegment } from "./chapters";
import type { Book, Track } from "./types";

// The cover screen is under 500 points on its short side; the inner screen
// and other phones' are not.
const COVER_SIZED_QUERY = "(max-width: 499px), (max-height: 499px)";

/**
 * A folded iPhone Duo stood on its edges like a tent, cover screen sideways,
 * trades the app for a dashboard of the book that is playing for as long as
 * it stays that way. The hinge says the halves have parted and the cover's
 * orientation says it is on its side; a phone merely held sideways, closed,
 * keeps the app. The open reader keeps the sideways layout it was built for.
 */
export function useDeskView(native: boolean, ipad: boolean, hasBook: boolean, readerOpen: boolean): boolean {
  const [screen, setScreen] = useState(() => ({ onCover: true, sideways: false, coverWasSideways: false }));
  const fold = useDeviceFold();
  const wasTent = useRef(false);
  const tent = isHingeParted(fold, wasTent.current);
  useEffect(() => {
    wasTent.current = tent;
  }, [tent]);
  useEffect(() => {
    const sidewaysQuery = window.matchMedia(SHORT_LANDSCAPE_QUERY);
    const coverQuery = window.matchMedia(COVER_SIZED_QUERY);
    const update = () => setScreen((previous) => {
      const onCover = coverQuery.matches;
      const sideways = sidewaysQuery.matches;
      // Off the cover, remember how the cover was held.
      const coverWasSideways = onCover ? sideways : previous.coverWasSideways;
      return previous.onCover === onCover && previous.sideways === sideways
        && previous.coverWasSideways === coverWasSideways
        ? previous
        : { onCover, sideways, coverWasSideways };
    });
    update();
    sidewaysQuery.addEventListener("change", update);
    coverQuery.addEventListener("change", update);
    return () => {
      sidewaysQuery.removeEventListener("change", update);
      coverQuery.removeEventListener("change", update);
    };
  }, []);
  const showing = screen.onCover
    ? screen.sideways && tent
    : holdsCoverThroughHandoff(fold, screen.coverWasSideways);
  const result = native && !ipad && showing && hasBook && !readerOpen;
  // TEMP-TRACE
  useEffect(() => {
    foldTrace(`desk ${result} onCover ${screen.onCover} sideways ${screen.sideways} coverWasSideways ${screen.coverWasSideways} tent ${tent} posture ${fold.posture} angle ${fold.angle ?? "-"} viewport ${innerWidth}x${innerHeight}`);
  }, [result, screen, tent, fold]);
  return result;
}

// How long a long title rests on its ellipsis between scrolls.
const TITLE_SCROLL_REST_MS = 6000;

/**
 * A title too long for its line scrolls through now and then while the book
 * plays, the way CarPlay does, then settles back on its ellipsis. Each scroll
 * is a single run so nothing animates while it rests or while paused.
 */
function useTitleScroll(title: string, playing: boolean) {
  const ref = useRef<HTMLHeadingElement>(null);
  const [overflow, setOverflow] = useState(0);
  const [scrolling, setScrolling] = useState(false);
  useLayoutEffect(() => {
    const heading = ref.current;
    if (!heading) return;
    setScrolling(false);
    const measure = () => setOverflow(Math.max(0, heading.scrollWidth - heading.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(heading);
    return () => observer.disconnect();
  }, [title]);
  useEffect(() => {
    if (!playing || overflow === 0 || scrolling) return;
    const timer = window.setTimeout(() => setScrolling(true), TITLE_SCROLL_REST_MS);
    return () => window.clearTimeout(timer);
  }, [overflow, playing, scrolling]);
  const style = scrolling
    ? ({
        "--desk-title-shift": `-${overflow}px`,
        // About 40px a second each way, with a pause at the end.
        "--desk-title-run": `${Math.max(3, overflow / 40 / 0.4).toFixed(1)}s`
      } as CSSProperties)
    : undefined;
  return { ref, scrolling, style, onAnimationEnd: () => setScrolling(false) };
}

export function DeskView({
  activeChapter,
  chapterDuration,
  chapterElapsed,
  currentTrack,
  isPlaying,
  playPending,
  playbackBook,
  seekBy,
  togglePlayback
}: {
  activeChapter: ChapterSegment | null;
  chapterDuration: number;
  chapterElapsed: number;
  currentTrack: Track;
  isPlaying: boolean;
  playPending: boolean;
  playbackBook: Book;
  seekBy: (delta: number) => void;
  togglePlayback: () => void;
}) {
  const title = activeChapter?.title ?? currentTrack.title;
  const titleScroll = useTitleScroll(title, isPlaying);
  const elapsed = Math.min(chapterElapsed, chapterDuration);
  const fraction = chapterDuration > 0 ? elapsed / chapterDuration : 0;

  // A propped-up phone is being watched, not held; keep it lit while it plays.
  useEffect(() => {
    if (!isPlaying) return;
    const screenAwake = createScreenAwakeController();
    screenAwake.setReadingActive(true);
    return () => screenAwake.dispose();
  }, [isPlaying]);

  return (
    <section className="desk-view" aria-label="Desk view">
      <div className="desk-stage">
        <div className="desk-cover"><CoverArt book={playbackBook} size="small" /></div>
        <div className="desk-info">
          <h2
            ref={titleScroll.ref}
            className={titleScroll.scrolling ? "desk-title-scrolling" : undefined}
            style={titleScroll.style}
            onAnimationEnd={titleScroll.onAnimationEnd}
          >
            <span>{title}</span>
          </h2>
          {playbackBook.author ? <p>{playbackBook.author}</p> : null}
          <p>{playbackBook.title}</p>

          <div className="desk-progress" aria-hidden="true">
            <span style={{ transform: `scaleX(${fraction})` }} />
          </div>
          <div className="desk-progress-times">
            <span>{formatTime(elapsed)}</span>
            <span>-{formatTime(chapterDuration - elapsed)}</span>
          </div>

          <div className="desk-transport">
            <button type="button" aria-label="Rewind 15 seconds" onClick={() => seekBy(-15)}>
              <RotateCcw size={52} strokeWidth={2} />
              <small>15</small>
            </button>
            <button
              type="button"
              className={playPending ? "play-pending" : undefined}
              aria-label={playPending ? "Cancel play" : isPlaying ? "Pause" : "Play"}
              aria-busy={playPending}
              onClick={togglePlayback}
            >
              {isPlaying || playPending ? <Pause size={64} fill="currentColor" strokeWidth={0} /> : <Play size={64} fill="currentColor" strokeWidth={0} />}
            </button>
            <button type="button" aria-label="Forward 30 seconds" onClick={() => seekBy(30)}>
              <RotateCw size={52} strokeWidth={2} />
              <small>30</small>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
