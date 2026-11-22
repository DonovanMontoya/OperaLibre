import { type Dispatch, type RefObject, type SetStateAction, useRef } from "react";
import type { AuthUser, Book, Progress, Track } from "./types";
import { trackOffsetSeconds } from "./formatting";
import {
  adoptableServerProgress,
  freshestProgress,
  pendingProgress,
  rebasePendingProgress,
  syncedProgress,
  progressAfterSave,
  readProgressCheckpoint,
  resolveProgressLocation,
  saveWasOverruled,
  serverRevisionFromSummary,
  shouldFlagIntentionalRegression,
  summarizeBookProgress,
  writeProgressCheckpoint
} from "./reliability";
import { getProgress, getServerStorageKey, saveProgress } from "./api";
import { cacheProgress, getCachedProgress, warnCacheFailure } from "./offline";
import { getDeviceBooks, saveDeviceProgress } from "./localLibrary";
import type { PendingSeek, QueuedProgressSave } from "./playbackTypes";
import type { NativeForegroundSyncGate } from "./nativeAudioState";
import type { NativePlayerSheet } from "./PlayerSheets";
import type { NativeTab } from "./nativeTabs";
import { acknowledgeProgressSeekIntent, progressSeekStorage, progressSeekOptions, readProgressSeekIntent } from "./progressSeekIntent";


