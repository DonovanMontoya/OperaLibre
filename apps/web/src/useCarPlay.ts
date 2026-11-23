import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  acknowledgeCarSessions,
  addCarPlayListener,
  beginCarLibrarySession,
  getCarPlayState,
  releaseCarPlaybackOwnership,
  setCarPlaybackOwner,
  supportsCarPlay,
  stopCarPlayback,
  syncCarLibrary
} from "./carPlay";
import { BOOK_GAIN_DEFAULT } from "./bookVolume";
import { getServerStorageKey, mediaUrl } from "./api";
import { buildCarLibrarySnapshot, type CarPlaybackSession, carSessionIsWorthSaving } from "./carLibrary.ts";
import { cacheProgress, getCachedProgress, getOfflineCoverUrl, getOfflineTrackUrl, warnCacheFailure } from "./offline";
import type { PluginListenerHandle } from "@capacitor/core";
import type { AuthUser, Book, Progress } from "./types";
import { pendingProgress, progressTimestamp, readProgressCheckpoint, serverRevisionFromSummary, shouldFlagIntentionalRegression, writeProgressCheckpoint } from "./reliability";
import type { QueuedProgressSave } from "./playbackTypes";
import { progressSeekStorage, recordProgressSeekIntent } from "./progressSeekIntent";

type QueuedCarSession = {
  session: CarPlaybackSession;
  journaled: boolean;
  cached: Promise<boolean>;
  answered: () => boolean;
};

/** The device time a stored copy was recorded, comparable with native session times. */
function localRecordedAt(progress: Progress | null | undefined): number {
  const recordedAt = progress?.localUpdatedAt ?? (progress?.syncStatus === "synced" ? undefined : progress?.updatedAt);
  return recordedAt ? progressTimestamp(recordedAt) : 0;
}

/**
 * Whether this phone holds a durable copy recorded after the native session.
 * Only device times are compared: a server revision uses the server's clock,
 * and skew would let it pass for a later copy and discard the only native one.
 */
function carSessionIsSuperseded(session: CarPlaybackSession, local: Array<Progress | null | undefined>): boolean {
  return Math.max(0, ...local.map(localRecordedAt)) > session.updatedAt;
}

