import { getBooks, isNetworkError, isServerNotReadyError, refreshLibroAccount, rescanLibrary } from "./api";
import { getDeviceBooks, mergeDeviceAndServerBooks } from "./localLibrary";
import { resolveActivePlaybackBookId, resolveBookId } from "./reliability";
import { readStoredBookId } from "./appStorage";
import type { AuthUser, Book, LibroAccountSummary } from "./types";
import { type Dispatch, type RefObject, type SetStateAction, useCallback } from "react";
import { refreshPurchaseSources } from "./purchaseRefresh";
import { refreshLibroDevice } from "./libroDevice";
import type { NativeTab } from "./nativeTabs";
import type { LibrarySource } from "./shelfSort";

/**
 * Rescans and refreshes the library and purchase sources, and applies admin
 * edits that change which books exist.
 */
export function useLibraryRefresh({
  audioRef,
  canBrowseLibation,
  currentUser,
  flushProgressSaveQueue,
  isOperaLibre,
  libationBooksLoaded,
  librarySource,
  libroAccounts,
  libroOnDevice,
  loadBooks,
  loadLibationBooks,
  localMode,
  native,
  nativeAudio,
  nativePlaybackPlayingRef,
  pausePlayback,
  persistProgress,
  playbackBookIdRef,
  reconcileServerBookGains,
  setBooks,
  setCurrentTrackId,
  setError,
  setIsLoading,
  setIsOffline,
  setLibroRefreshKey,
  setNativeTab,
  setPlaybackBookId,
  setPosition,
  setSelectedBookId
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  canBrowseLibation: boolean;
  currentUser: AuthUser;
  flushProgressSaveQueue: () => Promise<void>;
  isOperaLibre: boolean;
  libationBooksLoaded: boolean;
  librarySource: LibrarySource;
  libroAccounts: LibroAccountSummary[] | null;
  libroOnDevice: boolean;
  loadBooks: () => Promise<void>;
  loadLibationBooks: (clearError?: boolean) => Promise<void>;
  localMode: boolean;
  native: boolean;
  nativeAudio: boolean;
  nativePlaybackPlayingRef: RefObject<boolean>;
  pausePlayback: (audio: HTMLAudioElement | null | undefined) => void;
  persistProgress: () => Promise<void>;
  playbackBookIdRef: RefObject<string | null>;
  reconcileServerBookGains: (payload: readonly Book[]) => void;
  setBooks: Dispatch<SetStateAction<Book[]>>;
  setCurrentTrackId: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setIsOffline: Dispatch<SetStateAction<boolean>>;
  setLibroRefreshKey: Dispatch<SetStateAction<number>>;
  setNativeTab: Dispatch<SetStateAction<NativeTab>>;
  setPlaybackBookId: Dispatch<SetStateAction<string | null>>;
  setPosition: Dispatch<SetStateAction<number>>;
  setSelectedBookId: Dispatch<SetStateAction<string | null>>;
}) {
  async function refreshLibrary() {
    setIsLoading(true);
    if (localMode) {
      await loadBooks();
      return;
    }
    try {
      const nextBooks = isOperaLibre && !currentUser.isAdmin
        ? await getBooks()
        : await rescanLibrary();
      const visibleBooks = native
        ? mergeDeviceAndServerBooks(nextBooks, getDeviceBooks())
        : nextBooks;
      setBooks(visibleBooks);
      reconcileServerBookGains(nextBooks);
      setIsOffline(false);
      setSelectedBookId((existing) =>
        resolveBookId(visibleBooks, existing ?? readStoredBookId(currentUser.id, "selectedBookId"))
      );
      // As in loadBooks: a listing that calls the playing book finished must
      // not pull the session out from under the listener.
      const isPlayingNow = nativeAudio
        ? nativePlaybackPlayingRef.current
        : !!audioRef.current && !audioRef.current.paused;
      setPlaybackBookId((existing) =>
        resolveActivePlaybackBookId(
          visibleBooks,
          existing ?? readStoredBookId(currentUser.id, "playbackBookId"),
          isPlayingNow
        )
      );
      setError(null);
    } catch (refreshError) {
      if (isServerNotReadyError(refreshError)) {
        // Up but still scanning: loadBooks keeps asking until it publishes.
        setIsOffline(false);
        setError("The server is still loading its library. The shelf refreshes once it is ready.");
        void loadBooks();
        return;
      }
      // A rescan rejected by a reachable server is not "offline" — only
      // mute non-downloaded books when the server can't be reached at all.
      setIsOffline(isNetworkError(refreshError));
      setError("Library rescan failed.");
    } finally {
      setIsLoading(false);
    }
  }

  function applyAdminLibraryChange(nextBooks: Book[]) {
    const visibleBooks = native
      ? mergeDeviceAndServerBooks(nextBooks, getDeviceBooks())
      : nextBooks;
    setBooks(visibleBooks);
    reconcileServerBookGains(nextBooks);
    setSelectedBookId((existing) => resolveBookId(visibleBooks, existing));
    // Decided outside the state updater: updaters can run more than once and
    // must stay pure, and the teardown below has to save first.
    const isPlayingNow = nativeAudio
      ? nativePlaybackPlayingRef.current
      : !!audioRef.current && !audioRef.current.paused;
    const currentPlaybackBookId = playbackBookIdRef.current;
    const nextPlaybackBookId = resolveActivePlaybackBookId(visibleBooks, currentPlaybackBookId, isPlayingNow);
    if (currentPlaybackBookId && !nextPlaybackBookId) {
      pausePlayback(audioRef.current);
      setCurrentTrackId(null);
      setPosition(0);
      if (native) setNativeTab("shelf");
    }
    playbackBookIdRef.current = nextPlaybackBookId;
    setPlaybackBookId(nextPlaybackBookId);
    if (libationBooksLoaded) void loadLibationBooks();
  }

  async function prepareForAdminLibraryMutation() {
    pausePlayback(audioRef.current);
    await persistProgress();
    await flushProgressSaveQueue();
  }


  const refreshShelf = useCallback(async () => {
    if (librarySource === "all") {
      await refreshPurchaseSources([
        ...(libroAccounts?.length ? [async () => {
          try { await (libroOnDevice ? refreshLibroDevice() : refreshLibroAccount()); }
          finally { setLibroRefreshKey(key => key + 1); }
        }] : []),
        ...(canBrowseLibation ? [loadLibationBooks] : [])
      ]);
    } else if (librarySource === "audible") {
      await loadLibationBooks();
    } else if (librarySource === "libro") {
      await (libroOnDevice ? refreshLibroDevice() : refreshLibroAccount());
      setLibroRefreshKey(key => key + 1);
    } else {
      await loadBooks();
    }
  }, [librarySource, libroOnDevice, libroAccounts, canBrowseLibation, loadBooks, loadLibationBooks, setLibroRefreshKey]);

  return {
    applyAdminLibraryChange,
    prepareForAdminLibraryMutation,
    refreshLibrary,
    refreshShelf
  };
}
