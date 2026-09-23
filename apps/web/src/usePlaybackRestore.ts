import { type Dispatch, type RefObject, type SetStateAction, useEffect } from "react";
import type { AuthUser, Book, Progress } from "./types";
import {
  freshestProgress,
  isSuspectProgressReset,
  progressAfterSave,
  progressFromBookSummary,
  progressTimestamp,
  readProgressCheckpoint,
  resolveProgressLocation
} from "./reliability";
import { getNativeAudioRecovery } from "./nativeAudio";
import { nativeAudioRecoveryScope } from "./appStorage";
import { getCachedProgress } from "./offline";
import { getDeviceBooks, getDeviceProgress } from "./localLibrary";
import { getProgress, getServerStorageKey, saveProgress } from "./api";
import type { PendingSeek } from "./playbackTypes";

// The restore effect's own /progress reads; local copies cover the wait.
const RESTORE_PROGRESS_TIMEOUT_MS = 8_000;

/**
 * Restores the position when a book becomes the playing book: it resumes at
 * once from the freshest copy on the device, then reconciles with the server
 * (retrying a failed fetch) and sends a newer local copy back to it.
 */
export function usePlaybackRestore({
  acknowledgedServerPositionRef,
  currentUser,
  explicitSessionStartBookIdRef,
  nativeAudio,
  overruledSaveRef,
  playCancelGenerationRef,
  playWhenTrackLoads,
  playbackActionVersionRef,
  playbackBook,
  playbackBookKey,
  playbackTouchedRef,
  progressMutationVersion,
  restoredProgressBookId,
  resumeAutoplayBookIdRef,
  resumeAutoplayPendingRef,
  resumeReconciliationBookIdRef,
  scheduleStartupReveal,
  setCurrentTrackId,
  setDuration,
  setPendingSeek,
  setPosition,
  setRestoredPlaybackBookId,
  startupProgressAppliedRef,
  startupViewReadyRef,
  storeCanonicalServerProgress,
  updateBookProgress
}: {
  acknowledgedServerPositionRef: RefObject<Map<string, number>>;
  currentUser: AuthUser;
  explicitSessionStartBookIdRef: RefObject<string | null>;
  nativeAudio: boolean;
  overruledSaveRef: RefObject<Map<string, Progress>>;
  playCancelGenerationRef: RefObject<number>;
  playWhenTrackLoads: RefObject<boolean>;
  playbackActionVersionRef: RefObject<number>;
  playbackBook: Book | null;
  playbackBookKey: string | null;
  playbackTouchedRef: RefObject<boolean>;
  progressMutationVersion: RefObject<number>;
  restoredProgressBookId: RefObject<string | null>;
  resumeAutoplayBookIdRef: RefObject<string | null>;
  resumeAutoplayPendingRef: RefObject<boolean>;
  resumeReconciliationBookIdRef: RefObject<string | null>;
  scheduleStartupReveal: () => void;
  setCurrentTrackId: Dispatch<SetStateAction<string | null>>;
  setDuration: Dispatch<SetStateAction<number>>;
  setPendingSeek: (value: PendingSeek | null) => void;
  setPosition: Dispatch<SetStateAction<number>>;
  setRestoredPlaybackBookId: Dispatch<SetStateAction<string | null>>;
  startupProgressAppliedRef: RefObject<boolean>;
  startupViewReadyRef: RefObject<boolean>;
  storeCanonicalServerProgress: (book: Book, saved: Progress) => void;
  updateBookProgress: (bookId: string, saved: Progress) => void;
}) {
  useEffect(() => {
    if (!playbackBook) {
      return;
    }

    let cancelled = false;
    restoredProgressBookId.current = null;
    setRestoredPlaybackBookId(null);
    if (!startupViewReadyRef.current) startupProgressAppliedRef.current = false;
    if (explicitSessionStartBookIdRef.current === playbackBook.id) {
      // A shelf play/restart chose this pending position deliberately. It is
      // the beginning of a new session, not a request to restore the previous
      // session (especially important for "Read it again" on a finished book).
      explicitSessionStartBookIdRef.current = null;
      restoredProgressBookId.current = playbackBook.id;
      setRestoredPlaybackBookId(playbackBook.id);
      return () => {
        cancelled = true;
      };
    }
    playbackTouchedRef.current = false;
    const armResumeAutoplay = resumeAutoplayBookIdRef.current === playbackBook.id;
    resumeAutoplayBookIdRef.current = null;
    const restoreVersion = progressMutationVersion.current;
    const restoreActionVersion = playbackActionVersionRef.current;
    const restoreCancelGeneration = playCancelGenerationRef.current;
    // Restoring places the player afresh; an earlier refused position is moot.
    overruledSaveRef.current.delete(playbackBook.id);
    if (armResumeAutoplay) resumeReconciliationBookIdRef.current = playbackBook.id;
    const applyProgress = (progress: Progress | null) => {
      if (
        cancelled ||
        progressMutationVersion.current !== restoreVersion ||
        playbackActionVersionRef.current !== restoreActionVersion
      ) {
        return;
      }
      const location = resolveProgressLocation(playbackBook.tracks, progress);
      setCurrentTrackId(location?.trackId ?? null);
      setPendingSeek(location);
      // Show the restored time immediately; the media element seeks to it
      // once metadata loads.
      setPosition(location?.positionSeconds ?? 0);
      const restoredTrack = location
        ? playbackBook.tracks.find((track) => track.id === location.trackId)
        : playbackBook.tracks[0];
      setDuration(restoredTrack?.durationSeconds ?? 0);
      restoredProgressBookId.current = playbackBook.id;
      setRestoredPlaybackBookId(playbackBook.id);
      startupProgressAppliedRef.current = true;
      // The restored track and position are now known, so a queued shelf
      // Resume can safely play: both places that consume this flag apply the
      // pending seek before starting.
      if (armResumeAutoplay && playCancelGenerationRef.current === restoreCancelGeneration) {
        playWhenTrackLoads.current = true;
        resumeAutoplayPendingRef.current = true;
      }
      // These updates are batched. The short quiet window also absorbs a
      // fresher server reply or native metadata before the overlay leaves.
      scheduleStartupReveal();
    };

    void (async () => {
      // Independent local stores can answer concurrently; preserve the same
      // freshest-copy reconciliation after both have completed.
      const [recoveredNative, cached] = await Promise.all([
        nativeAudio
          ? getNativeAudioRecovery(nativeAudioRecoveryScope(currentUser.id, playbackBook.id)).catch(() => null)
          : Promise.resolve(null),
        getCachedProgress(currentUser.id, playbackBook.id).catch(() => null)
      ]);
      const recoveryTrack = recoveredNative
        ? playbackBook.tracks.find((track) => track.id === recoveredNative.trackId)
        : null;
      const nativeProgress: Progress | null = recoveredNative && recoveryTrack
        ? {
            bookId: playbackBook.id,
            trackId: recoveryTrack.id,
            positionSeconds: recoveredNative.positionSeconds,
            bookPositionSeconds: recoveredNative.bookPositionSeconds,
            durationSeconds: recoveredNative.durationSeconds ?? recoveryTrack.durationSeconds,
            updatedAt: new Date(recoveredNative.updatedAt).toISOString()
          }
        : null;
      const deviceBookId = playbackBook.deviceBookId;
      const device = deviceBookId ? getDeviceProgress(deviceBookId) : null;
      const checkpoint = readProgressCheckpoint(
        window.localStorage,
        getServerStorageKey(),
        currentUser.id,
        playbackBook.id
      );
      if (playbackBook.source === "device") {
        const local = freshestProgress(device, checkpoint, cached, nativeProgress);
        if (local) updateBookProgress(playbackBook.id, local);
        applyProgress(local);
        return;
      }
      const deviceBook = deviceBookId ? getDeviceBooks().find((book) => book.id === deviceBookId) : null;
      const deviceTrackIndex = deviceBook?.tracks.findIndex((track) => track.id === device?.trackId) ?? -1;
      const mappedServerTrack = deviceTrackIndex >= 0 ? playbackBook.tracks[deviceTrackIndex] : null;
      const mappedDevice = device && mappedServerTrack
        ? { ...device, bookId: playbackBook.id, trackId: mappedServerTrack.id }
        : null;
      // Progress saved on the device or while disconnected can be newer than
      // the server. Resume from the freshest copy and converge the server.
      const freshestLocal = freshestProgress(mappedDevice, checkpoint, cached, nativeProgress);
      // The summary embedded in the library listing is also the server's
      // copy. It backstops a failed or empty progress fetch — without it, a
      // fresh install that hits one failed request opens the book at zero and
      // the next save wipes the real position on the server too.
      const listed = progressFromBookSummary(playbackBook.id, playbackBook.progress);
      // Resume from the best copy already on the device before asking the
      // server. Waiting on that request left the player at 0:00 for the whole
      // network timeout whenever the server was unreachable. A near-zero
      // local copy that outranks substantial listed progress by timestamp
      // alone is distrusted the same way the reconciliation below distrusts
      // it — showing 0:00 here is what tempts a listener to "fix" it.
      const optimistic = isSuspectProgressReset(freshestLocal, listed)
        ? listed
        : freshestProgress(freshestLocal, listed);
      applyProgress(optimistic);
      let server: Progress | null = null;
      let serverReachable = true;
      // One failed fetch must not strand this device on a stale or empty
      // copy — that is how a second device ends up at 0:00 and later pushes
      // it over real progress. Retry briefly before reconciling.
      // Each attempt is capped well below the client's 30 s default: local
      // copies cover the wait, and no server checkpoint is queued until the
      // window closes, so a long one is listening that goes unsynced.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          server = await getProgress(playbackBook.id, RESTORE_PROGRESS_TIMEOUT_MS);
          serverReachable = true;
          break;
        } catch {
          serverReachable = false;
        }
        if (cancelled || attempt === 2) {
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 4_000 * (attempt + 1)));
      }
      if (cancelled) {
        return;
      }
      if (playbackActionVersionRef.current !== restoreActionVersion) {
        // The listener already moved playback in this session; their live
        // position and its queued saves outrank whatever this late fetch
        // returned, and re-applying it would yank playback.
        return;
      }
      const lastKnownServer = server ?? listed;
      if (lastKnownServer) {
        acknowledgedServerPositionRef.current.set(
          playbackBook.id,
          lastKnownServer.bookPositionSeconds
        );
      }
      const suspectLocalReset = isSuspectProgressReset(freshestLocal, lastKnownServer);
      const localIsNewer =
        !!freshestLocal &&
        !suspectLocalReset &&
        (!lastKnownServer || progressTimestamp(freshestLocal.updatedAt) > progressTimestamp(lastKnownServer.updatedAt));
      let target = localIsNewer ? freshestLocal : lastKnownServer ?? freshestLocal;
      let serverCorrectedLocal = false;
      if (localIsNewer) {
        updateBookProgress(playbackBook.id, freshestLocal);
        if (serverReachable) {
          const saved = await saveProgress(
            playbackBook.id,
            freshestLocal,
            { isPaused: true }
          ).catch(() => null);
          if (cancelled || playbackActionVersionRef.current !== restoreActionVersion) return;
          if (saved) {
            const currentCheckpoint = readProgressCheckpoint(
              window.localStorage,
              getServerStorageKey(),
              currentUser.id,
              playbackBook.id
            );
            if (progressAfterSave(currentCheckpoint, freshestLocal, saved) === saved) {
              serverCorrectedLocal = saved.trackId !== freshestLocal.trackId
                || Math.abs(saved.bookPositionSeconds - freshestLocal.bookPositionSeconds) > 0.01;
              storeCanonicalServerProgress(playbackBook, saved);
              target = saved;
            }
          }
        }
      }
      // Re-seek only when the reconciled copy is genuinely fresher than what
      // was already applied (or the applied copy was a distrusted reset);
      // re-applying an equal copy would yank playback.
      if (
        !optimistic ||
        suspectLocalReset ||
        serverCorrectedLocal ||
        (target && progressTimestamp(target.updatedAt) > progressTimestamp(optimistic.updatedAt))
      ) {
        applyProgress(target);
      }
    })().finally(() => {
      // Let React commit a final reconciled seek before timeupdate is allowed
      // to persist again; otherwise the optimistic media clock can win the
      // narrow gap between setPendingSeek and its render.
      window.setTimeout(() => {
        if (resumeReconciliationBookIdRef.current === playbackBook.id) {
          resumeReconciliationBookIdRef.current = null;
        }
      }, 0);
    });

    return () => {
      cancelled = true;
      if (resumeReconciliationBookIdRef.current === playbackBook.id) {
        resumeReconciliationBookIdRef.current = null;
      }
    };
    // Keyed on the book id: this must run only when playback moves to a
    // different book. Re-running on object identity meant every successful
    // progress save re-applied the server's copy, yanking playback back to
    // the previous track/position around track boundaries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser.id, playbackBookKey]);

  return {
    
  };
}