export function useCarPlay({
  acknowledgedSeekGenerationRef,
  acknowledgedServerPositionRef,
  bookGains,
  bookIdsKey,
  books,
  booksRef,
  currentUser,
  downloadedBookIds,
  flushProgressSaveQueue,
  progressMutationVersion,
  queuedProgressSaves,
  speed,
  updateBookProgress
}: {
  acknowledgedSeekGenerationRef: RefObject<Map<string, number>>;
  acknowledgedServerPositionRef: RefObject<Map<string, number>>;
  bookGains: Record<string, number>;
  bookIdsKey: string;
  books: Book[];
  booksRef: RefObject<Book[]>;
  currentUser: AuthUser;
  downloadedBookIds: Set<string>;
  flushProgressSaveQueue: () => Promise<void>;
  progressMutationVersion: RefObject<number>;
  queuedProgressSaves: RefObject<Map<string, QueuedProgressSave>>;
  speed: number;
  updateBookProgress: (bookId: string, saved: Progress) => void;
}) {
  const [carPlaybackBookId, setCarPlaybackBookId] = useState<string | null>(null);
  const carTakeoverAtRef = useRef(0);
  // Book id to the newest native session applied without a durable copy yet.
  const unsavedCarSessionsRef = useRef(new Map<string, number>());
  // Book id to the newest native session the server rejected in this run.
  const rejectedCarSessionsRef = useRef(new Map<string, number>());

  const carLibrarySignature = useMemo(() => {
    if (!supportsCarPlay()) return "";
    return books
      .map((book) => [
        book.id,
        book.coverArtUrl ?? "",
        book.coverArtContentType ?? "",
        book.localCoverPath ?? "",
        book.hasCoverOverride ?? "",
        Math.floor((book.progress?.bookPositionSeconds ?? 0) / 60),
        book.progress?.status ?? "",
        downloadedBookIds.has(book.id) ? "1" : "0",
        book.tracks.length,
        bookGains[book.id] ?? BOOK_GAIN_DEFAULT
      ].join("~"))
      .join("|");
  }, [books, bookGains, downloadedBookIds]);
  const carPlaybackBook = carPlaybackBookId
    ? books.find((book) => book.id === carPlaybackBookId) ?? null
    : null;

  const scope = `${getServerStorageKey()}:${currentUser.id}`;
  useEffect(() => {
    beginCarLibrarySession(scope);
  }, [scope]);

  useEffect(() => {
    if (!supportsCarPlay() || carLibrarySignature === "") return;
    let active = true;
    const timer = window.setTimeout(() => {
      void buildCarLibrarySnapshot({
        scopePrefix: `${getServerStorageKey()}:${currentUser.id}`,
        playbackRate: speed,
        books,
        downloadedBookIds,
        bookGains,
        coverUrl: async (book) => {
          const local = await getOfflineCoverUrl(book).catch(() => null);
          return local ?? (book.coverArtUrl ? mediaUrl(book.coverArtUrl) : null);
        },
        resolveTrackUrl: async (book, track) => {
          const local = book.source === "device"
            || book.deviceBookId
            || downloadedBookIds.has(book.id)
            ? await getOfflineTrackUrl(book, track).catch(() => null)
            : null;
          return local ?? (track.streamUrl ? mediaUrl(track.streamUrl) : null);
        }
      })
        .then((snapshot) => {
          if (active) return syncCarLibrary(snapshot);
        })
        .catch(() => undefined);
    }, 1_500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
    // Rebuilt from the signature rather than the book objects, which are
    // replaced on every progress save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carLibrarySignature, currentUser.id, speed]);

  const carEventHandlersRef = useRef({
    playbackStarted: (_bookId: string) => {},
    sync: () => {}
  });

  useEffect(() => {
    if (!supportsCarPlay()) return;
    let active = true;
    const handles: Array<PluginListenerHandle | null> = [];
    const sync = () => {
      if (active) carEventHandlersRef.current.sync();
    };
    void addCarPlayListener("carPlaybackStarted", (event) => {
      if (!active) return;
      carEventHandlersRef.current.playbackStarted(event.bookId);
    }).then((handle) => {
      if (!active) void handle?.remove();
      else handles.push(handle);
    });
    void addCarPlayListener("carPlaybackEnded", () => {
      if (!active) return;
      setCarPlaybackOwner(null);
      setCarPlaybackBookId(null);
      sync();
    }).then((handle) => {
      if (!active) void handle?.remove();
      else handles.push(handle);
    });
    void addCarPlayListener("carDisconnected", sync).then((handle) => {
      if (!active) void handle?.remove();
      else handles.push(handle);
    });
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", sync);
      for (const handle of handles) void handle?.remove();
    };
  }, [bookIdsKey, currentUser.id]);

  async function adoptCarPlaybackState() {
    if (!supportsCarPlay()) return;
    const state = await getCarPlayState().catch(() => null);
    if (!state) return;
    const takeoverIsSettling = Date.now() - carTakeoverAtRef.current < 5_000;
    if (!state.carOwnedBookId || !takeoverIsSettling) {
      setCarPlaybackOwner(state.carOwnedBookId);
      setCarPlaybackBookId(state.carOwnedBookId);
    }
    if (state.sessions.length > 0) await saveCarPlaybackSessions(state.sessions);
  }

  async function readCachedCarProgress(sessions: CarPlaybackSession[]) {
    return new Map(await Promise.all(sessions.map(async ({ bookId }) =>
      [bookId, await getCachedProgress(currentUser.id, bookId).catch(() => null)] as const)));
  }

  function queueCarPlaybackSessions(sessions: CarPlaybackSession[], cachedProgress: Map<string, Progress | null>) {
    const queued: QueuedCarSession[] = [];
    for (const session of sessions) {
      const book = booksRef.current.find((candidate) => candidate.id === session.bookId);
      if (!book) continue;
      const checkpoint = readProgressCheckpoint(window.localStorage, getServerStorageKey(), currentUser.id, book.id);
      // Native retains a session until it is saved, so it can come back after
      // the phone has recorded and saved a later position.
      if (carSessionIsSuperseded(session, [checkpoint, cachedProgress.get(book.id)])) {
        queued.push({ session, journaled: true, cached: Promise.resolve(true), answered: () => true });
        continue;
      }
      // The server kept another copy; resending on its new revision would
      // overwrite it, so the session stays native until something newer.
      const rejectedAt = rejectedCarSessionsRef.current.get(book.id);
      if (rejectedAt !== undefined && session.updatedAt <= rejectedAt) continue;
      // An applied session shows on the shelf before any copy of it is
      // durable, so it would otherwise look unchanged on the next sync.
      const unsavedAt = unsavedCarSessionsRef.current.get(book.id);
      const unsaved = unsavedAt !== undefined && session.updatedAt >= unsavedAt;
      if (!unsaved && !carSessionIsWorthSaving(session, book)) {
        queued.push({ session, journaled: true, cached: Promise.resolve(true), answered: () => true });
        continue;
      }
      // A retained session can outlive the copy it continued from. Its base
      // comes from a local copy or the revision native recorded, never from a
      // later summary; with neither it is kept on this phone only.
      const local = checkpoint ?? cachedProgress.get(book.id) ?? null;
      const nativeBase = typeof session.baseUpdatedAt === "string" ? session.baseUpdatedAt : undefined;
      const remote = book.source !== "device" && (local !== null || nativeBase !== undefined);
      const newIntentionalSeek = session.intentionalRegression
        && (!local?.localUpdatedAt || session.updatedAt > progressTimestamp(local.localUpdatedAt));
      const progress: Progress = pendingProgress({
        bookId: book.id,
        trackId: session.trackId,
        positionSeconds: Math.max(0, session.positionSeconds),
        bookPositionSeconds: Math.max(0, session.bookPositionSeconds),
        durationSeconds: session.durationSeconds ?? book.durationSeconds ?? null,
        updatedAt: new Date(session.updatedAt).toISOString(),
        finishedOverride: book.progress?.finishedOverride ?? null
      }, local, local ? serverRevisionFromSummary(book.progress) : nativeBase, newIntentionalSeek);
      const seekIntent = newIntentionalSeek && remote
        ? recordProgressSeekIntent(progressSeekStorage(), getServerStorageKey(), currentUser.id, book.id,
          progress.bookPositionSeconds, session.updatedAt)
        : undefined;
      progressMutationVersion.current += 1;
      const journaled = writeProgressCheckpoint(window.localStorage, getServerStorageKey(), currentUser.id, progress);
      if (journaled) unsavedCarSessionsRef.current.delete(book.id);
      else unsavedCarSessionsRef.current.set(book.id, Math.max(unsavedAt ?? 0, session.updatedAt));
      const cached = cacheProgress(currentUser.id, progress).then(() => true, (error: unknown) => {
        warnCacheFailure("cache listening progress")(error);
        return false;
      });
      updateBookProgress(book.id, progress);
      let answered = false;
      queued.push({ session, journaled, cached, answered: () => answered });
      if (!remote) continue;
      const previousResponse = queuedProgressSaves.current.get(book.id)?.onServerResponse;
      queuedProgressSaves.current.set(book.id, {
        bookId: book.id,
        progress,
        seekIntentId: seekIntent?.id,
        intentionalSeekGeneration: newIntentionalSeek
          ? (acknowledgedSeekGenerationRef.current.get(book.id) ?? 0) + 1
          : 0,
        intentionalRegression: newIntentionalSeek && shouldFlagIntentionalRegression(
          session.bookPositionSeconds, acknowledgedServerPositionRef.current.get(book.id)
        ),
        onServerResponse: (saved) => {
          previousResponse?.(saved);
          if (saved.accepted !== false) answered = true;
          else rejectedCarSessionsRef.current.set(book.id,
            Math.max(rejectedCarSessionsRef.current.get(book.id) ?? 0, session.updatedAt));
        }
      });
    }
    return queued;
  }

  /**
   * Native keeps each checkpoint until it is acknowledged, so a changed
   * position is acknowledged only once localStorage, IndexedDB, or the server
   * holds it. Anything else stays native for the next sync or launch.
   */
  async function flushCarPlaybackSessions(queued: QueuedCarSession[]) {
    if (queuedProgressSaves.current.size > 0) await flushProgressSaveQueue();
    const released = queued.filter((entry) => entry.journaled || entry.answered());
    await acknowledgeSavedCarSessions(released);
    // Only a session nothing else holds waits for IndexedDB, which can stall.
    await Promise.all(queued.filter((entry) => !released.includes(entry)).map(async (entry) => {
      if (await entry.cached) await acknowledgeSavedCarSessions([entry]);
    }));
  }

  async function acknowledgeSavedCarSessions(saved: QueuedCarSession[]) {
    for (const { session } of saved) {
      const unsavedAt = unsavedCarSessionsRef.current.get(session.bookId);
      if (unsavedAt !== undefined && unsavedAt <= session.updatedAt) unsavedCarSessionsRef.current.delete(session.bookId);
    }
    await acknowledgeCarSessions(saved.map((entry) => entry.session)).catch(() => undefined);
  }

  async function saveCarPlaybackSessions(sessions: CarPlaybackSession[]) {
    await flushCarPlaybackSessions(queueCarPlaybackSessions(sessions, await readCachedCarProgress(sessions)));
  }

  async function stopCarPlaybackForRemoval(bookId: string) {
    if (!supportsCarPlay()) return;
    const state = await stopCarPlayback(bookId);
    setCarPlaybackOwner(state.carOwnedBookId);
    setCarPlaybackBookId(state.carOwnedBookId);
    const cachedProgress = await readCachedCarProgress(state.sessions);
    void flushCarPlaybackSessions(queueCarPlaybackSessions(state.sessions, cachedProgress)).catch(() => undefined);
  }

  function takeOverFromCar() {
    carTakeoverAtRef.current = Date.now();
    releaseCarPlaybackOwnership();
    setCarPlaybackBookId(null);
  }

  return {
    adoptCarPlaybackState,
    carEventHandlersRef,
    carPlaybackBook,
    carPlaybackBookId,
    setCarPlaybackBookId,
    takeOverFromCar,
    stopCarPlaybackForRemoval
  };
}
