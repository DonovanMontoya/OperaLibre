import type { AuthUser, Book, Track } from "./types";
import { cacheLibrary, cancelBookOfflineDownload, downloadBookForOffline, getBookOfflineReadiness, isBookDownloaded, removeBookDownload } from "./offline";
import { getServerStorageKey, mediaUrl } from "./api";
import { offlineDownloadMessage, type OfflineReadiness } from "./offlineReadiness";
import { errorMessage } from "./formatting";
import { type Dispatch, type RefObject, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { importAudiobookFromDevice, removeDeviceBook } from "./localLibrary";
import type { ServerCapabilities } from "./serverCapabilities";
import type { DeviceNotice } from "./ConfirmDialogs";
import type { DeviceDownloadActivity } from "./SettingsCards";
import type { LibrarySource } from "./shelfSort";
import type { NativeTab } from "./nativeTabs";
import type { PendingSeek } from "./playbackTypes";

export function useOfflineDownloads({
  audioRef,
  books,
  booksRef,
  capabilities,
  clearPlaybackSession,
  currentTrack,
  currentUser,
  downloadStatus,
  loadBooks,
  nativeAudio,
  nativePlaybackPlayingRef,
  pausePlayback,
  pendingSeekRef,
  persistProgress,
  playWhenTrackLoads,
  playbackBook,
  setActiveDownloads,
  setBooks,
  setDeviceImport,
  setDownloadStatus,
  setDownloadedBookIds,
  setLibrarySource,
  setNativeTab,
  setOfflineSource,
  setPendingSeek,
  setPlaybackBookId,
  setSelectedBookId
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  books: Book[];
  booksRef: RefObject<Book[]>;
  capabilities: ServerCapabilities;
  clearPlaybackSession: () => void;
  currentTrack: Track | null;
  currentUser: AuthUser;
  downloadStatus: DeviceNotice | null;
  loadBooks: () => Promise<void>;
  nativeAudio: boolean;
  nativePlaybackPlayingRef: RefObject<boolean>;
  pausePlayback: (audio: HTMLAudioElement | null | undefined) => void;
  pendingSeekRef: RefObject<PendingSeek | null>;
  persistProgress: () => Promise<void>;
  playWhenTrackLoads: RefObject<boolean>;
  playbackBook: Book | null;
  setActiveDownloads: Dispatch<SetStateAction<Record<string, DeviceDownloadActivity>>>;
  setBooks: Dispatch<SetStateAction<Book[]>>;
  setDeviceImport: Dispatch<SetStateAction<{ completed: number; total: number; } | null>>;
  setDownloadStatus: Dispatch<SetStateAction<DeviceNotice | null>>;
  setDownloadedBookIds: Dispatch<SetStateAction<Set<string>>>;
  setLibrarySource: Dispatch<SetStateAction<LibrarySource>>;
  setNativeTab: Dispatch<SetStateAction<NativeTab>>;
  setOfflineSource: Dispatch<SetStateAction<{ trackId: string; url: string | null; } | null>>;
  setPendingSeek: (value: PendingSeek | null) => void;
  setPlaybackBookId: Dispatch<SetStateAction<string | null>>;
  setSelectedBookId: Dispatch<SetStateAction<string | null>>;
}) {
  const downloadAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const activeDownloadIdsRef = useRef<Set<string>>(new Set());
  const retryDownloadIdsRef = useRef<Set<string>>(new Set());
  const cancellationsRef = useRef<Map<string, Promise<void>>>(new Map());
  const [readiness, setReadiness] = useState<Record<string, OfflineReadiness>>({});
  const [online, setOnline] = useState(navigator.onLine !== false);
  const scope = getServerStorageKey();
  const scanKey = useMemo(() => JSON.stringify([scope, books.map((book) => [
    book.id, book.tracks.map((track) => [track.id, track.fileName, track.localFilePath]),
    book.readingFile, book.companions, book.syncFile, book.coverArtUrl
  ])]), [books, scope]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const states: Record<string, OfflineReadiness> = {};
      // Undownloaded books need only an audio check. Scan one book at a time
      // so a large shelf cannot flood IndexedDB or the native file bridge.
      for (const book of booksRef.current) {
        if (cancelled) return;
        if (!(await isBookDownloaded(book).catch(() => false))) continue;
        const state = await getBookOfflineReadiness(book).catch(() => null);
        if (state) states[book.id] = state;
      }
      if (cancelled) return;
      setReadiness(states);
      setDownloadedBookIds(new Set(Object.entries(states).filter(([, state]) => state.audio).map(([id]) => id)));
    })();
    return () => { cancelled = true; };
  }, [scanKey, booksRef, setDownloadedBookIds]);

  async function refreshReadiness(book: Book) {
    const state = await getBookOfflineReadiness(book);
    if (getServerStorageKey() !== scope) return state;
    setReadiness((existing) => ({ ...existing, [book.id]: state }));
    setDownloadedBookIds((existing) => {
      const next = new Set(existing);
      if (state.audio) next.add(book.id);
      else next.delete(book.id);
      return next;
    });
    return state;
  }

  async function downloadForOffline(book: Book, retryMissing = false) {
    if (!capabilities.downloads) return;
    if (activeDownloadIdsRef.current.has(book.id)) return;
    activeDownloadIdsRef.current.add(book.id);
    if (retryMissing) retryDownloadIdsRef.current.add(book.id);
    const abortController = new AbortController();
    downloadAbortControllersRef.current.set(book.id, abortController);
    if (!retryMissing && playbackBook?.id === book.id) {
      persistProgress();
    }
    setDownloadStatus(null);
    setActiveDownloads((existing) => ({
      ...existing,
      [book.id]: { bookId: book.id, title: book.title, fraction: null, state: "queued", queuedAt: Date.now() }
    }));
    let readinessRefreshed = false;
    try {
      // Native jobs can finish while the WebView is closed. Save their shelf
      // before handing the transfer to the OS as well as after completion.
      await cacheLibrary(currentUser.id, booksRef.current.filter((candidate) => candidate.source !== "device"));
      await downloadBookForOffline(book, mediaUrl, (done, total, percent, state) => {
        const fraction = total > 0 ? Math.min(1, (done + (percent ?? 0) / 100) / total) : null;
        setActiveDownloads((existing) => ({
          ...existing,
          [book.id]: {
            bookId: book.id,
            title: book.title,
            fraction,
            state: state === "queued" ? "queued" : "running",
            queuedAt: existing[book.id]?.queuedAt ?? Date.now()
          }
        }));
      }, abortController.signal, retryMissing);
      // The files and the catalogue are one offline feature. Re-persist the
      // current authorized shelf after the transfer so a quick app kill cannot
      // leave durable audio with no metadata from which to render or play it.
      await cacheLibrary(
        currentUser.id,
        booksRef.current.filter((candidate) => candidate.source !== "device")
      );
      const state = await refreshReadiness(book);
      readinessRefreshed = true;
      if (getServerStorageKey() === scope) {
        setDownloadStatus({ bookId: book.id, message: offlineDownloadMessage(book.title, state) });
      }
    } catch (downloadError) {
      if (abortController.signal.aborted) return;
      setDownloadStatus({
        bookId: book.id,
        message: `${book.title}: ${errorMessage(downloadError, "Download failed.")}`
      });
    } finally {
      await cancellationsRef.current.get(book.id)?.catch(() => undefined);
      if (!readinessRefreshed) await refreshReadiness(book).catch(() => undefined);
      if (downloadAbortControllersRef.current.get(book.id) === abortController) {
        downloadAbortControllersRef.current.delete(book.id);
      }
      activeDownloadIdsRef.current.delete(book.id);
      retryDownloadIdsRef.current.delete(book.id);
      cancellationsRef.current.delete(book.id);
      setActiveDownloads((existing) => {
        const next = { ...existing };
        delete next[book.id];
        return next;
      });
    }
  }

  async function cancelOfflineDownload(book: Pick<Book, "id" | "title">) {
    const abortController = downloadAbortControllersRef.current.get(book.id);
    if (!abortController) return;
    const retryMissing = retryDownloadIdsRef.current.has(book.id);
    const cancellation = cancelBookOfflineDownload(book, retryMissing);
    cancellationsRef.current.set(book.id, cancellation);
    abortController.abort();
    setDownloadStatus({ bookId: book.id, message: `${book.title} download cancelled` });
    try {
      await cancellation;
    } catch (error) {
      setDownloadStatus({
        bookId: book.id,
        message: `${book.title}: ${errorMessage(error, "Could not cancel the download.")}`
      });
    }
  }

  useEffect(() => () => {
    for (const controller of downloadAbortControllersRef.current.values()) controller.abort();
    downloadAbortControllersRef.current.clear();
  }, []);

  async function importFromDevice() {
    setDownloadStatus(null);
    try {
      setDeviceImport({ completed: 0, total: 0 });
      const book = await importAudiobookFromDevice((completed, total) => setDeviceImport({ completed, total }));
      setBooks((existing) => [...existing, book]);
      setDownloadedBookIds((existing) => new Set(existing).add(book.id));
      setSelectedBookId(book.id);
      setPlaybackBookId(book.id);
      setLibrarySource("local");
      setDownloadStatus({ bookId: book.id, message: `${book.title} added from this device` });
      setNativeTab("shelf");
    } catch (error) {
      const message = errorMessage(error, "The audiobook could not be imported.");
      if (!/cancel/i.test(message)) setDownloadStatus({ message, source: "deviceImport" });
    } finally {
      setDeviceImport(null);
    }
  }

  async function deleteDeviceBook(book: Book) {
    const deviceBookId = book.deviceBookId ?? book.id;
    if (!window.confirm(`Remove ${book.title} from this device? Your listening progress will be kept.`)) return;
    const removingActiveBook =
      playbackBook?.deviceBookId === deviceBookId || playbackBook?.id === deviceBookId;
    if (removingActiveBook) {
      persistProgress();
    }
    if (removingActiveBook) pausePlayback(audioRef.current);
    await removeDeviceBook(deviceBookId);
    if (removingActiveBook && book.source === "device") clearPlaybackSession();
    await loadBooks();
    setDownloadStatus({ message: "Device copy removed" });
  }

  async function removeOfflineDownload(book: Book) {
    if (!window.confirm(`Remove the downloaded copy of ${book.title} from this device? Your listening progress will be kept.`)) return;
    const removingActiveSource = playbackBook?.id === book.id && !!currentTrack && !!audioRef.current;
    const resumeTrack = removingActiveSource ? currentTrack : null;
    // A seek still queued for this track is the real position; the element
    // reads 0 until its metadata loads, and staging that would replace it.
    const resumePosition = removingActiveSource
      ? Math.max(
          0,
          pendingSeekRef.current?.trackId === currentTrack!.id
            ? pendingSeekRef.current.positionSeconds
            : audioRef.current!.currentTime
        )
      : 0;
    const resumePlayback = removingActiveSource
      ? nativeAudio ? nativePlaybackPlayingRef.current : !audioRef.current!.paused
      : false;
    if (removingActiveSource && resumeTrack) {
      persistProgress();
      pausePlayback(audioRef.current);
      setPendingSeek({ trackId: resumeTrack.id, positionSeconds: resumePosition });
      playWhenTrackLoads.current = resumePlayback;
    }
    await removeBookDownload(book);
    await refreshReadiness(book).catch(() => undefined);
    setDownloadedBookIds((existing) => {
      const next = new Set(existing);
      next.delete(book.id);
      return next;
    });
    if (removingActiveSource && resumeTrack) {
      setOfflineSource({ trackId: resumeTrack.id, url: null });
    }
    setDownloadStatus({ bookId: book.id, message: "Download removed" });
  }

  return {
    online,
    readiness,
    downloadStatus,
    cancelOfflineDownload,
    deleteDeviceBook,
    downloadForOffline,
    importFromDevice,
    retryMissingFiles: (book: Book) => downloadForOffline(book, true),
    removeOfflineDownload
  };
}
