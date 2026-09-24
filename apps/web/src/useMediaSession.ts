import { type RefObject, useEffect, useRef } from "react";
import type { ChapterSegment } from "./chapters";

export function useMediaSession({
  activeChapter,
  audioRef,
  chapterDuration,
  chapterElapsed,
  currentTrackKey,
  nativeAudio,
  nextChapter,
  pausePlayback,
  position,
  restartOrPreviousChapter,
  seekBookPosition,
  seekBy,
  seekTo,
  sliderMax,
  speed,
  startPlayback
}: {
  activeChapter: ChapterSegment | null;
  audioRef: RefObject<HTMLAudioElement | null>;
  chapterDuration: number;
  chapterElapsed: number;
  currentTrackKey: string | null;
  nativeAudio: boolean;
  nextChapter: () => void;
  pausePlayback: (audio: HTMLAudioElement | null | undefined) => void;
  position: number;
  restartOrPreviousChapter: () => void;
  seekBookPosition: (value: number, autoPlay?: boolean) => void;
  seekBy: (delta: number) => void;
  seekTo: (value: number) => void;
  sliderMax: number;
  speed: number;
  startPlayback: (audio: HTMLAudioElement | null | undefined, interruptRestore?: boolean) => void;
}) {
  // Lock-screen and hardware-key handlers are registered once and delegate
  // through this ref, which every render refreshes. Registering the handlers
  // themselves was keyed on the chapter and track, so between re-registrations
  // they held closures from an earlier render: "previous" saw a chapter
  // elapsed of 0 and never restarted the chapter, and "play" engaged the
  // gain chain with a stale gain.
  const mediaSessionHandlersRef = useRef({
    startPlayback,
    pausePlayback,
    seekBy,
    seekTo,
    seekBookPosition,
    restartOrPreviousChapter,
    nextChapter,
    activeChapter
  });

  useEffect(() => {
    if (nativeAudio || !("mediaSession" in navigator)) return;
    const handlers = mediaSessionHandlersRef;
    const session = navigator.mediaSession;
    session.setActionHandler("play", () => handlers.current.startPlayback(audioRef.current));
    session.setActionHandler("pause", () => handlers.current.pausePlayback(audioRef.current));
    session.setActionHandler("seekbackward", () => handlers.current.seekBy(-15));
    session.setActionHandler("seekforward", () => handlers.current.seekBy(30));
    session.setActionHandler("previoustrack", () => handlers.current.restartOrPreviousChapter());
    session.setActionHandler("nexttrack", () => handlers.current.nextChapter());
    session.setActionHandler("seekto", (details) => {
      if (details.seekTime === undefined) return;
      const { activeChapter: chapter, seekBookPosition: seekBook, seekTo: seek } = handlers.current;
      if (chapter) {
        seekBook(chapter.startSeconds + details.seekTime);
      } else {
        seek(details.seekTime);
      }
    });
    return () => {
      for (const action of [
        "play", "pause", "seekbackward", "seekforward", "previoustrack", "nexttrack", "seekto"
      ] as MediaSessionAction[]) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // An action the browser does not know cannot have been registered.
        }
      }
    };
  }, [audioRef, nativeAudio]);

  const activeChapterId = activeChapter?.id ?? null;
  useEffect(() => {
    if (nativeAudio || !("mediaSession" in navigator) || !currentTrackKey) return;
    const duration = activeChapterId !== null ? chapterDuration : Math.max(1, sliderMax);
    const lockPosition = activeChapterId !== null ? chapterElapsed : position;
    if (!Number.isFinite(duration) || !Number.isFinite(lockPosition) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.max(0, Math.min(lockPosition, duration)),
        playbackRate: speed
      });
    } catch {
      // Some WebViews expose Media Session metadata without position state.
    }
  }, [activeChapterId, chapterDuration, chapterElapsed, currentTrackKey, nativeAudio, position, sliderMax, speed]);

  return {
    activeChapterId,
    mediaSessionHandlersRef
  };
}
