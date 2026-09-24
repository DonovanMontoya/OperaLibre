import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  acknowledgeCarSessions,
  addCarPlayListener,
  beginCarLibrarySession,
  getCarPlayState,
  releaseCarPlaybackOwnership,
  setCarPlaybackOwner,
  supportsCarPlay,
  syncCarLibrary
} from "./carPlay";
import { BOOK_GAIN_DEFAULT } from "./bookVolume";
import { getServerStorageKey, mediaUrl } from "./api";
import { buildCarLibrarySnapshot, type CarPlaybackSession, carSessionIsWorthSaving } from "./carLibrary.ts";
import { cacheProgress, getOfflineCoverUrl, getOfflineTrackUrl, warnCacheFailure } from "./offline";
import type { PluginListenerHandle } from "@capacitor/core";
import type { AuthUser, Book, Progress } from "./types";
import { writeProgressCheckpoint } from "./reliability";
import type { QueuedProgressSave } from "./playbackTypes";

export function useCarPlay({
  acknowledgedSeekGenerationRef,
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
  /**
   * The book CarPlay started on the shared native player, if any.
   *
   * While it is set the app leaves the player alone: the driver's book is
   * playing through the same engine, and attaching this app's player to it
   * would load another book over theirs.
   */
  const [carPlaybackBookId, setCarPlaybackBookId] = useState<string | null>(null);
  /** When the app last claimed the player back from the car. */
  const carTakeoverAtRef = useRef(0);

  /**
   * What the car needs to know about, reduced to the parts it acts on.
   *
   * Positions are bucketed to the minute on purpose: a snapshot costs a
   * filesystem lookup per downloaded track, and rebuilding it every few seconds
   * while a book plays would keep the disk busy for a resume point the car
   * refines from the player's own checkpoint anyway.
   */
  const carLibrarySignature = useMemo(() => {
    if (!supportsCarPlay()) return "";
    return books
      .map((book) => [
        book.id,
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

  useEffect(() => {
    beginCarLibrarySession(`${getServerStorageKey()}:${currentUser.id}`);
  }, [currentUser.id]);

  useEffect(() => {
    if (!supportsCarPlay() || carLibrarySignature === "") return;
    let active = true;
    // Debounced: a library load, its progress fetch and the download scan all
    // land within a moment of each other, and the car only needs the result.
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
          // Only a book with local files is worth a disk lookup; everything
          // else streams, and the car will say so with a cloud marker.
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

  // Installed once per library, but the work they do reads the live player —
  // which book, which track, where its clock is. Going through a ref keeps a
  // listener from persisting progress against the track that was open when it
  // was registered.
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
    // The listeners above only fire while JS is running. Everything that
    // happened during a drive is collected here instead, whenever the app
    // comes back to the foreground.
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", sync);
      for (const handle of handles) void handle?.remove();
    };
    // Keyed on the library rather than on nothing: a session for a book the app
    // had not loaded yet is left pending, and this re-runs — and saves it — once
    // that book is on the shelf.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookIdsKey, currentUser.id]);

  /**
   * Picks up whatever happened on the car screen: who owns the player, and the
   * progress made during a drive.
   */
  async function adoptCarPlaybackState() {
    if (!supportsCarPlay()) return;
    const state = await getCarPlayState().catch(() => null);
    if (!state) return;
    // A take-over the app just performed is not yet visible natively — the
    // hand-back happens on the load() the attach is about to make — so a
    // reported owner from the moments after one is ignored rather than
    // parking the player that is starting up.
    const takeoverIsSettling = Date.now() - carTakeoverAtRef.current < 5_000;
    if (!state.carOwnedBookId || !takeoverIsSettling) {
      setCarPlaybackOwner(state.carOwnedBookId);
      setCarPlaybackBookId(state.carOwnedBookId);
    }
    if (state.sessions.length > 0) await saveCarPlaybackSessions(state.sessions);
  }

  /**
   * Saves what was listened to in the car.
   *
   * The car deliberately writes nothing itself: this goes through the same
   * queue as every other checkpoint, so the local copy, the offline cache and
   * the server's staleness and suspect-reset rules all apply exactly as they do
   * to playback on the phone.
   */
  async function saveCarPlaybackSessions(sessions: CarPlaybackSession[]) {
    const handled: CarPlaybackSession[] = [];
    for (const session of sessions) {
      const book = booksRef.current.find((candidate) => candidate.id === session.bookId);
      // A book the app has not loaded yet is left pending rather than dropped;
      // the next sync, once the library is in, will save it.
      if (!book) continue;
      handled.push(session);
      if (!carSessionIsWorthSaving(session, book)) continue;
      const progress: Progress = {
        bookId: book.id,
        trackId: session.trackId,
        positionSeconds: Math.max(0, session.positionSeconds),
        bookPositionSeconds: Math.max(0, session.bookPositionSeconds),
        durationSeconds: session.durationSeconds ?? book.durationSeconds ?? null,
        updatedAt: new Date(session.updatedAt).toISOString(),
        finishedOverride: book.progress?.finishedOverride ?? null
      };
      progressMutationVersion.current += 1;
      writeProgressCheckpoint(window.localStorage, getServerStorageKey(), currentUser.id, progress);
      void cacheProgress(currentUser.id, progress).catch(warnCacheFailure("cache listening progress"));
      updateBookProgress(book.id, progress);
      if (book.source === "device") continue;
      queuedProgressSaves.current.set(book.id, {
        bookId: book.id,
        progress,
        isPaused: true,
        // A chapter jump or a restart in the car lands here as a backwards
        // move the server would otherwise refuse. The generation has to clear
        // the last acknowledged one for the flag to survive the queue.
        intentionalSeekGeneration: session.intentionalRegression
          ? (acknowledgedSeekGenerationRef.current.get(book.id) ?? 0) + 1
          : 0,
        intentionalRegression: session.intentionalRegression
      });
    }
    if (queuedProgressSaves.current.size > 0) await flushProgressSaveQueue();
    // Acknowledged even when the server write failed: the position is in the
    // local checkpoint and the offline cache by now, and the usual retry owns
    // it from here. Holding the session instead would replay it forever.
    await acknowledgeCarSessions(handled).catch(() => undefined);
  }

  /**
   * Takes the shared player back from the car. Ownership is dropped before the
   * player attaches so the attach does its normal work — including the load()
   * that tells the native side the app is driving again.
   */
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
    takeOverFromCar
  };
}
