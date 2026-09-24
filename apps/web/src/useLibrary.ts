import { type Dispatch, type RefObject, type SetStateAction, useCallback } from "react";
import {
  backfillDeviceLibraryMetadata,
  getDeviceBooks,
  getDeviceProgress,
  mergeDeviceAndServerBooks,
  migrateDeviceLibraryFileExtensions
} from "./localLibrary";
import type { AuthUser, Book, LibationBook, Progress } from "./types";
import {
  freshestProgress,
  progressAfterSave,
  progressTimestamp,
  readProgressCheckpoint,
  resolveActivePlaybackBookId,
  resolveBookId,
  resolveProgressLocation
} from "./reliability";
import { readStoredBookId, withoutCachedBookGains } from "./appStorage";
import { startupDestinationAfterLoad } from "./startup";
import { getBooks, getLibationBooks, getServerStorageKey, isServerNotReadyError, saveProgress } from "./api";
import { cacheLibrary, getCachedLibrary, getCachedProgress } from "./offline";
import type { NativeTab } from "./nativeTabs";

/**
 * Loads the library from the server, the offline cache or the device, and
 * restores the book to show and play once it arrives.
 */
export function useLibrary({
  audioRef,
  currentUser,
  initialLibraryHydrated,
  isOperaLibre,
  libraryRequestGenerationRef,
  libraryRetryTimerRef,
  loadBooksRef,
  localMode,
  native,
  nativeAudioRef,
  nativePlaybackPlayingRef,
  reconcileServerBookGains,
  setBooks,
  setError,
  setIsLoading,
  setIsOffline,
  setLibationBooks,
  setLibationBooksLoaded,
  setNativeTab,
  setPlaybackBookId,
  setSelectedBookId,
  setStartupViewReady,
  startupNavigationResolved,
  startupViewReadyRef,
  storeCanonicalServerProgress
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  currentUser: AuthUser;
  initialLibraryHydrated: RefObject<boolean>;
  isOperaLibre: boolean;
  libraryRequestGenerationRef: RefObject<number>;
  libraryRetryTimerRef: RefObject<number | null>;
  loadBooksRef: RefObject<() => Promise<void>>;
  localMode: boolean;
  native: boolean;
  nativeAudioRef: RefObject<boolean>;
  nativePlaybackPlayingRef: RefObject<boolean>;
  reconcileServerBookGains: (payload: readonly Book[]) => void;
  setBooks: Dispatch<SetStateAction<Book[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setIsOffline: Dispatch<SetStateAction<boolean>>;
  setLibationBooks: Dispatch<SetStateAction<LibationBook[]>>;
  setLibationBooksLoaded: Dispatch<SetStateAction<boolean>>;
  setNativeTab: Dispatch<SetStateAction<NativeTab>>;
  setPlaybackBookId: Dispatch<SetStateAction<string | null>>;
  setSelectedBookId: Dispatch<SetStateAction<string | null>>;
  setStartupViewReady: Dispatch<SetStateAction<boolean>>;
  startupNavigationResolved: RefObject<boolean>;
  startupViewReadyRef: RefObject<boolean>;
  storeCanonicalServerProgress: (book: Book, saved: Progress) => void;
}) {
  const loadBooks = useCallback(async () => {
    const requestGeneration = ++libraryRequestGenerationRef.current;
    const isCurrentRequest = () => requestGeneration === libraryRequestGenerationRef.current;
    if (libraryRetryTimerRef.current !== null) {
      window.clearTimeout(libraryRetryTimerRef.current);
      libraryRetryTimerRef.current = null;
    }
    setIsLoading(true);
    setError(null);
    if (native) {
      await migrateDeviceLibraryFileExtensions();
      await backfillDeviceLibraryMetadata();
    }
    const deviceBooks = native ? getDeviceBooks() : [];
    const applyLoadedBooks = (nextBooks: Book[], definitive = false) => {
      if (!isCurrentRequest()) return;
      setBooks(nextBooks);
      setSelectedBookId((existing) =>
        resolveBookId(nextBooks, existing ?? readStoredBookId(currentUser.id, "selectedBookId"))
      );
      // A background refresh that lists the playing book as finished must not
      // pull the session out from under the listener; only its absence can.
      const isPlayingNow = nativeAudioRef.current
        ? nativePlaybackPlayingRef.current
        : !!audioRef.current && !audioRef.current.paused;
      setPlaybackBookId((existing) => {
        const preferred = existing ?? readStoredBookId(currentUser.id, "playbackBookId");
        const next = resolveActivePlaybackBookId(nextBooks, preferred, isPlayingNow);
        const preferredIsPresent = !!preferred && nextBooks.some((book) => book.id === preferred);
        // A device-only first paint may not contain the stored server book.
        // Wait for the cached/live shelf before deciding that session vanished.
        if (!next && preferred && !preferredIsPresent && !definitive) return existing;
        const destination = native
          ? startupDestinationAfterLoad(
              startupNavigationResolved.current,
              startupViewReadyRef.current,
              next,
              preferred,
              preferredIsPresent,
              definitive
            )
          : null;
        if (destination) {
          startupNavigationResolved.current = true;
          setNativeTab(destination.tab);
          // The stored selection may be a book last browsed on the shelf.
          if (next) setSelectedBookId(next);
          if (destination.reveal) {
            startupViewReadyRef.current = true;
            setStartupViewReady(true);
          }
        }
        return next;
      });
    };
    if (localMode) {
      applyLoadedBooks(deviceBooks, true);
      if (isCurrentRequest()) {
        setIsOffline(false);
        setIsLoading(false);
      }
      return;
    }

    const liveLibraryRequest = getBooks().then(
      (serverBooks) => ({ ok: true as const, serverBooks }),
      (requestError: unknown) => ({ ok: false as const, requestError })
    );
    let hydratedServerBooks: Book[] = [];
    if (!initialLibraryHydrated.current) {
      initialLibraryHydrated.current = true;

      // Device imports are synchronous, so they can paint on the first native
      // frame. The IndexedDB shelf follows immediately on every platform while
      // the live request runs.
      if (deviceBooks.length) {
        applyLoadedBooks(deviceBooks);
        setIsLoading(false);
      }
      hydratedServerBooks = withoutCachedBookGains(
        await getCachedLibrary(currentUser.id).catch(() => [])
      );
      if (!isCurrentRequest()) return;
      const hydratedBooks = mergeDeviceAndServerBooks(hydratedServerBooks, deviceBooks);
      if (hydratedBooks.length) {
        applyLoadedBooks(hydratedBooks);
        setIsOffline(false);
        setIsLoading(false);
      }
    }

    try {
      const liveLibrary = await liveLibraryRequest;
      if (!isCurrentRequest()) return;
      if (!liveLibrary.ok) throw liveLibrary.requestError;
      const serverBooks = liveLibrary.serverBooks;
      const nextBooks = mergeDeviceAndServerBooks(serverBooks, deviceBooks);
      // Reconcile every durable local copy, not only imported device media.
      // This brings progress recorded while offline back to the server even if
      // the user opens a different book after reconnecting.
      void Promise.all(nextBooks.map(async (book) => {
        if (book.source !== "server") return;
        const deviceProgress = book.deviceBookId ? getDeviceProgress(book.deviceBookId) : null;
        const deviceBook = book.deviceBookId
          ? deviceBooks.find((candidate) => candidate.id === book.deviceBookId)
          : null;
        const deviceTrackIndex = deviceBook?.tracks.findIndex(
          (track) => track.id === deviceProgress?.trackId
        ) ?? -1;
        const mappedDevice = deviceProgress && deviceTrackIndex >= 0 && book.tracks[deviceTrackIndex]
          ? {
              ...deviceProgress,
              bookId: book.id,
              trackId: book.tracks[deviceTrackIndex].id
            }
          : null;
        const checkpoint = readProgressCheckpoint(
          window.localStorage,
          getServerStorageKey(),
          currentUser.id,
          book.id
        );
        const cached = await getCachedProgress(currentUser.id, book.id).catch(() => null);
        if (!isCurrentRequest()) return;
        const local = freshestProgress(mappedDevice, checkpoint, cached);
        const serverBook = serverBooks.find((candidate) => candidate.id === book.id);
        if (
          !local ||
          (serverBook?.progress && progressTimestamp(local.updatedAt) <= progressTimestamp(serverBook.progress.updatedAt))
        ) {
          return;
        }
        const location = resolveProgressLocation(book.tracks, local);
        if (!location) return;
        if (!isCurrentRequest()) return;
        const attempted: Progress = {
          ...local,
          trackId: location.trackId,
          positionSeconds: location.positionSeconds
        };
        const saved = await saveProgress(
          book.id,
          attempted,
          { isPaused: true }
        ).catch(() => null);
        if (!saved || !isCurrentRequest()) return;
        const currentCheckpoint = readProgressCheckpoint(
          window.localStorage,
          getServerStorageKey(),
          currentUser.id,
          book.id
        );
        if (progressAfterSave(currentCheckpoint, attempted, saved) === saved) {
          storeCanonicalServerProgress(book, saved);
        }
      })).catch(() => undefined);
      if (!isCurrentRequest()) return;
      applyLoadedBooks(nextBooks, true);
      reconcileServerBookGains(serverBooks);
      setIsOffline(false);
      if (isCurrentRequest()) void cacheLibrary(currentUser.id, serverBooks);
      if (isOperaLibre) {
        // Audio tags commonly omit the publisher blurb. Libation already has
        // the correct Audible description and returns its matched local book
        // id, so enrich in the background without delaying the shelf.
        void getLibationBooks()
          .then((catalog) => {
            if (!isCurrentRequest()) return;
            setLibationBooks(catalog);
            setLibationBooksLoaded(true);
          })
          .catch(() => undefined);
      }
    } catch (loadError) {
      const cachedServer = hydratedServerBooks.length
        ? hydratedServerBooks
        : withoutCachedBookGains(await getCachedLibrary(currentUser.id));
      if (!isCurrentRequest()) return;
      const cached = mergeDeviceAndServerBooks(cachedServer, deviceBooks);
      applyLoadedBooks(cached, true);
      if (isServerNotReadyError(loadError)) {
        // The server answered: it is up, its startup scan just has not
        // published a catalogue yet. Keep the cached shelf without muting
        // anything, and ask again when it said to.
        setIsOffline(false);
        setError("The server is still loading its library. The shelf refreshes once it is ready.");
        const delayMs = Math.min(30_000, Math.max(2_000, (loadError.retryAfterSeconds ?? 5) * 1000));
        libraryRetryTimerRef.current = window.setTimeout(() => {
          libraryRetryTimerRef.current = null;
          void loadBooksRef.current();
        }, delayMs);
        return;
      }
      setIsOffline(true);
      if (cached.length) {
        setError("Offline mode — showing downloaded books and cached library.");
      } else {
        setError("The audiobook server is not reachable.");
      }
    } finally {
      if (isCurrentRequest()) setIsLoading(false);
    }
    // storeCanonicalServerProgress and reconcileServerBookGains read only
    // currentUser.id (listed), refs and state setters, so the render that
    // created this callback cannot hand them anything stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser.id, isOperaLibre, localMode, native]);

  return {
    loadBooks
  };
}
