import { type Dispatch, type RefObject, type SetStateAction, useEffect } from "react";
import type { AuthUser, Book, Progress } from "./types";
import {
  freshestProgress,
  isSuspectProgressReset,
  progressAfterSave,
  pendingProgress,
  progressNeedsSync,
  progressFromBookSummary,
  progressTimestamp,
  readProgressCheckpoint,
  rebasePendingProgress,
  resolveProgressLocation,
  serverRevisionFromSummary
} from "./reliability";
import { getNativeAudioRecovery } from "./nativeAudio";
import { nativeAudioRecoveryScope } from "./appStorage";
import { getCachedProgress } from "./offline";
import { getDeviceBooks, getDeviceProgress } from "./localLibrary";
import { getProgress, getServerStorageKey, saveProgress } from "./api";
import type { PendingSeek } from "./playbackTypes";
import { acknowledgeProgressSeekIntent, progressSeekStorage, progressSeekOptions, readProgressSeekIntent } from "./progressSeekIntent";

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
  libraryProgressReplaysRef,
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
  libraryProgressReplaysRef: RefObject<Map<string, Promise<void>>>;
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
  storeCanonicalServerProgress: (book: Book, saved: Progress, attempted?: Progress | null) => void;
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
    // Starting a paused book must still accept the server position while the
    // initial restore is pending. Deliberate seeks release this gate.
    resumeReconciliationBookIdRef.current = playbackBook.id;
    const applyProgress = (progress: Progress | null, canonical = false) => {
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
      if (progress && canonical && location && playbackBook.source !== "device") {
        // The canonical target now owns the pending seek, so new playback
        // may safely use its revision, including after a rejected save.
        storeCanonicalServerProgress(playbackBook, { ...progress, accepted: undefined });
        // The rejected playhead has been replaced. Keeping its marker would
        // let a later foreground return discard new offline listening.
        overruledSaveRef.current.delete(playbackBook.id);
      }
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
      const libraryReplay = libraryProgressReplaysRef.current.get(playbackBook.id);
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
      let nativeProgress: Progress | null = recoveredNative && recoveryTrack
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
      let checkpoint = readProgressCheckpoint(
        window.localStorage,
        getServerStorageKey(),
        currentUser.id,
        playbackBook.id
      );
      const deviceBook = deviceBookId ? getDeviceBooks().find((book) => book.id === deviceBookId) : null;
      const deviceTrackIndex = deviceBook?.tracks.findIndex((track) => track.id === device?.trackId) ?? -1;
      const mappedServerTrack = deviceTrackIndex >= 0 ? playbackBook.tracks[deviceTrackIndex] : null;
      const mappedDevice = playbackBook.source === "device" ? device : device && mappedServerTrack
        ? { ...device, bookId: playbackBook.id, trackId: mappedServerTrack.id }
        : null;
      const localCopies = [mappedDevice, checkpoint, cached];
      const previousLocal = freshestProgress(...localCopies);
      if (nativeProgress) {
        // Compare with the surviving local copy, not superseded legacy mirrors
        // that may still carry server time. Unmarked recovery retains its old
        // timestamp ordering; acknowledgements contribute only recording time.
        const recordedAt = previousLocal?.localUpdatedAt
          ?? (previousLocal?.syncStatus !== "synced" ? previousLocal?.updatedAt : undefined);
        nativeProgress = recordedAt && progressTimestamp(nativeProgress.updatedAt) <= progressTimestamp(recordedAt)
          ? null
          : pendingProgress(nativeProgress, previousLocal, serverRevisionFromSummary(playbackBook.progress));
      }
      if (playbackBook.source === "device") {
        const local = freshestProgress(...localCopies, nativeProgress);
        if (local) updateBookProgress(playbackBook.id, local);
        applyProgress(local);
        return;
      }
      // Progress saved on the device or while disconnected can be newer than
      // the server. Resume from the freshest copy and converge the server.
      let freshestLocal = freshestProgress(...localCopies, nativeProgress);
      // The summary embedded in the library listing is also the server's
      // copy. It backstops a failed or empty progress fetch — without it, a
      // fresh install that hits one failed request opens the book at zero and
      // the next save wipes the real position on the server too.
      const listed = progressFromBookSummary(playbackBook.id, playbackBook.progress);
      const seekIntent = readProgressSeekIntent(progressSeekStorage(), getServerStorageKey(), currentUser.id, playbackBook.id);
      const optimisticSeekOptions = freshestLocal ? progressSeekOptions(seekIntent, freshestLocal, listed?.bookPositionSeconds) : null;
      // Resume from the best copy already on the device before asking the
      // server. Waiting on that request left the player at 0:00 for the whole
      // network timeout whenever the server was unreachable. A near-zero
      // local copy that outranks substantial listed progress by timestamp
      // alone is distrusted the same way the reconciliation below distrusts
      // it — showing 0:00 here is what tempts a listener to "fix" it.
      const optimistic = !optimisticSeekOptions?.intentionalRegression && isSuspectProgressReset(freshestLocal, listed)
        ? listed
        : freshestProgress(freshestLocal, listed);
      applyProgress(optimistic, optimistic === listed || optimistic?.syncStatus === "synced");
      // Show native recovery immediately, but let a library save already in
      // flight finish before uploading it. Only an accepted save from this
      // local baseline can advance the recovery checkpoint's revision.
      if (libraryReplay) {
        await libraryReplay.catch(() => undefined);
        if (cancelled || playbackActionVersionRef.current !== restoreActionVersion) return;
        const acknowledgedReplay = readProgressCheckpoint(
          window.localStorage, getServerStorageKey(), currentUser.id, playbackBook.id
        );
        if (freshestLocal && previousLocal && acknowledgedReplay) {
          // Unmarked journals did not carry a base; native recovery used the
          // listed server revision instead, never the journal's device time.
          const replayBaseline = previousLocal.syncStatus ? previousLocal : {
            ...previousLocal, baseUpdatedAt: serverRevisionFromSummary(playbackBook.progress)
          };
          const rebased = rebasePendingProgress(freshestLocal, replayBaseline, acknowledgedReplay);
          if (rebased !== freshestLocal) {
            freshestLocal = rebased;
            checkpoint = acknowledgedReplay;
          }
        }
      }
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
      const seekOptions = freshestLocal ? progressSeekOptions(seekIntent, freshestLocal, lastKnownServer?.bookPositionSeconds) : null;
      const suspectLocalReset = !seekOptions?.intentionalRegression && isSuspectProgressReset(freshestLocal, lastKnownServer);
      const localIsNewer =
        !!freshestLocal &&
        !suspectLocalReset &&
        progressNeedsSync(freshestLocal, lastKnownServer);
      let target = localIsNewer ? freshestLocal : lastKnownServer ?? freshestLocal;
      let targetIsCanonical = (!localIsNewer && !!lastKnownServer) || target?.syncStatus === "synced";
      let serverCorrectedLocal = false;
      if (!localIsNewer && serverReachable && lastKnownServer) {
        storeCanonicalServerProgress(playbackBook, lastKnownServer, freshestLocal);
        acknowledgeProgressSeekIntent(progressSeekStorage(), getServerStorageKey(), currentUser.id, playbackBook.id, seekIntent?.id);
      }
      if (localIsNewer && freshestLocal) {
        updateBookProgress(playbackBook.id, freshestLocal);
        if (serverReachable) {
          const saved = await saveProgress(
            playbackBook.id,
            freshestLocal,
            { isPaused: true, ...seekOptions }
          ).catch(() => null);
          if (cancelled || playbackActionVersionRef.current !== restoreActionVersion) return;
          if (saved) {
            if (seekOptions?.intentionalSeek) {
              acknowledgeProgressSeekIntent(progressSeekStorage(), getServerStorageKey(), currentUser.id, playbackBook.id, seekIntent?.id);
            }
            const currentCheckpoint = readProgressCheckpoint(
              window.localStorage,
              getServerStorageKey(),
              currentUser.id,
              playbackBook.id
            );
            // Native/cache recovery can be newer than the synchronous
            // journal without having written it. An unchanged original
            // journal is not a competing edit made during this request.
            const originalJournalUnchanged = progressAfterSave(currentCheckpoint, checkpoint, saved) === saved;
            // The library's reconnect replay can answer the same checkpoint
            // first and heal the journal to this very response. A synced
            // copy at the revision just returned is agreement, not a
            // competing edit: edits made during a request are always pending.
            const journalHealed = !originalJournalUnchanged
              && currentCheckpoint?.syncStatus === "synced"
              && currentCheckpoint.updatedAt === saved.updatedAt
              && currentCheckpoint.trackId === saved.trackId
              && Math.abs(currentCheckpoint.bookPositionSeconds - saved.bookPositionSeconds) <= 0.01;
            if (originalJournalUnchanged || progressAfterSave(currentCheckpoint, freshestLocal, saved) === saved) {
              serverCorrectedLocal = saved.accepted === false || saved.trackId !== freshestLocal.trackId
                || Math.abs(saved.bookPositionSeconds - freshestLocal.bookPositionSeconds) > 0.01;
              storeCanonicalServerProgress(playbackBook, saved, originalJournalUnchanged ? checkpoint : freshestLocal);
              target = saved;
              targetIsCanonical = true;
            } else if (journalHealed) {
              // The journal already holds this response, so nothing is
              // stored: recording a refusal again would mark an overruled
              // save that never happened. Applying the target below stores
              // the canonical copy without that marker.
              serverCorrectedLocal = saved.accepted === false || saved.trackId !== freshestLocal.trackId
                || Math.abs(saved.bookPositionSeconds - freshestLocal.bookPositionSeconds) > 0.01;
              target = saved;
              targetIsCanonical = true;
            } else {
              storeCanonicalServerProgress(playbackBook, saved, freshestLocal);
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
        (target !== optimistic && optimistic?.syncStatus === "pending" && !localIsNewer) ||
        (target && progressTimestamp(target.updatedAt) > progressTimestamp(optimistic.updatedAt))
      ) {
        applyProgress(target, targetIsCanonical);
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
