import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { readStoredCustomSleepTimers, writeStoredCustomSleepTimers } from "./appStorage";
import { mergeCustomSleepTimer, normalizeSleepTimerMinutes, sleepTimerChoices } from "./sleepTimer";
import { getNativeAudioSleepTimer, setNativeAudioSleepTimer } from "./nativeAudio";
import { haptic } from "./native";
import { errorMessage } from "./formatting";
import { type ChapterSegment, playedPastChapterEnd } from "./chapters";
import type { NativePlayerSheet } from "./PlayerSheets";

export function useSleepTimer({
  audioRef,
  isPlaying,
  nativeAudio,
  pausePlaybackRef,
  setNativePlayerSheet,
  setPlaybackError
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  isPlaying: boolean;
  nativeAudio: boolean;
  pausePlaybackRef: RefObject<(audio: HTMLAudioElement | null | undefined) => void>;
  setNativePlayerSheet: Dispatch<SetStateAction<NativePlayerSheet>>;
  setPlaybackError: Dispatch<SetStateAction<string | null>>;
}) {
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const [customSleepTimers, setCustomSleepTimers] = useState<number[]>(readStoredCustomSleepTimers);
  const [sleepCustomOpen, setSleepCustomOpen] = useState(false);
  const [sleepCustomDraft, setSleepCustomDraft] = useState("");
  const sleepChoices = useMemo(() => sleepTimerChoices(customSleepTimers), [customSleepTimers]);
  const sleepCustomMinutes = normalizeSleepTimerMinutes(sleepCustomDraft);
  const sleepDeadlineRef = useRef<number | null>(null);
  const sleepRemainingRef = useRef(0);
  useEffect(() => {
    sleepRemainingRef.current = sleepRemaining;
  }, [sleepRemaining]);
  // Stop at the end of the chapter being played instead of after a countdown.
  const [sleepAtChapterEnd, setSleepAtChapterEnd] = useState(false);
  const sleepAtChapterEndRef = useRef(false);
  useEffect(() => {
    sleepAtChapterEndRef.current = sleepAtChapterEnd;
  }, [sleepAtChapterEnd]);

  const sleepTimerArmed = sleepRemaining > 0;
  useEffect(() => {
    if (!isPlaying || !sleepTimerArmed) {
      if (!sleepTimerArmed) sleepDeadlineRef.current = null;
      return;
    }

    sleepDeadlineRef.current ??= Date.now() + sleepRemaining * 1000;
    // The wall-clock deadline cannot see pauses that happen while the WebView
    // is suspended, so on the native path AVPlayer's playing-time countdown is
    // authoritative and this deadline only drives the displayed value.
    const syncFromNative = () => {
      void getNativeAudioSleepTimer().then((remaining) => {
        const next = Math.ceil(remaining);
        if (next > 0) {
          sleepDeadlineRef.current = Date.now() + next * 1000;
          setSleepRemaining(next);
        }
      }).catch(() => undefined);
    };
    if (nativeAudio) syncFromNative();
    const timer = window.setInterval(() => {
      const deadline = sleepDeadlineRef.current;
      if (deadline === null) return;
      const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (next === 0 && nativeAudio) {
        // Native owns expiry: it pauses AVPlayer and emits sleepTimerEnded,
        // which clears this state. Zeroing the native timer here would disarm
        // a countdown that may legitimately still hold minutes after a pause
        // this clock never saw.
        syncFromNative();
        return;
      }
      setSleepRemaining(next);
      if (next === 0) {
        sleepDeadlineRef.current = null;
        pausePlaybackRef.current(audioRef.current);
        setSleepMinutes(0);
      }
    }, 1000);

    return () => {
      window.clearInterval(timer);
      const deadline = sleepDeadlineRef.current;
      if (deadline === null) return;
      sleepDeadlineRef.current = null;
      // On the native path the countdown keeps its true value in AVPlayer and
      // re-syncs when the effect re-arms; recomputing from the wall clock here
      // could zero the UI while the native timer still holds minutes.
      if (nativeAudio) return;
      const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSleepRemaining(next);
      if (next === 0) setSleepMinutes(0);
    };
    // sleepRemaining seeds the deadline once when the timer arms; after that
    // the deadline ref drives the countdown, and re-arming on every tick
    // would reset it each second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, nativeAudio, sleepTimerArmed]);

  function configureSleepTimer(minutes: number, atChapterEnd = false) {
    haptic("light");
    sleepDeadlineRef.current = isPlaying && minutes > 0
      ? Date.now() + minutes * 60 * 1000
      : null;
    setSleepMinutes(minutes);
    setSleepRemaining(minutes * 60);
    setSleepAtChapterEnd(atChapterEnd);
    if (nativeAudio) {
      void setNativeAudioSleepTimer(minutes * 60, atChapterEnd).catch((error) => {
        // Nothing enforces the timer once the WebView is suspended, so
        // showing it armed after a failed native call would be a lie.
        sleepDeadlineRef.current = null;
        setSleepMinutes(0);
        setSleepRemaining(0);
        setSleepAtChapterEnd(false);
        setPlaybackError(errorMessage(error, "The sleep timer could not be configured."));
      });
    }
    setSleepCustomOpen(false);
    setSleepCustomDraft("");
    setNativePlayerSheet(null);
  }

  /**
   * A duration the listener typed. It is remembered before being armed so it
   * stays one tap away tomorrow night, whether or not tonight's timer runs out.
   */
  function startCustomSleepTimer(event: React.FormEvent) {
    event.preventDefault();
    const minutes = normalizeSleepTimerMinutes(sleepCustomDraft);
    if (minutes === null) return;
    const remembered = mergeCustomSleepTimer(customSleepTimers, minutes);
    setCustomSleepTimers(remembered);
    writeStoredCustomSleepTimers(remembered);
    configureSleepTimer(minutes);
  }

  return {
    configureSleepTimer,
    setSleepCustomDraft,
    setSleepAtChapterEnd,
    setSleepCustomOpen,
    setSleepMinutes,
    setSleepRemaining,
    sleepAtChapterEnd,
    sleepAtChapterEndRef,
    sleepChoices,
    sleepCustomDraft,
    sleepCustomMinutes,
    sleepCustomOpen,
    sleepDeadlineRef,
    sleepMinutes,
    sleepRemaining,
    sleepRemainingRef,
    startCustomSleepTimer
  };
}

/**
 * The web player's end-of-chapter stop within a track. The native player
 * watches for the boundary itself, and a chapter that ends with its file is
 * caught where the next track would otherwise start.
 */
export function useChapterEndSleep({
  armed,
  audioRef,
  bookId,
  bookPosition,
  chapterSegments,
  intentionalSeekGenerationRef,
  pausePlaybackRef,
  setSleepAtChapterEnd
}: {
  armed: boolean;
  audioRef: RefObject<HTMLAudioElement | null>;
  bookId: string | null;
  bookPosition: number;
  chapterSegments: ChapterSegment[];
  intentionalSeekGenerationRef: RefObject<Map<string, number>>;
  pausePlaybackRef: RefObject<(audio: HTMLAudioElement | null | undefined) => void>;
  setSleepAtChapterEnd: Dispatch<SetStateAction<boolean>>;
}) {
  const previousRef = useRef<{
    segments: ChapterSegment[];
    position: number;
    seekGeneration: number;
  } | null>(null);
  useEffect(() => {
    const previous = previousRef.current;
    const seekGeneration = bookId ? intentionalSeekGenerationRef.current.get(bookId) ?? 0 : 0;
    previousRef.current = armed
      ? { segments: chapterSegments, position: bookPosition, seekGeneration }
      : null;
    // Positions from another book's chapters say nothing about this one, and
    // a seek that lands just past a boundary is not the chapter ending.
    if (
      !armed
      || !previous
      || previous.segments !== chapterSegments
      || previous.seekGeneration !== seekGeneration
    ) return;
    if (!playedPastChapterEnd(chapterSegments, previous.position, bookPosition)) return;
    setSleepAtChapterEnd(false);
    pausePlaybackRef.current(audioRef.current);
  }, [
    armed,
    audioRef,
    bookId,
    bookPosition,
    chapterSegments,
    intentionalSeekGenerationRef,
    pausePlaybackRef,
    setSleepAtChapterEnd
  ]);
}
