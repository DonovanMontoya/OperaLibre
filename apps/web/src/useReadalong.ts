import { type Dispatch, type SetStateAction, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  generateSyncMap,
  getAlignmentStatus,
  getJob,
  getServerStorageKey,
  getStoredMediaToken,
  getSyncMap,
  listJobs,
  readalongUrl
} from "./api";
import { createAlignmentStatusUpdater, readAlignmentPreference, writeAlignmentPreference } from "./alignmentPreference";
import { syncMapCacheReducer } from "./syncMapCache";
import type { AuthUser, Book, CompanionFile, JobStatus } from "./types";
import { groupCompanions, hasExtras, readAlongMode, readerStorageKey, syncMapPrecision } from "./readalong";
import { getOfflineCompanionUrl, getOfflineSyncMap, releaseOfflineMediaUrl, saveOfflineSyncMap } from "./offline";
import { hasPreciseSync, syncConfirmationMessage } from "./syncGeneration";
import { errorMessage } from "./formatting";
import { Capacitor } from "@capacitor/core";
import { Dialog } from "@capacitor/dialog";
import { createScreenAwakeController } from "./screenAwake";
import { writeReadalongEnabled } from "./readalongPreferences";
import type { ServerCapabilities } from "./serverCapabilities";
import type { NativeTab } from "./nativeTabs";

/** Pseudo companion id for the picture gallery tab. */
export const GALLERY_COMPANION_ID = "__gallery__";

