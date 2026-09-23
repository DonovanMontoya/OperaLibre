import { type Dispatch, type RefObject, type SetStateAction, useRef } from "react";
import type { AuthUser, Book, Progress, Track } from "./types";
import { trackOffsetSeconds } from "./formatting";
import {
  adoptableServerProgress,
  freshestProgress,
  progressAfterSave,
  readProgressCheckpoint,
  resolveProgressLocation,
  saveWasOverruled,
  shouldFlagIntentionalRegression,
  summarizeBookProgress,
  writeProgressCheckpoint
} from "./reliability";
import { getFreshProgress, getServerStorageKey, saveProgress } from "./api";
import { cacheProgress, getCachedProgress, warnCacheFailure } from "./offline";
import { getDeviceBooks, saveDeviceProgress } from "./localLibrary";
import type { PendingSeek, QueuedProgressSave } from "./playbackTypes";
import type { NativeForegroundSyncGate } from "./nativeAudioState";
import type { NativePlayerSheet } from "./PlayerSheets";
import type { NativeTab } from "./nativeTabs";


export function useProgressSync({
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
  const foregroundProgressActionsRef = useRef({
    nativeAudio, persistProgress, adoptNewerServerProgress, refreshClock: showMediaClock
  });
  foregroundProgressActionsRef.current = {
    nativeAudio, persistProgress, adoptNewerServerProgress, refreshClock: showMediaClock
  };

  function persistProgress(): Promise<void> {
    if (
      !playbackBook ||
      restoredProgressBookId.current !== playbackBook.id ||
      !currentTrack ||
      !audioRef.current
    ) {
      return Promise.resolve();
    }
    // A shelf Resume plays the optimistic local copy while the server's is
    // still being fetched. Until that reconciliation settles, nothing goes
    // to the server: the position being played may be about to be replaced
    // by a fresher copy, and a push would make it look like the newest. The
    // local checkpoint is still kept — the window can span several retries
    // when the server is slow, and listening during it must survive a kill.
    // It does not advance progressMutationVersion, so the reconciled copy
    // still applies when it lands.
    const reconciling = resumeReconciliationBookIdRef.current === playbackBook.id;
    // Nothing moved playback since this book was restored: there is nothing
    // new to save, and writing the restored position back with a fresh
    // timestamp would let a device whose restore silently failed outrank —
    // and then erase — real progress recorded elsewhere. Opening a book and
    // closing it again must write nothing.
    if (!playbackTouchedRef.current) {
      return Promise.resolve();
    }

    // While a seek is queued the media element does not reflect the real
    // position yet — a restore or track jump reads currentTime 0 until
    // metadata loads. Persist the seek target instead; persisting element
    // time here would overwrite the real position everywhere, including the
    // server's only copy.
    const pending = pendingSeekRef.current;
    if (pending && pending.trackId !== currentTrack.id) {
      return Promise.resolve();
    }
    const trackPosition = pending
      ? Math.max(0, pending.positionSeconds)
      : Number.isFinite(audioRef.current.currentTime)
        ? Math.max(0, audioRef.current.currentTime)
        : Math.max(0, position);
    const localProgress: Progress = {
      bookId: playbackBook.id,
      trackId: currentTrack.id,
      positionSeconds: trackPosition,
      bookPositionSeconds: trackOffsetSeconds(playbackBook, activeTrackIndex) + trackPosition,
      durationSeconds: pending
        ? currentTrack.durationSeconds
        : Number.isFinite(audioRef.current.duration) ? audioRef.current.duration : currentTrack.durationSeconds,
      updatedAt: new Date().toISOString(),
      finishedOverride: playbackBook.progress?.finishedOverride ?? null
    };
    if (!reconciling) progressMutationVersion.current += 1;
    overruledSaveRef.current.delete(playbackBook.id);
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
    const intentionalSeekGeneration = Math.max(
      existingQueued?.intentionalSeekGeneration ?? 0,
      intentionalSeekGenerationRef.current.get(playbackBook.id) ?? 0
    );
    // Lifting the server's reset guard is decided by where the seek went,
    // not by the position being saved now: a +30 s tap must not turn a stale
    // near-zero clock persisted after it into the authoritative copy.
    const intentionalRegression =
      (existingQueued?.intentionalRegression ?? false) ||
      shouldFlagIntentionalRegression(
        intentionalSeekTargetRef.current.get(playbackBook.id),
        acknowledgedServerPositionRef.current.get(playbackBook.id)
      );
    queuedProgressSaves.current.set(playbackBook.id, {
      bookId: playbackBook.id,
      progress: localProgress,
      isPaused: nativeAudio ? !nativePlaybackPlayingRef.current : audioRef.current.paused,
      intentionalSeekGeneration,
      intentionalRegression
    });
    return flushProgressSaveQueue();
  }

  function flushProgressSaveQueue(): Promise<void> {
    const existingDrain = progressSaveDrainPromiseRef.current;
    if (existingDrain) {
      return existingDrain;
    }
    const drain = (async () => {
      // A slow request must not cause a newer position to be discarded. Each
      // in-flight save is followed by the most recent checkpoint queued while
      // it was running.
      while (queuedProgressSaves.current.size > 0) {
        const entry = queuedProgressSaves.current.values().next().value as QueuedProgressSave;
        queuedProgressSaves.current.delete(entry.bookId);
        const abortController = new AbortController();
        progressSaveAbortController.current = abortController;
        try {
          const saved = await saveProgress(
            entry.bookId,
            {
              trackId: entry.progress.trackId,
              positionSeconds: entry.progress.positionSeconds,
              bookPositionSeconds: entry.progress.bookPositionSeconds,
              durationSeconds: entry.progress.durationSeconds,
              updatedAt: entry.progress.updatedAt
            },
            {
              isPaused: entry.isPaused,
              intentionalRegression:
                entry.intentionalRegression
                && entry.intentionalSeekGeneration
                  > (acknowledgedSeekGenerationRef.current.get(entry.bookId) ?? 0),
              intentionalSeek:
                entry.intentionalSeekGeneration
                > (acknowledgedSeekGenerationRef.current.get(entry.bookId) ?? 0),
              signal: abortController.signal
            }
          );
          // Whatever the server answered is now its position — the copy a
          // later rewind is measured against.
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
          if (reconciled === saved) {
            // Heal future-skewed and rejected local checkpoints with the
            // server's canonical response. Without this, the same stale copy
            // wins every restart and is retried indefinitely.
            const book = books.find((candidate) => candidate.id === entry.bookId);
            if (book) storeCanonicalServerProgress(book, saved);
            if (saveWasOverruled(entry.progress, saved)) {
              overruledSaveRef.current.set(entry.bookId, entry.progress);
              // Move an idle player off the refused position now, not at the
              // next resume. Adoption waits for the rest of this drain.
              void foregroundProgressActionsRef.current.adoptNewerServerProgress();
            }
          }
        } catch {
          // The synchronous checkpoint and IndexedDB copy already contain the
          // position. A later playback tick or reconnect will retry the server.
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

  function storeCanonicalServerProgress(book: Book, saved: Progress) {
    acknowledgedServerPositionRef.current.set(book.id, saved.bookPositionSeconds);
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

  /**
   * Returning to the foreground is the one moment another device's position
   * can be newer without any local signal — the restore effect runs once per
   * book and deliberately never re-fires. Adopt the server's copy only while
   * this session is provably idle: restore finished, playback paused, and no
   * local save queued or in flight. A moving or unsynced session is always
   * authoritative and is left completely alone.
   */
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
      document.visibilityState !== "visible" ||
      (nativeAudio && nativeForegroundSyncGateRef.current.shouldDeferServerAdoption())
    ) {
      return;
    }
    const isPaused = nativeAudio ? !nativePlaybackPlayingRef.current : audio.paused;
    if (!isPaused) {
      return;
    }
    if (queuedProgressSaves.current.size > 0 || progressSaveDrainPromiseRef.current) {
      // The save a pause makes on its way to the background is suspended with
      // the WebView and often lands only after resume. Giving up here lost the
      // handoff for the whole session, and the next Play resumed the stale
      // position. Ask again once the queue settles.
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
      const server = await getFreshProgress(book).catch(() => null);
      const cached = await getCachedProgress(currentUser.id, book.id).catch(() => null);
      if (
        !server ||
        document.visibilityState !== "visible" ||
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
      // A refused save can carry the fresher timestamp — resuming re-stamps an
      // unchanged position — so it is measured by distance alone: the server
      // already vetted its own copy when it refused ours.
      const overruled = overruledSaveRef.current.get(book.id);
      overruledSaveRef.current.delete(book.id);
      const adopted = overruled
        ? saveWasOverruled(overruled, server) ? server : null
        : adoptableServerProgress(freshestProgress(checkpoint, cached), server);
      if (!adopted) return;
      const location = resolveProgressLocation(book.tracks, adopted);
      if (!location) return;
      storeCanonicalServerProgress(book, adopted);
      setCurrentTrackId(location.trackId);
      setPendingSeek(location);
      setPosition(location.positionSeconds);
      setDuration(
        book.tracks.find((track) => track.id === location.trackId)?.durationSeconds ?? 0
      );
    } finally {
      foregroundAdoptInFlightRef.current = false;
      // A later resume may have tried while this obsolete request still held
      // the in-flight guard. Give that handoff a fresh read of the server.
      if (nativeForegroundSyncGateRef.current.generation !== foregroundGeneration) {
        void foregroundProgressActionsRef.current.adoptNewerServerProgress();
      }
    }
  }

  function clearPlaybackSession() {
    // Completion owns the durable final position. Prevent pause/teardown
    // events from following it with a stale media-element clock.
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
