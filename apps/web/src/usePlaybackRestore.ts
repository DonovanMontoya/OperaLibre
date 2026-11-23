import { type Dispatch, type RefObject, type SetStateAction, useEffect } from "react";
import type { AuthUser, Book, Progress } from "./types";
import {
  freshestProgress,
  identifyProgressRecording,
  journalProgressAttempt,
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
import { forgetInterruptedClipPreview, interruptedClipPreviewStart } from "./clips";
import { nativeAudioRecoveryScope } from "./appStorage";
import { getCachedProgress } from "./offline";
import { getDeviceBooks, getDeviceProgress } from "./localLibrary";
import { getProgress, getServerStorageKey, saveProgress } from "./api";
import type { LibraryProgressReplay, PendingSeek } from "./playbackTypes";
import { acknowledgeProgressSeekIntent, progressSeekStorage, progressSeekOptions, readProgressSeekIntent } from "./progressSeekIntent";

const RESTORE_PROGRESS_TIMEOUT_MS = 8_000;

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
  libraryProgressReplaysRef: RefObject<Map<string, Promise<LibraryProgressReplay>>>;
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
  storeCanonicalServerProgress: (book: Book, saved: Progress, attempted?: Progress | null, journal?: Progress | null) => void;
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
        storeCanonicalServerProgress(playbackBook, { ...progress, accepted: undefined });
        overruledSaveRef.current.delete(playbackBook.id);
      }
      setPosition(location?.positionSeconds ?? 0);
      const restoredTrack = location
        ? playbackBook.tracks.find((track) => track.id === location.trackId)
        : playbackBook.tracks[0];
      setDuration(restoredTrack?.durationSeconds ?? 0);
      restoredProgressBookId.current = playbackBook.id;
      setRestoredPlaybackBookId(playbackBook.id);
      startupProgressAppliedRef.current = true;
      if (armResumeAutoplay && playCancelGenerationRef.current === restoreCancelGeneration) {
        playWhenTrackLoads.current = true;
        resumeAutoplayPendingRef.current = true;
      }
      scheduleStartupReveal();
    };

    void (async () => {
      const libraryReplay = libraryProgressReplaysRef.current.get(playbackBook.id);
      const [recoveredNative, cached] = await Promise.all([
        nativeAudio
          ? getNativeAudioRecovery(nativeAudioRecoveryScope(currentUser.id, playbackBook.id)).catch(() => null)
          : Promise.resolve(null),
        getCachedProgress(currentUser.id, playbackBook.id).catch(() => null)
      ]);
      const previewStartedAt = interruptedClipPreviewStart(
        window.localStorage, getServerStorageKey(), currentUser.id, playbackBook.id
      );
      const recoveryTrack = recoveredNative && recoveredNative.updatedAt < (previewStartedAt ?? Infinity)
        ?playbackBook.tracks.find((track) => track.id === recoveredNative.trackId)
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
        const unchangedAcknowledgedPosition = previousLocal?.syncStatus === "synced"
          && nativeProgress.trackId === previousLocal.trackId
          && Math.abs(nativeProgress.positionSeconds - previousLocal.positionSeconds) <= 0.01
          && Math.abs(nativeProgress.bookPositionSeconds - previousLocal.bookPositionSeconds) <= 0.01;
        const recordedAt = previousLocal?.localUpdatedAt
          ?? (previousLocal?.syncStatus !== "synced" ? previousLocal?.updatedAt : undefined);
        nativeProgress = unchangedAcknowledgedPosition
          || (recordedAt && progressTimestamp(nativeProgress.updatedAt) <= progressTimestamp(recordedAt))
          ? null
          : pendingProgress(nativeProgress, previousLocal,
              previousLocal?.syncStatus ? serverRevisionFromSummary(playbackBook.progress) : undefined);
        if (nativeProgress && !previousLocal?.syncStatus) nativeProgress.baseUpdatedAt = undefined;
      }
      if (!nativeAudio && !cancelled && previewStartedAt !== null) {
        forgetInterruptedClipPreview(window.localStorage, getServerStorageKey(), currentUser.id, playbackBook.id, previewStartedAt);
      }
      if (playbackBook.source === "device") {
        const local = freshestProgress(...localCopies, nativeProgress);
        if (local) updateBookProgress(playbackBook.id, local);
        applyProgress(local);
        return;
      }
      let freshestLocal = freshestProgress(...localCopies, nativeProgress);
      const listed = progressFromBookSummary(playbackBook.id, playbackBook.progress);
      const seekIntent = readProgressSeekIntent(progressSeekStorage(), getServerStorageKey(), currentUser.id, playbackBook.id);
      const optimisticSeekOptions = freshestLocal ? progressSeekOptions(seekIntent, freshestLocal, listed?.bookPositionSeconds) : null;
      const optimistic = !optimisticSeekOptions?.intentionalRegression && isSuspectProgressReset(freshestLocal, listed)
        ? listed
        : freshestProgress(freshestLocal, listed);
      applyProgress(optimistic, optimistic === listed || optimistic?.syncStatus === "synced");
      if (libraryReplay) {
        const replayed = await libraryReplay.catch(() => null);
        if (cancelled || playbackActionVersionRef.current !== restoreActionVersion) return;
        if (freshestLocal && replayed) {
          let rebased = freshestLocal;
          for (const { attempted, saved } of replayed.acknowledgements) {
            rebased = rebasePendingProgress(rebased, attempted, saved);
          }
          if (rebased !== freshestLocal) {
            freshestLocal = rebased;
            const acknowledgedReplay = readProgressCheckpoint(
              window.localStorage, getServerStorageKey(), currentUser.id, playbackBook.id
            );
            if (acknowledgedReplay?.syncStatus === "synced"
              && acknowledgedReplay.updatedAt === replayed.saved.updatedAt) {
              checkpoint = acknowledgedReplay;
            }
          }
        }
      }
      let server: Progress | null = null;
      let serverReachable = true;
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
          freshestLocal = identifyProgressRecording(freshestLocal);
          if (journalProgressAttempt(window.localStorage, getServerStorageKey(), currentUser.id, freshestLocal, checkpoint)) {
            checkpoint = freshestLocal;
          }
          const saved = await saveProgress(
            playbackBook.id,
            freshestLocal,
            seekOptions ?? undefined
          ).catch(() => null);
          if (cancelled || playbackActionVersionRef.current !== restoreActionVersion) return;
          const currentCheckpoint = readProgressCheckpoint(
            window.localStorage,
            getServerStorageKey(),
            currentUser.id,
            playbackBook.id
          );
          if (saved) {
            if (seekOptions?.intentionalSeek) {
              acknowledgeProgressSeekIntent(progressSeekStorage(), getServerStorageKey(), currentUser.id, playbackBook.id, seekIntent?.id);
            }
            const originalJournalUnchanged = progressAfterSave(currentCheckpoint, checkpoint, saved) === saved;
            const journalHealed = !originalJournalUnchanged
              && currentCheckpoint?.syncStatus === "synced"
              && currentCheckpoint.updatedAt === saved.updatedAt
              && currentCheckpoint.trackId === saved.trackId
              && Math.abs(currentCheckpoint.bookPositionSeconds - saved.bookPositionSeconds) <= 0.01;
            if (originalJournalUnchanged || progressAfterSave(currentCheckpoint, freshestLocal, saved) === saved) {
              serverCorrectedLocal = saved.accepted === false || saved.trackId !== freshestLocal.trackId
                || Math.abs(saved.bookPositionSeconds - freshestLocal.bookPositionSeconds) > 0.01;
              storeCanonicalServerProgress(playbackBook, saved, freshestLocal, originalJournalUnchanged ? checkpoint : freshestLocal);
              target = saved;
              targetIsCanonical = true;
            } else if (journalHealed) {
              serverCorrectedLocal = saved.accepted === false || saved.trackId !== freshestLocal.trackId
                || Math.abs(saved.bookPositionSeconds - freshestLocal.bookPositionSeconds) > 0.01;
              target = saved;
              targetIsCanonical = true;
            } else {
              storeCanonicalServerProgress(playbackBook, saved, freshestLocal);
            }
          } else if (currentCheckpoint?.syncStatus === "synced"
            && (checkpoint?.syncStatus !== "synced" || currentCheckpoint.updatedAt !== checkpoint.updatedAt)) {
            // The library reconnect's refusal healed the journal while this
            // resend was lost, so no reply will arrive to adopt the healed copy.
            serverCorrectedLocal = true;
            target = currentCheckpoint;
            targetIsCanonical = true;
          }
        }
      }
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
}
