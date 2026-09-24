import { type Dispatch, type RefObject, type SetStateAction, useEffect } from "react";
import {
  attachNativeAudioPlayer,
  type NativeAudioQueueTrack,
  releaseNativeAudioSession,
  setNativeAudioGain
} from "./nativeAudio";
import { playbackEventOwnsPendingPlay, playbackIntentBelongsToBook } from "./playbackPending";
import { nativeAudioRecoveryScope } from "./appStorage";
import { trackOffsetSeconds } from "./formatting";
import { shouldAcceptNativeTrackChange } from "./startup";
import { audioSourceMatches } from "./usePlaybackControls";
import type { AuthUser, Book, Track } from "./types";
import type { PendingSeek } from "./playbackTypes";
import type { PlaybackGainChain } from "./playbackGain";


/**
 * Keeps the audio element (or the native player behind it) attached to the
 * current track: its source, speed, volume and gain, a pending seek, and
 * the native player's events.
 */
export function useAudioElement({
  activeTrackIndex,
  applyPlaybackVolume,
  audioRef,
  carPlaybackBookId,
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
  setSleepMinutes,
  setSleepRemaining,
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
  setSleepMinutes: Dispatch<SetStateAction<number>>;
  setSleepRemaining: Dispatch<SetStateAction<number>>;
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
      // CarPlay is driving the shared player. Attaching would load this app's
      // book over the driver's, and the next detach would stop it outright.
      // The element stays muted so nothing here can be heard over the car.
      if (audio) audio.muted = true;
      nativeAudioAttachedRef.current = false;
      return;
    }
    if (!audio || !playbackBook || !currentTrack) {
      // The player closed. The attach cleanup keeps the audio session so a
      // track change does not hand audio to other apps between chapters;
      // nothing follows this time, so give the session up. Skipped on the
      // app's first render, where a WebView reload may have left native
      // audio playing that React is about to pick back up.
      if (nativeAudioAttachedRef.current) {
        nativeAudioAttachedRef.current = false;
        void releaseNativeAudioSession();
      }
      return;
    }
    // AVPlayer receives its complete local-first queue on the initial load.
    // Attaching earlier would start a one-item player and tear it down again
    // when slower filesystem checks for later chapters completed.
    if (!nativeAudioQueueReady) return;
    nativeAudioAttachedRef.current = true;
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
        // The queue is the atomic local-first resolution. Its first item must
        // also seed AVPlayer; using the separately resolved control source can
        // overwrite a just-downloaded local chapter with its old remote URL.
        source: nativeAttachmentSource,
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
        }
      },
      (trackId, positionSeconds, _bookPositionSeconds, nativeIsPlaying) => {
        if (!playbackBook.tracks.some((track) => track.id === trackId)) return false;
        // getNativeAudioRecovery already participated in startup
        // reconciliation. A paused trackChanged event emitted while AVPlayer
        // rebuilds its queue is not a listener action and must not overwrite
        // the restored checkpoint or make the player oscillate.
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
        // The native side has already moved the control clock to the seek.
        // While a pending seek is still queued for this track it would win
        // at loadedmetadata, so retarget it rather than let the lock-screen
        // seek be undone.
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

  // Progress often arrives after preload has already emitted loadedmetadata.
  // Apply that late checkpoint as soon as the target media element is ready.
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
    // Mirrors onLoadedMetadata. A queued autoplay whose element had already
    // loaded this exact source gets no second metadata event, so without this
    // a shelf Resume onto the track that was already staged never starts.
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

  return {
    
  };
}
