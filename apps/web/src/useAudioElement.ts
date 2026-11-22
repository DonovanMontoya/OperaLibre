import { type Dispatch, type RefObject, type SetStateAction, useEffect } from "react";
import { flushSync } from "react-dom";
import {
  attachNativeAudioPlayer,
  forgetDetachedNativeClock,
  type NativeAudioQueueTrack,
  releaseNativeAudioSession,
  setNativeAudioGain
} from "./nativeAudio";
import { playbackEventOwnsPendingPlay, playbackIntentBelongsToBook } from "./playbackPending";
import { getServerStorageKey } from "./api";
import { forgetInterruptedClipPreview, interruptedClipPreviewStart, type ClipPreviewFlag } from "./clips";
import { nativeAudioRecoveryScope } from "./appStorage";
import { trackOffsetSeconds } from "./formatting";
import { shouldAcceptNativeTrackChange } from "./startup";
import { audioSourceMatches } from "./usePlaybackControls";
import type { AuthUser, Book, Track } from "./types";
import type { PendingSeek } from "./playbackTypes";
import type { PlaybackGainChain } from "./playbackGain";

export function useAudioElement({
  activeTrackIndex,
  applyPlaybackVolume,
  audioRef,
  carPlaybackBookId,
  clipPreviewBookIdRef,
  currentTrack,
  currentTrackKey,
  currentUser,
  foregroundProgressSyncRef,
  gainChain,
  markPlaybackTouchedRef,
  nativeAttachmentSource,
  nativeAudio,
  nativeAudioAttachedRef,
  nativeAudioQueueReady,
  nativeAudioQueueRef,
  nativePlaybackPlayingRef,
  pendingSeek,
  pendingSeekRef,
  persistProgressRef,
  playPendingBookIdRef,
  playPendingRef,
  playWhenTrackLoads,
  playbackActionVersionRef,
  playbackBook,
  playbackBookKey,
  playbackGain,
  playbackGainRef,
  playbackSettingsRef,
  requiredNativeAudioQueueKey,
  resumeAutoplayPendingRef,
  scheduleStartupReveal,
  setCurrentTrackId,
  setDuration,
  setNativeAudioFailed,
  setPendingSeek,
  setPlayPending,
  setPlaybackError,
  setPlaybackPosition,
  setPosition,
  setSleepAtChapterEnd,
  setSleepMinutes,
  setSleepRemaining,
  sleepAtChapterEndRef,
  sleepDeadlineRef,
  sleepRemainingRef,
  speed,
  startPlayback,
  startupViewReadyRef,
  streamUrl,
  volume,
  wantsAutoplayRef
}: {
  activeTrackIndex: number;
  applyPlaybackVolume: (audio: HTMLAudioElement) => void;
  audioRef: RefObject<HTMLAudioElement | null>;
  carPlaybackBookId: string | null;
  clipPreviewBookIdRef: ClipPreviewFlag;
  currentTrack: Track | null;
  currentTrackKey: string | null;
  currentUser: AuthUser;
  foregroundProgressSyncRef: RefObject<{ nativeStateSynchronized(): void; dispose(): void; } | null>;
  gainChain: () => PlaybackGainChain;
  markPlaybackTouchedRef: RefObject<(deliberateSeek?: boolean, seekBookId?: string, interruptRestore?: boolean, seekTargetBookPosition?: number) => void>;
  nativeAttachmentSource: string;
  nativeAudio: boolean;
  nativeAudioAttachedRef: RefObject<boolean>;
  nativeAudioQueueReady: boolean;
  nativeAudioQueueRef: RefObject<NativeAudioQueueTrack[]>;
  nativePlaybackPlayingRef: RefObject<boolean>;
  pendingSeek: PendingSeek | null;
  pendingSeekRef: RefObject<PendingSeek | null>;
  persistProgressRef: RefObject<() => Promise<void>>;
  playPendingBookIdRef: RefObject<string | null>;
  playPendingRef: RefObject<boolean>;
  playWhenTrackLoads: RefObject<boolean>;
  playbackActionVersionRef: RefObject<number>;
  playbackBook: Book | null;
  playbackBookKey: string | null;
  playbackGain: number;
  playbackGainRef: RefObject<number>;
  playbackSettingsRef: RefObject<{ rate: number; volume: number; }>;
  requiredNativeAudioQueueKey: string | null;
  resumeAutoplayPendingRef: RefObject<boolean>;
  scheduleStartupReveal: () => void;
  setCurrentTrackId: Dispatch<SetStateAction<string | null>>;
  setDuration: Dispatch<SetStateAction<number>>;
  setNativeAudioFailed: Dispatch<SetStateAction<boolean>>;
  setPendingSeek: (value: PendingSeek | null) => void;
  setPlayPending: (pending: boolean, bookId?: string | null) => void;
  setPlaybackError: Dispatch<SetStateAction<string | null>>;
  setPlaybackPosition: (audio: HTMLAudioElement, value: number) => number;
  setPosition: Dispatch<SetStateAction<number>>;
  setSleepAtChapterEnd: Dispatch<SetStateAction<boolean>>;
  setSleepMinutes: Dispatch<SetStateAction<number>>;
  setSleepRemaining: Dispatch<SetStateAction<number>>;
  sleepAtChapterEndRef: RefObject<boolean>;
  sleepDeadlineRef: RefObject<number | null>;
  sleepRemainingRef: RefObject<number>;
  speed: number;
  startPlayback: (audio: HTMLAudioElement | null | undefined, interruptRestore?: boolean) => void;
  startupViewReadyRef: RefObject<boolean>;
  streamUrl: string;
  volume: number;
  wantsAutoplayRef: RefObject<boolean>;
}) {
  useEffect(() => {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.playbackRate = speed;
  }, [audioRef, speed, currentTrackKey, nativeAudio]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!nativeAudio) return;
    if (carPlaybackBookId) {
      if (audio) {
        audio.muted = true;
        forgetDetachedNativeClock(audio);
      }
      nativeAudioAttachedRef.current = false;
      return;
    }
    if (!audio || !playbackBook || !currentTrack) {
      if (nativeAudioAttachedRef.current) {
        nativeAudioAttachedRef.current = false;
        void releaseNativeAudioSession();
      }
      return;
    }
    if (!nativeAudioQueueReady) return;
    nativeAudioAttachedRef.current = true;
    const actionVersionAtAttach = playbackActionVersionRef.current;
    const pendingSeekAtAttach = pendingSeekRef.current;
    const serverKey = getServerStorageKey();
    const previewStartedAt = interruptedClipPreviewStart(window.localStorage, serverKey, currentUser.id, playbackBook.id);
    return attachNativeAudioPlayer(
      audio,
      (message) => {
        setPlaybackError(message);
      },
      (position, resume) => {
        const ownsIntent = playbackEventOwnsPendingPlay(
          playPendingRef.current,
          playPendingBookIdRef.current,
          playbackBook.id
        );
        const resumeThisBook = resume && ownsIntent;
        setPendingSeek({ trackId: currentTrack.id, positionSeconds: position });
        playWhenTrackLoads.current = resumeThisBook;
        if (ownsIntent) setPlayPending(resumeThisBook, playbackBook.id);
        setNativeAudioFailed(true);
      },
      {
        source: nativeAttachmentSource,
        clipPreview: () => clipPreviewBookIdRef.previewingBookId === playbackBook.id,
        awaitingReturn: () => clipPreviewBookIdRef.returningBookId === playbackBook.id,
        allowAdoption: previewStartedAt === null,
        normalPositionReady: (positionSeconds) => {
          if (clipPreviewBookIdRef.current === playbackBook.id) {
            if (!clipPreviewBookIdRef.confirmReturn(playbackBook.id, trackOffsetSeconds(playbackBook, activeTrackIndex) + positionSeconds)) return false;
            void persistProgressRef.current();
          }
          const startedAt = interruptedClipPreviewStart(window.localStorage, serverKey, currentUser.id, playbackBook.id);
          if (startedAt !== null && clipPreviewBookIdRef.current !== playbackBook.id) {
            forgetInterruptedClipPreview(window.localStorage, serverKey, currentUser.id, playbackBook.id, startedAt);
          }
          return true;
        },
        settings: () => playbackSettingsRef.current,
        scopeKey: nativeAudioRecoveryScope(currentUser.id, playbackBook.id),
        trackId: currentTrack.id,
        bookOffsetSeconds: trackOffsetSeconds(playbackBook, activeTrackIndex),
        queue: () => nativeAudioQueueRef.current,
        pendingPosition: () => pendingSeekRef.current?.trackId === currentTrack.id
          ? pendingSeekRef.current.positionSeconds : undefined,
        wantsPlayback: () => playbackIntentBelongsToBook(
          playPendingRef.current,
          playPendingBookIdRef.current,
          playbackBook.id,
          wantsAutoplayRef.current || playWhenTrackLoads.current
        ),
        gain: () => playbackGainRef.current,
        sleepTimerSeconds: () => {
          const deadline = sleepDeadlineRef.current;
          if (deadline !== null) return Math.max(0, (deadline - Date.now()) / 1000);
          return sleepRemainingRef.current;
        },
        sleepAtChapterEnd: () => sleepAtChapterEndRef.current,
        adopted: ({ positionSeconds, sleepTimerSeconds, sleepAtChapterEnd }) => {
          flushSync(() => {
            const listenerSeeked = playbackActionVersionRef.current !== actionVersionAtAttach
              && pendingSeekRef.current !== pendingSeekAtAttach;
            markPlaybackTouchedRef.current();
            nativePlaybackPlayingRef.current = true;
            playWhenTrackLoads.current = false;
            if (!listenerSeeked) {
              setPendingSeek(null);
              setPosition(positionSeconds);
            }
            const remaining = Math.ceil(sleepTimerSeconds);
            sleepDeadlineRef.current = remaining > 0 ? Date.now() + remaining * 1000 : null;
            sleepAtChapterEndRef.current = sleepAtChapterEnd;
            setSleepRemaining(remaining);
            setSleepMinutes(remaining > 0 ? Math.ceil(remaining / 60) : 0);
            setSleepAtChapterEnd(sleepAtChapterEnd);
          });
          scheduleStartupReveal();
        }
      },
      (trackId, positionSeconds, _bookPositionSeconds, nativeIsPlaying) => {
        if (!playbackBook.tracks.some((track) => track.id === trackId)) return false;
        if (!shouldAcceptNativeTrackChange(startupViewReadyRef.current, nativeIsPlaying)) return false;
        markPlaybackTouchedRef.current();
        nativePlaybackPlayingRef.current = nativeIsPlaying;
        playWhenTrackLoads.current = nativeIsPlaying;
        wantsAutoplayRef.current = nativeIsPlaying;
        setCurrentTrackId(trackId);
        setPendingSeek({ trackId, positionSeconds });
        setPosition(positionSeconds);
        setDuration(playbackBook.tracks.find((track) => track.id === trackId)?.durationSeconds ?? 0);
        scheduleStartupReveal();
        return true;
      },
      () => {
        const nativePosition = Math.max(0, audio.currentTime);
        markPlaybackTouchedRef.current(
          true,
          undefined,
          true,
          trackOffsetSeconds(playbackBook, activeTrackIndex) + nativePosition
        );
        if (pendingSeekRef.current?.trackId === currentTrack.id) {
          setPendingSeek({ trackId: currentTrack.id, positionSeconds: nativePosition });
          setPosition(nativePosition);
        }
        void persistProgressRef.current();
      },
      () => {
        sleepDeadlineRef.current = null;
        setSleepMinutes(0);
        setSleepRemaining(0);
        setSleepAtChapterEnd(false);
      },
      () => {
        foregroundProgressSyncRef.current?.nativeStateSynchronized();
      }
    );
    // Attaching rebuilds the AVPlayer queue, so this is keyed on identity:
    // playbackBook, currentTrack and activeTrackIndex through their ids, and
    // functions with render state go through refs above. setPlayPending
    // touches only refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    carPlaybackBookId,
    currentTrackKey,
    currentUser.id,
    nativeAudio,
    nativeAudioQueueReady,
    playbackBookKey,
    requiredNativeAudioQueueKey,
    nativeAttachmentSource,
    scheduleStartupReveal
  ]);

  useEffect(() => {
    const audio = audioRef.current;
    if (
      pendingSeek === null ||
      pendingSeek.trackId !== currentTrackKey ||
      !audio ||
      audio.readyState < HTMLMediaElement.HAVE_METADATA ||
      !audioSourceMatches(audio, streamUrl)
    ) {
      return;
    }
    const restoredPosition = Math.max(
      0,
      Math.min(pendingSeek.positionSeconds, audio.duration || pendingSeek.positionSeconds)
    );
    if (!nativeAudio || Math.abs(audio.currentTime - restoredPosition) > 0.75) {
      setPlaybackPosition(audio, restoredPosition);
    }
    setPosition(restoredPosition);
    setPendingSeek(null);
    if (playWhenTrackLoads.current) {
      playWhenTrackLoads.current = false;
      startPlayback(audio, !resumeAutoplayPendingRef.current);
      resumeAutoplayPendingRef.current = false;
    }
    // setPlaybackPosition and startPlayback run synchronously here, from the
    // render being committed; listing them would re-run the seek every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackKey, pendingSeek, streamUrl, nativeAudio]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    applyPlaybackVolume(audio);
    if (gainChain().isAttachedTo(audio)) gainChain().setGain(playbackGain);
    if (nativeAudio) void setNativeAudioGain(playbackGain).catch(() => undefined);
    // applyPlaybackVolume reads only volume, playbackGain and nativeAudio,
    // all listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, playbackGain, nativeAudio, currentTrackKey]);

  playbackGainRef.current = playbackGain;
}
