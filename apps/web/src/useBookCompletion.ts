import type { AuthUser, Book, Progress } from "./types";
import { getDeviceBooks, setDeviceBookCompletion } from "./localLibrary";
import { writeProgressCheckpoint } from "./reliability";
import { getServerStorageKey, setBookCompletion } from "./api";
import { cacheLibrary, cacheProgress, warnCacheFailure } from "./offline";
import { Capacitor } from "@capacitor/core";
import { haptic } from "./native";
import type { DeviceNotice } from "./ConfirmDialogs";
import type { QueuedProgressSave } from "./playbackTypes";
import type { Dispatch, RefObject, SetStateAction } from "react";

export function useBookCompletion({
  audioRef,
  clearPlaybackSession,
  completionPendingBookId,
  currentUser,
  nativePlaybackPlayingRef,
  pausePlayback,
  playbackBookId,
  playbackBookIdRef,
  playbackReportRef,
  playbackTouchedRef,
  progressMutationVersion,
  progressSaveAbortController,
  progressSaveDrainPromiseRef,
  queuedProgressSaves,
  setBooks,
  setCompletionError,
  setCompletionPendingBookId,
  setIsPlaying,
  setUnplayedConfirmationBookId
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  clearPlaybackSession: () => void;
  completionPendingBookId: string | null;
  currentUser: AuthUser;
  nativePlaybackPlayingRef: RefObject<boolean>;
  pausePlayback: (audio: HTMLAudioElement | null | undefined) => void;
  playbackBookId: string | null;
  playbackBookIdRef: RefObject<string | null>;
  playbackReportRef: RefObject<{ stop: () => Promise<unknown>; } | null>;
  playbackTouchedRef: RefObject<boolean>;
  progressMutationVersion: RefObject<number>;
  progressSaveAbortController: RefObject<AbortController | null>;
  progressSaveDrainPromiseRef: RefObject<Promise<void> | null>;
  queuedProgressSaves: RefObject<Map<string, QueuedProgressSave>>;
  setBooks: Dispatch<SetStateAction<Book[]>>;
  setCompletionError: Dispatch<SetStateAction<DeviceNotice | null>>;
  setCompletionPendingBookId: Dispatch<SetStateAction<string | null>>;
  setIsPlaying: Dispatch<SetStateAction<boolean>>;
  setUnplayedConfirmationBookId: Dispatch<SetStateAction<string | null>>;
}) {
  async function changeBookCompletion(
    book: Book,
    finished: boolean,
    finalProgress?: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">,
    resetToUnplayed = false
  ) {
    if (completionPendingBookId === book.id) return false;
    setCompletionPendingBookId(book.id);
    setCompletionError(null);
    try {
      const closingActiveBook = playbackBookId === book.id && (finished || resetToUnplayed);
      const reporting = closingActiveBook ? playbackReportRef.current : null;
      if (closingActiveBook || resetToUnplayed) {
        // Freeze playback before any asynchronous reports. Otherwise a slow stop
        // could let a new progress write land after the deliberate completion/reset.
        if (closingActiveBook) {
          playbackTouchedRef.current = false;
          nativePlaybackPlayingRef.current = false;
          pausePlayback(audioRef.current);
          setIsPlaying(false);
        }
        queuedProgressSaves.current.delete(book.id);
        progressSaveAbortController.current?.abort();
        await progressSaveDrainPromiseRef.current;
        queuedProgressSaves.current.delete(book.id);
        // Drain the stop before changing completion. Teardown then has nothing
        // left to report and cannot restore an old media clock after a reset.
        await reporting?.stop();
      }
      const completedProgress: Progress | null = finalProgress
        ? {
            bookId: book.id,
            ...finalProgress,
            updatedAt: new Date().toISOString(),
            finishedOverride: finished
          }
        : null;
      let summary: NonNullable<Book["progress"]>;
      if (book.source === "device") {
        const result = setDeviceBookCompletion(book, finished, finalProgress);
        summary = result.summary;
        writeProgressCheckpoint(
          window.localStorage,
          getServerStorageKey(),
          currentUser.id,
          result.progress
        );
        void cacheProgress(currentUser.id, result.progress).catch(warnCacheFailure("cache listening progress"));
      } else {
        summary = await setBookCompletion(book, finished, finalProgress);
        if (book.deviceBookId) {
          const deviceBook = getDeviceBooks().find(
            (candidate) => candidate.id === book.deviceBookId
          );
          if (deviceBook) {
            const trackIndex = finalProgress
              ? book.tracks.findIndex((track) => track.id === finalProgress.trackId)
              : -1;
            const deviceTrack = trackIndex >= 0 ? deviceBook.tracks[trackIndex] : null;
            setDeviceBookCompletion(
              deviceBook,
              finished,
              finalProgress && deviceTrack
                ? { ...finalProgress, trackId: deviceTrack.id }
                : undefined
            );
          }
        }
      }
      if (completedProgress) {
        progressMutationVersion.current += 1;
        writeProgressCheckpoint(
          window.localStorage,
          getServerStorageKey(),
          currentUser.id,
          completedProgress
        );
        void cacheProgress(currentUser.id, completedProgress).catch(warnCacheFailure("cache listening progress"));
      }

      setBooks((existing) => {
        const next = existing.map((candidate) =>
          candidate.id === book.id ? { ...candidate, progress: summary } : candidate
        );
        if (Capacitor.isNativePlatform()) {
          void cacheLibrary(
            currentUser.id,
            next.filter((candidate) => candidate.source !== "device")
          ).catch(warnCacheFailure("cache the library"));
        }
        return next;
      });
      if (playbackBookIdRef.current === book.id && (finished || resetToUnplayed)) {
        clearPlaybackSession();
      }
      return true;
    } catch (completionFailure) {
      setCompletionError({
        bookId: book.id,
        message: completionFailure instanceof Error
          ? completionFailure.message
          : resetToUnplayed
            ? `Could not mark ${book.title} unplayed.`
            : `Could not mark ${book.title} ${finished ? "finished" : "unfinished"}.`
      });
      return false;
    } finally {
      setCompletionPendingBookId(null);
    }
  }

  function markBookUnplayed(book: Book) {
    const firstTrack = book.tracks[0];
    if (!firstTrack || completionPendingBookId === book.id) return;
    haptic("light");
    setCompletionError(null);
    setUnplayedConfirmationBookId(book.id);
  }

  async function confirmBookUnplayed(book: Book) {
    const firstTrack = book.tracks[0];
    if (!firstTrack || completionPendingBookId === book.id) return;
    haptic("light");
    const changed = await changeBookCompletion(
      book,
      false,
      {
        trackId: firstTrack.id,
        positionSeconds: 0,
        bookPositionSeconds: 0,
        durationSeconds: firstTrack.durationSeconds
      },
      true
    );
    if (changed) setUnplayedConfirmationBookId(null);
  }

  return {
    changeBookCompletion,
    confirmBookUnplayed,
    markBookUnplayed
  };
}
