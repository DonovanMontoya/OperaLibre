import { ArrowRight, Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { mediaUrl } from "./api";
import { formatTime } from "./formatting";
import type { Book } from "./types";

const PREVIEW_SECONDS = 5 * 60;

export type PreviewPosition = { trackId: string; positionSeconds: number; bookPositionSeconds: number };

/** Separate audio keeps samples out of playback restoration, reporting, and progress sync. */
export function BookPreviewBar({ book, active, onStart, onStop, onContinue }: {
  book: Book;
  active: boolean;
  onStart: () => void;
  onStop: () => void;
  onContinue: (position?: PreviewPosition) => Promise<boolean>;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [trackIndex, setTrackIndex] = useState(0);
  const consumedRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pending, setPending] = useState(false);
  const [finished, setFinished] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playGeneration = useRef(0);
  const track = book.tracks[trackIndex];
  const streamPath = track?.streamUrl;
  const trackId = track?.id;
  const knownDuration = book.tracks.every(t => t.durationSeconds !== null && t.durationSeconds > 0)
    ? book.tracks.reduce((sum, t) => sum + t.durationSeconds!, 0) : PREVIEW_SECONDS;
  const total = Math.min(PREVIEW_SECONDS, knownDuration);

  function stop() {
    playGeneration.current += 1;
    audioRef.current?.pause();
    setPlaying(false);
    setPending(false);
  }

  async function play() {
    const audio = audioRef.current;
    if (!audio) return;
    const generation = ++playGeneration.current;
    setError(null);
    setPending(true);
    if (audio.error) audio.load();
    try {
      await audio.play();
      if (generation === playGeneration.current) setPending(false);
    } catch (cause) {
      if (generation !== playGeneration.current) return;
      setPending(false);
      setPlaying(false);
      setError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "Press Play preview to listen."
        : "The preview could not play. Check your server connection and try again.");
    }
  }

  function updateTime() {
    const audio = audioRef.current;
    if (!audio) return;
    const next = consumedRef.current + audio.currentTime;
    setElapsed(Math.min(total, next));
    if (next >= total) {
      stop();
      setFinished(true);
    }
  }

  function nextTrack() {
    const audio = audioRef.current;
    if (!audio) return;
    const consumed = consumedRef.current + audio.currentTime;
    if (consumed >= total || trackIndex + 1 >= book.tracks.length) {
      stop();
      setElapsed(Math.min(total, consumed));
      setFinished(true);
      return;
    }
    consumedRef.current = consumed;
    setElapsed(consumed);
    setTrackIndex(index => index + 1);
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !streamPath || !trackId || !active) return;
    audio.src = mediaUrl(streamPath);
    void play();
    return () => {
      playGeneration.current += 1;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, [streamPath, trackId, active]);

  // timeupdate can be infrequent; only run a clock while the sample is playing.
  const tick = useEffectEvent(updateTime);
  const pauseForBackground = useEffectEvent(() => {
    if (document.hidden) stop();
  });
  useEffect(() => {
    document.addEventListener("visibilitychange", pauseForBackground);
    return () => document.removeEventListener("visibilitychange", pauseForBackground);
  }, []);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [playing, trackIndex]);

  useEffect(() => {
    if (active) return;
    consumedRef.current = 0;
    setTrackIndex(0);
    setElapsed(0);
    setPlaying(false);
    setPending(false);
    setFinished(false);
    setError(null);
  }, [active]);

  function replay() {
    stop();
    consumedRef.current = 0;
    setElapsed(0);
    setFinished(false);
    if (trackIndex !== 0) setTrackIndex(0);
    else if (audioRef.current) {
      audioRef.current.currentTime = 0;
      void play();
    }
  }

  async function continueListening() {
    const audio = audioRef.current;
    const position = Math.max(0, elapsed - consumedRef.current);
    const hasMore = trackIndex + 1 < book.tracks.length
      || (!!audio && Number.isFinite(audio.duration) && position < audio.duration - 0.5);
    stop();
    setContinuing(true);
    setError(null);
    const started = await onContinue(hasMore && track ? {
      trackId: track.id,
      positionSeconds: position,
      bookPositionSeconds: elapsed
    } : undefined);
    setContinuing(false);
    if (!started) setError("Could not check your saved position. Try Continue listening again.");
  }

  return (
    <section className="book-sample" aria-label={`Audio preview of ${book.title}`}>
      {active ? <audio ref={audioRef} preload="none" onPlay={() => { if (document.hidden) stop(); else setPlaying(true); }} onPause={() => setPlaying(false)}
        onTimeUpdate={updateTime} onEnded={nextTrack} onError={() => {
          stop();
          setError("Preview unavailable. Check your connection and try again.");
        }} /> : null}
      <div className={`book-sample-bar ${playing ? "is-playing" : ""}`}>
        <button type="button" className="book-sample-play" disabled={continuing}
          aria-label={finished ? "Replay preview" : playing || pending ? "Pause preview" : `Listen to a preview of ${book.title}`}
          onClick={() => {
            if (!active) onStart();
            else if (finished) replay();
            else if (playing || pending) stop();
            else void play();
          }}>
          {playing || pending ? <Pause size={15} fill="currentColor" /> : finished ? <RotateCcw size={15} /> : <Play size={15} fill="currentColor" />}
        </button>
        <div className="book-sample-timeline">
          <div className="book-sample-caption"><span>{finished ? "Finished" : "Preview"}</span><time>{formatTime(active ? elapsed : total)}</time></div>
          <progress aria-label="Preview position" max={total} value={elapsed} />
        </div>
      </div>
      {error ? <p className="book-sample-status" role="alert">{error}</p> : null}
      {finished ? (
        <div className="book-sample-finished">
          <span className="sr-only" role="status">Preview finished</span>
          <button type="button" className="book-sample-continue" disabled={continuing} aria-busy={continuing} onClick={() => void continueListening()}>
            {continuing ? "Checking progress…" : "Continue listening"} <ArrowRight size={13} />
          </button>
        </div>
      ) : null}
      {active && !finished && elapsed > 0 ? (
        <button type="button" className="book-sample-reset" onClick={() => { stop(); onStop(); }}>Reset preview</button>
      ) : null}
    </section>
  );
}