export function useReadalong({
  capabilities,
  currentUser,
  demoMode,
  followSyncEnabled,
  isOperaLibre,
  isViewingPlayingBook,
  loadBooks,
  localMode,
  native,
  nativePlayerView,
  readalongEnabled,
  selectedBook,
  selectedBookId,
  setNativePlayerView,
  setNativeTab,
  setReadalongEnabled,
  setSelectedBookId,
  setSyncConfirmationBook
}: {
  capabilities: ServerCapabilities;
  currentUser: AuthUser;
  demoMode: boolean;
  followSyncEnabled: boolean;
  isOperaLibre: boolean;
  isViewingPlayingBook: boolean;
  loadBooks: () => Promise<void>;
  localMode: boolean;
  native: boolean;
  nativePlayerView: "details" | "now" | "chapters";
  readalongEnabled: boolean;
  selectedBook: Book;
  selectedBookId: string | null;
  setNativePlayerView: Dispatch<SetStateAction<"details" | "now" | "chapters">>;
  setNativeTab: Dispatch<SetStateAction<NativeTab>>;
  setReadalongEnabled: Dispatch<SetStateAction<boolean>>;
  setSelectedBookId: Dispatch<SetStateAction<string | null>>;
  setSyncConfirmationBook: Dispatch<SetStateAction<Book | null>>;
}) {
  const [readalongOpen, setReadalongOpen] = useState(false);
  // The native reader stays up while UIKit brings the tab bar back.
  const [readerClosing, setReaderClosing] = useState(false);
  const [activeCompanionId, setActiveCompanionId] = useState<string | null>(null);
  const readalongPanelRef = useRef<HTMLElement | null>(null);
  const alignmentScope = getServerStorageKey();
  const cachedAlignmentStatus = useMemo(() => readAlignmentPreference(alignmentScope), [alignmentScope]);
  const [alignmentState, setAlignmentState] = useState(() => ({ scope: alignmentScope, status: cachedAlignmentStatus }));
  const alignmentStatus = alignmentState.scope === alignmentScope ? alignmentState.status : cachedAlignmentStatus;
  const alignmentStatusUpdater = useMemo(() => createAlignmentStatusUpdater((status) => {
    writeAlignmentPreference(alignmentScope, status);
    setAlignmentState({ scope: alignmentScope, status });
  }), [alignmentScope]);
  const updateAlignmentStatus = alignmentStatusUpdater.update;
  const sentenceFollowAvailable = capabilities.sentenceAlignment && alignmentStatus?.enabled === true;
  const narrationFollowActive = readalongEnabled && followSyncEnabled && sentenceFollowAvailable;
  const [{ maps: syncMaps, revision: syncMapRevision }, dispatchSyncMap] = useReducer(syncMapCacheReducer, { maps: {}, revision: 0 });
  const [syncJob, setSyncJob] = useState<JobStatus | null>(null);
  const [syncJobError, setSyncJobError] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const selectedCompanionGroups = useMemo(
    () => (selectedBook ? groupCompanions(selectedBook) : { text: [], supplements: [], images: [] }),
    [selectedBook]
  );
  const selectedCompanionList = useMemo(
    () => [...selectedCompanionGroups.text, ...selectedCompanionGroups.supplements],
    [selectedCompanionGroups]
  );
  const galleryAvailable = selectedCompanionGroups.images.length > 0;
  const activeCompanion =
    activeCompanionId === GALLERY_COMPANION_ID
      ? null
      : selectedCompanionList.find((companion) => companion.id === activeCompanionId)
        ?? selectedCompanionList.find((companion) => companion.id === selectedBook?.readingFile?.id)
        ?? selectedCompanionList[0]
        ?? null;
  const showGallery = activeCompanionId === GALLERY_COMPANION_ID || (!activeCompanion && galleryAvailable);
  // The companion URL carries the media token. Until the token is known the
  // URL would change a moment later and the reader would open the EPUB
  // twice, so the reader waits for it.
  const companionUrlReady = native || !isOperaLibre || !!getStoredMediaToken();
  const companionFilesKey = JSON.stringify([...selectedCompanionList, ...selectedCompanionGroups.images].map((file) => [file.id, file.extension]));
  const companionScope = `${getServerStorageKey()}:${currentUser.id}:${selectedBook?.id ?? ""}:${companionFilesKey}`;
  const [localCompanions, setLocalCompanions] = useState<{ scope: string; urls: Record<string, string | null> } | null>(null);
  const activeCompanionUrl = selectedBook?.source === "device"
    ? (localCompanions?.scope === companionScope && activeCompanion ? localCompanions.urls[activeCompanion.id] : null)
    : (activeCompanion && companionUrlReady ? readalongUrl(activeCompanion.url) : null);
  useEffect(() => {
    if (!native || !readalongOpen || !selectedBook) return;
    let cancelled = false;
    const resolved: string[] = [];
    void Promise.all([...selectedCompanionList, ...selectedCompanionGroups.images].map(async (file) => {
      const url = await getOfflineCompanionUrl(selectedBook, file).catch(() => null);
      if (url) resolved.push(url);
      return [file.id, url] as const;
    })).then((entries) => {
      if (cancelled) resolved.forEach(releaseOfflineMediaUrl);
      else setLocalCompanions({ scope: companionScope, urls: Object.fromEntries(entries) });
    });
    return () => {
      cancelled = true;
      resolved.forEach(releaseOfflineMediaUrl);
    };
    // Stable file identities avoid filesystem work on playback progress updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, readalongOpen, companionScope, companionFilesKey]);
  const companionPreviewUrl = (file: CompanionFile) => {
    if (native && localCompanions?.scope !== companionScope) return undefined;
    if (selectedBook?.source === "device") return localCompanions?.urls[file.id] ?? undefined;
    return (localCompanions?.scope === companionScope ? localCompanions.urls[file.id] : null) ?? readalongUrl(file.url);
  };
  const activeCompanionIsBook = !!activeCompanion && activeCompanion.id === selectedBook?.readingFile?.id;
  const selectedSyncMap = selectedBook ? syncMaps[selectedBook.id] ?? null : null;
  // Only a forced alignment drives the marker. A map that is not one — an
  // interpolated map a device cached before those were dropped — is left out
  // entirely, so the reader falls back to chapter sync instead of following
  // timings that do not match the narration.
  const selectedSyncFragments =
    isViewingPlayingBook && selectedSyncMap && syncMapPrecision(selectedSyncMap) === "sentence"
      ? selectedSyncMap.fragments
      : null;
  const selectedReadAlongMode = selectedBook ? readAlongMode(selectedBook, selectedSyncMap, sentenceFollowAvailable) : null;
  const selectedHasExtras = !!selectedBook && hasExtras(selectedBook);
  const readalongAvailable = readalongEnabled && (!!selectedBook?.readingFile || selectedHasExtras);
  // The web now-playing view hides the details block, so while the selected
  // book is the one playing the reader moves into the playback card instead
  // of vanishing the moment Play is pressed.
  // Decided without waiting for the track to resolve: mounting the reader in
  // the hidden details block first and moving it here a moment later would
  // open the EPUB twice.
  const showReaderInNowView =
    !native
    && nativePlayerView === "now"
    && isViewingPlayingBook
    && readalongOpen
    && (!!activeCompanion || showGallery);
  const selectedSyncPrecise = hasPreciseSync(selectedBook);
  const canGenerateSync =
    currentUser.isAdmin &&
    !!alignmentStatus?.enabled &&
    selectedBook?.readingFile?.extension === "epub";
  const readerScope = `${getServerStorageKey()}.${currentUser.id}`;

  const readerOpenedThisSessionRef = useRef<Set<string>>(new Set());

  function writeReaderOpenFlag(bookId: string, open: boolean) {
    try {
      window.localStorage.setItem(readerStorageKey(readerScope, bookId, "open"), open ? "1" : "0");
    } catch {
      // ignore storage failures
    }
  }

  /** Opens the reader for a book and brings it on screen, on every layout. */
  function openReadalong(book: Book, companionId: string | null = null) {
    setSelectedBookId(book.id);
    setActiveCompanionId(companionId);
    setReadalongOpen(true);
    readerOpenedThisSessionRef.current.add(book.id);
    writeReaderOpenFlag(book.id, true);
    if (native) {
      // The native ebook reader covers the whole screen, so whatever is
      // underneath is left alone; closing returns the listener to it. Extras
      // (a PDF, pictures) still open inline on the details page.
      if (!companionId && book.readingFile?.extension === "epub") {
        return;
      }
      setNativeTab("shelf");
      setNativePlayerView("details");
    }
    window.setTimeout(() => {
      readalongPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
  }

  /** Forget a book's loaded sync map so the next look at the reader refetches it. */
  async function startSyncGeneration(book: Book) {
    setSyncJobError(null);
    setSyncNotice(null);
    try {
      const created = await generateSyncMap(book.id);
      setSyncJob({
        id: created.jobId,
        kind: "sync-generate",
        targetId: book.id,
        status: "queued",
        startedAt: "",
        finishedAt: null,
        exitCode: null,
        output: "",
        error: null
      });
    } catch (error) {
      setSyncJobError(errorMessage(error, "Could not start readalong sync generation."));
    }
  }

  async function requestSyncGeneration(book: Book) {
    if (!hasPreciseSync(book)) {
      await startSyncGeneration(book);
      return;
    }
    if (Capacitor.isNativePlatform()) {
      try {
        const { value } = await Dialog.confirm({
          title: "Re-sync this book?",
          message: syncConfirmationMessage(book),
          okButtonTitle: "Start re-sync",
          cancelButtonTitle: "Not now"
        });
        if (value) await startSyncGeneration(book);
      } catch (error) {
        setSyncJobError(errorMessage(error, "Could not open the re-sync confirmation."));
      }
      return;
    }
    setSyncConfirmationBook(book);
  }

  // A book the listener was reading along with reopens its reader when it is
  // selected again; a book with nothing to read closes it.
  const selectedBookIdForReader = selectedBook?.id ?? null;
  const ebookReaderOpen = readalongOpen && activeCompanion?.extension === "epub" && !showGallery;
  useEffect(() => {
    const screenAwake = createScreenAwakeController();
    screenAwake.setReadingActive(ebookReaderOpen);
    return () => screenAwake.dispose();
  }, [ebookReaderOpen]);

  useEffect(() => {
    if (!selectedBookIdForReader || !readalongAvailable) {
      setReadalongOpen(false);
      return;
    }
    setActiveCompanionId(null);
    setSyncNotice(null);
    let remembered = false;
    try {
      remembered =
        window.localStorage.getItem(readerStorageKey(readerScope, selectedBookIdForReader, "open")) === "1";
    } catch {
      remembered = false;
    }
    // On the web the reader pane reopens where it was left. The native reader
    // is a full-screen layer, so it only comes back for a book opened during
    // this run, never over the shelf at launch.
    setReadalongOpen(remembered && (!native || readerOpenedThisSessionRef.current.has(selectedBookIdForReader)));
  }, [native, readalongAvailable, readerScope, selectedBookIdForReader]);

  useEffect(() => {
    if (!isOperaLibre || localMode || demoMode) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void alignmentStatusUpdater.refresh(getAlignmentStatus);
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alignmentStatusUpdater.invalidate();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [currentUser.id, isOperaLibre, localMode, demoMode, alignmentStatusUpdater]);

  const syncMapBook = narrationFollowActive && readalongOpen && selectedBook?.syncFile ? selectedBook : null;
  const syncMapBookId = syncMapBook?.id ?? null;
  useEffect(() => {
    if (!syncMapBookId) {
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const stored = syncMapBook ? await getOfflineSyncMap(syncMapBook) : null;
      if (signal.aborted) return null;
      if (stored) dispatchSyncMap({ type: "loaded", bookId: syncMapBookId, map: stored });
      // Show the downloaded map immediately while checking in the background
      // for an alignment that finished after this book came down.
      return getSyncMap(syncMapBookId, signal);
    })()
      .then((map) => {
        if (signal.aborted) return;
        // Write the newer map back over the downloaded copy, which is
        // otherwise only ever written once, when the book was downloaded.
        if (map && syncMapBook) void saveOfflineSyncMap(syncMapBook, map, signal);
        if (!signal.aborted) {
          dispatchSyncMap({ type: "loaded", bookId: syncMapBookId, map });
        }
      })
      .catch(async () => {
        if (signal.aborted) return;
        // No server in reach: a downloaded book carries its own sync map.
        const stored = syncMapBook ? await getOfflineSyncMap(syncMapBook) : null;
        if (!signal.aborted) {
          dispatchSyncMap({ type: "loaded", bookId: syncMapBookId, map: stored });
        }
      });
    return () => {
      controller.abort();
    };
    // Updating the visible map must not cancel its own background refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncMapBookId, syncMapRevision]);

  // Keyed on the job id and whether it is still pending, not the job object:
  // every poll replaces the object, which would otherwise rebuild the timer
  // on each tick.
  const syncJobId = syncJob?.id ?? null;
  const syncJobPending = !!syncJob && ["queued", "running"].includes(syncJob.status);
  useEffect(() => {
    if (!syncJobId || !syncJobPending) {
      return;
    }
    let cancelled = false;
    // A slow response must not overlap the next tick, or two polls can both
    // see the completion and reload the library twice.
    let requestInFlight = false;
    const timer = window.setInterval(() => {
      if (requestInFlight) return;
      requestInFlight = true;
      void getJob(syncJobId)
        .then((job) => {
          if (cancelled) return;
          setSyncJob(job);
          if (job.status === "completed") {
            dispatchSyncMap({ type: "reset" });
            setSyncNotice("Sync improved: the narration is now aligned sentence by sentence.");
            void loadBooks();
          }
        })
        .catch(() => undefined)
        .finally(() => {
          requestInFlight = false;
        });
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadBooks, syncJobId, syncJobPending]);

  // A sync run outlives the page that started it: it is a server job, and a
  // long book takes far longer than a reload or a walk to another book. Adopt
  // whatever is already running for this book so the progress comes back
  // instead of the reader looking idle.
  const syncJobBookId = syncJob?.targetId ?? null;
  useEffect(() => {
    if (
      !canGenerateSync
      || !readalongOpen
      || !narrationFollowActive
      || !selectedBookId
      || syncJobBookId === selectedBookId
    ) {
      return;
    }
    let cancelled = false;
    void listJobs()
      .then((jobs) => {
        const running = jobs.find(
          (job) =>
            job.kind === "sync-generate"
            && job.targetId === selectedBookId
            && ["queued", "running"].includes(job.status)
        );
        if (running && !cancelled) {
          setSyncJob(running);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canGenerateSync, narrationFollowActive, readalongOpen, selectedBookId, syncJobBookId]);

  function toggleReadalongEnabled() {
    const enabled = !readalongEnabled;
    writeReadalongEnabled(enabled);
    setReadalongEnabled(enabled);
    if (!enabled) {
      setReadalongOpen(false);
      if (selectedBook) writeReaderOpenFlag(selectedBook.id, false);
    }
  }

  return {
    activeCompanion,
    activeCompanionIsBook,
    activeCompanionUrl,
    canGenerateSync,
    companionPreviewUrl,
    galleryAvailable,
    narrationFollowActive,
    openReadalong,
    readalongAvailable,
    readalongOpen,
    readalongPanelRef,
    readerClosing,
    readerScope,
    requestSyncGeneration,
    selectedCompanionGroups,
    selectedCompanionList,
    selectedHasExtras,
    selectedReadAlongMode,
    selectedSyncFragments,
    selectedSyncPrecise,
    sentenceFollowAvailable,
    setActiveCompanionId,
    setReadalongOpen,
    setReaderClosing,
    showGallery,
    showReaderInNowView,
    startSyncGeneration,
    syncJob,
    syncJobError,
    syncNotice,
    toggleReadalongEnabled,
    updateAlignmentStatus,
    writeReaderOpenFlag
  };
}