export function useProgressSync({
  clipPreviewBookIdRef,
  acknowledgedSeekGenerationRef,
  acknowledgedServerPositionRef,
  activeTrackIndex,
  audioRef,
  books,
  currentTrack,
  currentUser,
  foregroundAdoptInFlightRef,
  intentionalSeekGenerationRef,
  intentionalSeekTargetRef,
  native,
  nativeAudio,
  nativeForegroundSyncGateRef,
  nativePlaybackPlayingRef,
  overruledSaveRef,
  pausePlayback,
  pendingSeekRef,
  playWhenTrackLoads,
  playbackActionVersionRef,
  playbackBook,
  playbackSessionVersion,
  playbackTouchedRef,
  position,
  progressMutationVersion,
  progressSaveAbortController,
  playerOnScreen = () => document.visibilityState === "visible",
  progressSaveDrainPromiseRef,
  queuedProgressSaves,
  restoredProgressBookId,
  resumeAutoplayBookIdRef,
  resumeAutoplayPendingRef,
  resumeReconciliationBookIdRef,
  setBooks,
  setCurrentTrackId,
  setDuration,
  setIsPlaying,
  setNativePlayerSheet,
  setNativePlayerView,
  setNativeTab,
  setPendingSeek,
  setPlaybackBookId,
  setPosition,
  showMediaClock,
  wantsAutoplayRef
}: {
  clipPreviewBookIdRef: RefObject<string | null>;
  acknowledgedSeekGenerationRef: RefObject<Map<string, number>>;
  acknowledgedServerPositionRef: RefObject<Map<string, number>>;
  activeTrackIndex: number;
  audioRef: RefObject<HTMLAudioElement | null>;
  books: Book[];
  currentTrack: Track | null;
  currentUser: AuthUser;
  foregroundAdoptInFlightRef: RefObject<boolean>;
  intentionalSeekGenerationRef: RefObject<Map<string, number>>;
  intentionalSeekTargetRef: RefObject<Map<string, number>>;
  native: boolean;
  nativeAudio: boolean;
  nativeForegroundSyncGateRef: RefObject<NativeForegroundSyncGate>;
  nativePlaybackPlayingRef: RefObject<boolean>;
  overruledSaveRef: RefObject<Map<string, Progress>>;
  pausePlayback: (audio: HTMLAudioElement | null | undefined) => void;
  pendingSeekRef: RefObject<PendingSeek | null>;
  playWhenTrackLoads: RefObject<boolean>;
  playbackActionVersionRef: RefObject<number>;
  playbackBook: Book | null;
  playbackSessionVersion: RefObject<number>;
  playbackTouchedRef: RefObject<boolean>;
  position: number;
  progressMutationVersion: RefObject<number>;
  progressSaveAbortController: RefObject<AbortController | null>;
  playerOnScreen?: () => boolean;
  progressSaveDrainPromiseRef: RefObject<Promise<void> | null>;
  queuedProgressSaves: RefObject<Map<string, QueuedProgressSave>>;
  restoredProgressBookId: RefObject<string | null>;
  resumeAutoplayBookIdRef: RefObject<string | null>;
  resumeAutoplayPendingRef: RefObject<boolean>;
  resumeReconciliationBookIdRef: RefObject<string | null>;
  setBooks: Dispatch<SetStateAction<Book[]>>;
  setCurrentTrackId: Dispatch<SetStateAction<string | null>>;
  setDuration: Dispatch<SetStateAction<number>>;
  setIsPlaying: Dispatch<SetStateAction<boolean>>;
  setNativePlayerSheet: Dispatch<SetStateAction<NativePlayerSheet>>;
  setNativePlayerView: Dispatch<SetStateAction<"details" | "chapters" | "now">>;
  setNativeTab: Dispatch<SetStateAction<NativeTab>>;
  setPendingSeek: (value: PendingSeek | null) => void;
  setPlaybackBookId: Dispatch<SetStateAction<string | null>>;
  setPosition: Dispatch<SetStateAction<number>>;
  showMediaClock: () => boolean;
  wantsAutoplayRef: RefObject<boolean>;
}) {
  const journaledSeekGenerationRef = useRef(new Map<string, number>());
  const foregroundProgressActionsRef = useRef({
    nativeAudio, persistProgress, adoptNewerServerProgress, refreshClock: showMediaClock
  });
  foregroundProgressActionsRef.current = {
    nativeAudio, persistProgress, adoptNewerServerProgress, refreshClock: showMediaClock
  };

  function persistProgress(options?: { keepalive?: boolean }): Promise<void> {
    if (playbackBook && clipPreviewBookIdRef.current === playbackBook.id) return Promise.resolve();
    if (
      !playbackBook ||
      restoredProgressBookId.current !== playbackBook.id ||
      !currentTrack ||
      !audioRef.current
    ) {
      return Promise.resolve();
    }
    const reconciling = resumeReconciliationBookIdRef.current === playbackBook.id;
    if (!playbackTouchedRef.current) {
      return Promise.resolve();
    }

    const pending = pendingSeekRef.current;
    if (pending && pending.trackId !== currentTrack.id) {
      return Promise.resolve();
    }
    const trackPosition = pending
      ? Math.max(0, pending.positionSeconds)
      : Number.isFinite(audioRef.current.currentTime)
        ? Math.max(0, audioRef.current.currentTime)
        : Math.max(0, position);
    const newIntentionalSeek = (intentionalSeekGenerationRef.current.get(playbackBook.id) ?? 0)
      > Math.max(acknowledgedSeekGenerationRef.current.get(playbackBook.id) ?? 0,
        journaledSeekGenerationRef.current.get(playbackBook.id) ?? 0);
    const localProgress = pendingProgress({
      bookId: playbackBook.id,
      trackId: currentTrack.id,
      positionSeconds: trackPosition,
      bookPositionSeconds: trackOffsetSeconds(playbackBook, activeTrackIndex) + trackPosition,
      durationSeconds: pending
        ? currentTrack.durationSeconds
        : Number.isFinite(audioRef.current.duration) ? audioRef.current.duration : currentTrack.durationSeconds,
      updatedAt: new Date().toISOString(),
      finishedOverride: playbackBook.progress?.finishedOverride ?? null
    }, readProgressCheckpoint(window.localStorage, getServerStorageKey(), currentUser.id, playbackBook.id),
    serverRevisionFromSummary(playbackBook.progress), newIntentionalSeek);
    if (!reconciling) progressMutationVersion.current += 1;
    if (newIntentionalSeek) {
      journaledSeekGenerationRef.current.set(playbackBook.id, intentionalSeekGenerationRef.current.get(playbackBook.id)!);
      overruledSaveRef.current.delete(playbackBook.id);
    }
    writeProgressCheckpoint(window.localStorage, getServerStorageKey(), currentUser.id, localProgress);
    void cacheProgress(currentUser.id, localProgress).catch(warnCacheFailure("cache listening progress"));
    if (playbackBook.deviceBookId) {
      const deviceBook = getDeviceBooks().find((book) => book.id === playbackBook.deviceBookId);
      const deviceTrack = deviceBook?.tracks[activeTrackIndex];
      if (deviceTrack) saveDeviceProgress(playbackBook.deviceBookId, { ...localProgress, bookId: playbackBook.deviceBookId, trackId: deviceTrack.id });
    }
    updateBookProgress(playbackBook.id, localProgress);
    if (playbackBook.source === "device" || reconciling) {
      return Promise.resolve();
    }

    const existingQueued = queuedProgressSaves.current.get(playbackBook.id);
    const seekIntent = readProgressSeekIntent(progressSeekStorage(), getServerStorageKey(), currentUser.id, playbackBook.id);
    const persistedIntent = progressSeekOptions(seekIntent, localProgress, acknowledgedServerPositionRef.current.get(playbackBook.id));
    const intentionalSeekGeneration = Math.max(
      existingQueued?.intentionalSeekGeneration ?? 0,
      intentionalSeekGenerationRef.current.get(playbackBook.id) ?? 0
    );
    const intentionalRegression =
      (existingQueued?.intentionalRegression ?? false) ||
      persistedIntent.intentionalRegression ||
      shouldFlagIntentionalRegression(
        intentionalSeekTargetRef.current.get(playbackBook.id),
        acknowledgedServerPositionRef.current.get(playbackBook.id)
      );
    queuedProgressSaves.current.set(playbackBook.id, {
      bookId: playbackBook.id,
      progress: localProgress,
      intentionalSeekGeneration,
      seekIntentId: persistedIntent.intentionalSeek ? seekIntent?.id : undefined,
      intentionalRegression,
      keepalive: (existingQueued?.keepalive ?? false) || options?.keepalive === true
    });
    return flushProgressSaveQueue();
  }

  function flushProgressSaveQueue(): Promise<void> {
    const existingDrain = progressSaveDrainPromiseRef.current;
    if (existingDrain) {
      return existingDrain;
    }
    const drain = (async () => {
      while (queuedProgressSaves.current.size > 0) {
        const entry = queuedProgressSaves.current.values().next().value as QueuedProgressSave;
        queuedProgressSaves.current.delete(entry.bookId);
        const abortController = new AbortController();
        progressSaveAbortController.current = abortController;
        const persistedSeekPending = !!entry.seekIntentId
          && readProgressSeekIntent(progressSeekStorage(), getServerStorageKey(), currentUser.id, entry.bookId)?.id === entry.seekIntentId;
        try {
          const saved = await saveProgress(
            entry.bookId,
            {
              trackId: entry.progress.trackId,
              positionSeconds: entry.progress.positionSeconds,
              bookPositionSeconds: entry.progress.bookPositionSeconds,
              durationSeconds: entry.progress.durationSeconds,
              updatedAt: entry.progress.updatedAt,
              baseUpdatedAt: entry.progress.baseUpdatedAt,
              recording: entry.progress.recording
            },
            {
              intentionalRegression:
                entry.intentionalRegression
                && (persistedSeekPending || entry.intentionalSeekGeneration
                  > (acknowledgedSeekGenerationRef.current.get(entry.bookId) ?? 0)),
              intentionalSeek:
                persistedSeekPending || entry.intentionalSeekGeneration
                > (acknowledgedSeekGenerationRef.current.get(entry.bookId) ?? 0),
              signal: abortController.signal,
              keepalive: entry.keepalive === true
            }
          );
          acknowledgeProgressSeekIntent(progressSeekStorage(), getServerStorageKey(), currentUser.id, entry.bookId, entry.seekIntentId);
          acknowledgedServerPositionRef.current.set(entry.bookId, saved.bookPositionSeconds);
          acknowledgedSeekGenerationRef.current.set(
            entry.bookId,
            Math.max(
              acknowledgedSeekGenerationRef.current.get(entry.bookId) ?? 0,
              entry.intentionalSeekGeneration
            )
          );
          const local = readProgressCheckpoint(
            window.localStorage,
            getServerStorageKey(),
            currentUser.id,
            entry.bookId
          );
          const reconciled = progressAfterSave(local, entry.progress, saved);
          if (reconciled !== saved) {
            const rebased = rebasePendingProgress(reconciled, entry.progress, saved);
            if (rebased !== reconciled) {
              const book = books.find((candidate) => candidate.id === entry.bookId);
              if (book) storeProgressCopies(book, rebased);
              const queued = queuedProgressSaves.current.get(entry.bookId);
              if (queued) queued.progress = rebasePendingProgress(queued.progress, entry.progress, saved);
            }
          }
          if (reconciled === saved) {
            const book = books.find((candidate) => candidate.id === entry.bookId);
            if (book) storeCanonicalServerProgress(book, saved, entry.progress);
            if (saveWasOverruled(entry.progress, saved)) {
              overruledSaveRef.current.set(entry.bookId, entry.progress);
              void foregroundProgressActionsRef.current.adoptNewerServerProgress();
            }
          }
        } catch {
        } finally {
          if (progressSaveAbortController.current === abortController) {
            progressSaveAbortController.current = null;
          }
        }
      }
    })().finally(() => {
      if (progressSaveDrainPromiseRef.current === drain) {
        progressSaveDrainPromiseRef.current = null;
        if (queuedProgressSaves.current.size > 0) {
          void flushProgressSaveQueue();
        }
      }
    });
    progressSaveDrainPromiseRef.current = drain;
    return drain;
  }

  function updateBookProgress(bookId: string, saved: Progress) {
    setBooks((existing) =>
      existing.map((book) => {
        if (book.id !== bookId) {
          return book;
        }
        return {
          ...book,
          progress: summarizeBookProgress(book, saved)
        };
      })
    );
  }

  function storeCanonicalServerProgress(book: Book, saved: Progress, attempted?: Progress | null, journal?: Progress | null) {
    const local = readProgressCheckpoint(window.localStorage, getServerStorageKey(), currentUser.id, book.id);
    if (attempted !== undefined) {
      const current = progressAfterSave(local, journal === undefined ? attempted : journal, saved);
      if (current !== saved) {
        const rebased = attempted ? rebasePendingProgress(current, attempted, saved) : current;
        if (rebased !== current) {
          storeProgressCopies(book, rebased);
          const queued = queuedProgressSaves.current.get(book.id);
          if (queued && attempted) queued.progress = rebasePendingProgress(queued.progress, attempted, saved);
        }
        return;
      }
    }
    acknowledgedServerPositionRef.current.set(book.id, saved.bookPositionSeconds);
    const acknowledgedCheckpoint = saved.accepted === true ? attempted ?? local : null;
    const recordedAt = acknowledgedCheckpoint?.localUpdatedAt
      ?? acknowledgedCheckpoint?.updatedAt ?? local?.localUpdatedAt;
    const canonical = syncedProgress(saved, recordedAt, acknowledgedCheckpoint);
    if (saved.accepted === false && local) {
      canonical.baseUpdatedAt = local.baseUpdatedAt;
      overruledSaveRef.current.set(book.id, local);
    }
    storeProgressCopies(book, canonical);
  }

  function storeProgressCopies(book: Book, saved: Progress) {
    writeProgressCheckpoint(
      window.localStorage,
      getServerStorageKey(),
      currentUser.id,
      saved
    );
    void cacheProgress(currentUser.id, saved).catch(warnCacheFailure("cache listening progress"));
    if (book.deviceBookId) {
      const deviceBook = getDeviceBooks().find((candidate) => candidate.id === book.deviceBookId);
      const serverTrackIndex = book.tracks.findIndex((track) => track.id === saved.trackId);
      const deviceTrack = serverTrackIndex >= 0 ? deviceBook?.tracks[serverTrackIndex] : null;
      if (deviceBook && deviceTrack) {
        saveDeviceProgress(deviceBook.id, {
          ...saved,
          bookId: deviceBook.id,
          trackId: deviceTrack.id
        });
      }
    }
    updateBookProgress(book.id, saved);
  }

  async function adoptNewerServerProgress() {
    const book = playbackBook;
    const audio = audioRef.current;
    if (
      !book ||
      book.source === "device" ||
      !currentTrack ||
      !audio ||
      restoredProgressBookId.current !== book.id ||
      resumeReconciliationBookIdRef.current === book.id ||
      foregroundAdoptInFlightRef.current ||
      !playerOnScreen() ||
      (nativeAudio && nativeForegroundSyncGateRef.current.shouldDeferServerAdoption())
    ) {
      return;
    }
    const isPaused = nativeAudio ? !nativePlaybackPlayingRef.current : audio.paused;
    if (!isPaused) {
      return;
    }
    if (queuedProgressSaves.current.size > 0 || progressSaveDrainPromiseRef.current) {
      const pendingGeneration = nativeForegroundSyncGateRef.current.generation;
      void flushProgressSaveQueue().then(() => {
        if (nativeForegroundSyncGateRef.current.generation === pendingGeneration) {
          void foregroundProgressActionsRef.current.adoptNewerServerProgress();
        }
      });
      return;
    }
    const foregroundGeneration = nativeForegroundSyncGateRef.current.generation;
    const actionVersion = playbackActionVersionRef.current;
    const mutationVersion = progressMutationVersion.current;
    const sessionVersion = playbackSessionVersion.current;
    foregroundAdoptInFlightRef.current = true;
    try {
      const server = await getProgress(book.id).catch(() => null);
      const cached = await getCachedProgress(currentUser.id, book.id).catch(() => null);
      if (
        !server ||
        !playerOnScreen() ||
        nativeForegroundSyncGateRef.current.generation !== foregroundGeneration ||
        (nativeAudio && nativeForegroundSyncGateRef.current.shouldDeferServerAdoption()) ||
        restoredProgressBookId.current !== book.id ||
        playbackActionVersionRef.current !== actionVersion ||
        progressMutationVersion.current !== mutationVersion ||
        playbackSessionVersion.current !== sessionVersion
      ) {
        return;
      }
      const checkpoint = readProgressCheckpoint(
        window.localStorage,
        getServerStorageKey(),
        currentUser.id,
        book.id
      );
      const overruled = overruledSaveRef.current.get(book.id);
      const adopted = overruled
        ? server
        : adoptableServerProgress(freshestProgress(checkpoint, cached), server);
      if (!adopted) return;
      const location = resolveProgressLocation(book.tracks, adopted);
      if (!location) return;
      storeCanonicalServerProgress(book, adopted);
      setCurrentTrackId(location.trackId);
      setPendingSeek(location);
      overruledSaveRef.current.delete(book.id);
      setPosition(location.positionSeconds);
      setDuration(
        book.tracks.find((track) => track.id === location.trackId)?.durationSeconds ?? 0
      );
    } finally {
      foregroundAdoptInFlightRef.current = false;
      if (nativeForegroundSyncGateRef.current.generation !== foregroundGeneration) {
        void foregroundProgressActionsRef.current.adoptNewerServerProgress();
      }
    }
  }

  function clearPlaybackSession() {
    playbackSessionVersion.current += 1;
    playbackTouchedRef.current = false;
    nativePlaybackPlayingRef.current = false;
    playWhenTrackLoads.current = false;
    wantsAutoplayRef.current = false;
    resumeAutoplayBookIdRef.current = null;
    resumeAutoplayPendingRef.current = false;
    resumeReconciliationBookIdRef.current = null;
    pausePlayback(audioRef.current);
    setPlaybackBookId(null);
    setCurrentTrackId(null);
    setPendingSeek(null);
    setPosition(0);
    setDuration(0);
    setIsPlaying(false);
    setNativePlayerSheet(null);
    setNativePlayerView("now");
    if (native) setNativeTab("shelf");
  }

  return {
    clearPlaybackSession,
    flushProgressSaveQueue,
    foregroundProgressActionsRef,
    persistProgress,
    storeCanonicalServerProgress,
    updateBookProgress
  };
}
