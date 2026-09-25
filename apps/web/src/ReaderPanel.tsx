import type { useNativeChrome } from "./useNativeChrome";
import type { useReadalong } from "./useReadalong";
import type { useReaderPreferences } from "./useReaderPreferences";
import type { useSleepTimer } from "./useSleepTimer";
import { BookOpen, ExternalLink, FileText, Images, LoaderCircle, ScrollText, Sparkles, X } from "lucide-react";
import { companionKindLabel, describeCompanion, READ_ALONG_MODE_LABELS } from "./readalong";
import { GALLERY_COMPANION_ID } from "./useReadalong";
import { EpubReadalong } from "./EpubReadalong";
import { chapterAtBookPosition, type ChapterSegment } from "./chapters";
import { getCachedEpubBytes, loadCompanionBytes, loadEpubSource } from "./offline";
import { FOLLOW_AGGRESSIVENESS_LEAD_SECONDS } from "./readalongPreferences";
import { formatTime } from "./formatting";
import type { Book, JobStatus } from "./types";
import type { NativePlayerSheet } from "./PlayerSheets";
import type { ReactNode } from "react";

/** Formats the browser can show inline; anything else gets an "Open" link. */
function canPreviewCompanion(extension: string) {
  const lower = extension.toLowerCase();
  return lower === "epub" || lower === "pdf" || lower === "txt" || lower === "html" || lower === "htm";
}

export function renderReaderSyncActions({
  readalong,
  selectedBook,
  syncJobRunning
}: {
  readalong: ReturnType<typeof useReadalong>;
  selectedBook: Book;
  syncJobRunning: boolean;
}) {
  const {
    activeCompanionIsBook,
    canGenerateSync,
    requestSyncGeneration,
    selectedSyncPrecise
  } = readalong;

  return (
    selectedBook ? (
      <>
        {canGenerateSync && activeCompanionIsBook ? (
          <button
            type="button"
            className="download-btn"
            disabled={syncJobRunning}
            onClick={() => void requestSyncGeneration(selectedBook)}
            title={
              selectedSyncPrecise
                ? "Regenerate the narration sync map"
                : "Align the narration to the text for sentence-exact highlighting"
            }
          >
            {syncJobRunning ? (
              <LoaderCircle size={13} className="spin-icon" />
            ) : (
              <Sparkles size={13} />
            )}
            <span>{selectedSyncPrecise ? "Re-sync" : "Improve sync"}</span>
          </button>
        ) : null}
      </>
    ) : null
  );
}

export function renderReaderSyncMessages({
  readalong,
  syncJobForBook,
  syncJobRunning,
  syncProgressNote,
  syncProgressPercent
}: {
  readalong: ReturnType<typeof useReadalong>;
  syncJobForBook: JobStatus | null;
  syncJobRunning: boolean;
  syncProgressNote: string;
  syncProgressPercent: number | null;
}) {
  const {
    activeCompanionIsBook,
    canGenerateSync,
    selectedSyncPrecise,
    syncJobError,
    syncNotice
  } = readalong;

  return (
    <>
      {canGenerateSync && activeCompanionIsBook && !syncJobRunning ? (
        <p className="readalong-synchint">
          {selectedSyncPrecise
            ? "This book is aligned sentence by sentence against its narration. Re-sync rebuilds that map from the audio and the text — worth doing when either file has been replaced."
            : "This book has no alignment yet, so the reader only opens to the chapter being played. Improve sync listens to the narration on the server and matches it to the text sentence by sentence, so the highlight lands on the sentence being read. It runs in the background for everyone on this server and can take a long while on a full-length book."}
        </p>
      ) : null}
      {syncJobForBook && syncJobRunning ? (
        <div className="sync-progress" role="status" aria-live="polite">
          <div className="sync-progress-head">
            <span className="sync-progress-step">
              {syncJobForBook.status === "queued"
                ? "Waiting for another sync to finish"
                : syncJobForBook.progress?.step ?? "Aligning the narration to the text"}
            </span>
            {syncProgressPercent !== null ? (
              <span className="sync-progress-percent">{syncProgressPercent}%</span>
            ) : null}
          </div>
          <div
            className="sync-progress-track"
            role="progressbar"
            aria-label="Sync generation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={syncProgressPercent ?? undefined}
            aria-valuetext={
              syncProgressPercent === null
                ? "Starting"
                : `${syncProgressPercent}% aligned`
            }
          >
            {/* Nothing to measure yet: a sliding bar says "working" without
                claiming a position the job has not reported. */}
            <div
              className={syncProgressPercent === null ? "sync-progress-fill waiting" : "sync-progress-fill"}
              style={syncProgressPercent === null ? undefined : { width: `${syncProgressPercent}%` }}
            />
          </div>
          <div className="sync-progress-note">{syncProgressNote}</div>
        </div>
      ) : syncJobForBook && syncJobForBook.status === "failed" ? (
        <div className="readalong-genstatus error">
          {syncJobForBook.error ?? "Readalong sync generation failed."}
        </div>
      ) : null}
      {syncJobError ? <div className="readalong-genstatus error">{syncJobError}</div> : null}
      {syncNotice ? <div className="readalong-genstatus notice">{syncNotice}</div> : null}

    </>
  );
}

export function renderCompanionTabs({
  readalong
}: {
  readalong: ReturnType<typeof useReadalong>;
}) {
  const {
    activeCompanion,
    galleryAvailable,
    selectedCompanionGroups,
    selectedCompanionList,
    setActiveCompanionId,
    showGallery
  } = readalong;

  return (
    selectedCompanionList.length + (galleryAvailable ? 1 : 0) > 1 ? (
      <div className="readalong-tabs" role="tablist" aria-label="Companion files">
        {selectedCompanionList.map((companion) => {
          const selected = !showGallery && activeCompanion?.id === companion.id;
          return (
            <button
              type="button"
              role="tab"
              key={companion.id}
              aria-selected={selected}
              className={selected ? "selected" : ""}
              onClick={() => setActiveCompanionId(companion.id)}
              title={describeCompanion(companion)}
            >
              {companion.kind === "book" ? <BookOpen size={12} /> : <FileText size={12} />}
              <span>{companionKindLabel(companion)}</span>
              <small>{companion.fileName}</small>
            </button>
          );
        })}
        {galleryAvailable ? (
          <button
            type="button"
            role="tab"
            aria-selected={showGallery}
            className={showGallery ? "selected" : ""}
            onClick={() => setActiveCompanionId(GALLERY_COMPANION_ID)}
          >
            <Images size={12} />
            <span>Pictures</span>
            <small>{selectedCompanionGroups.images.length}</small>
          </button>
        ) : null}
      </div>
    ) : null
  );
}

export function renderEpubReader({
  activeChapter,
  bookPosition,
  closeReadalong,
  companionTabs,
  displayBookPosition,
  isPlaying,
  isViewingPlayingBook,
  native,
  openNativePlayerSheet,
  playSelectedBook,
  readalong,
  readerPreferences,
  readerSyncActions,
  readerSyncMessages,
  seekBookPositionInBook,
  seekBy,
  selectedBook,
  selectedChapterSegments,
  sleepTimer,
  speed,
  togglePlayback
}: {
  activeChapter: ChapterSegment | null;
  bookPosition: number;
  closeReadalong: () => void;
  companionTabs: ReactNode;
  displayBookPosition: number;
  isPlaying: boolean;
  isViewingPlayingBook: boolean;
  native: boolean;
  openNativePlayerSheet: (sheet: Exclude<NativePlayerSheet, null>) => void;
  playSelectedBook: (book: Book) => Promise<void>;
  readalong: ReturnType<typeof useReadalong>;
  readerPreferences: ReturnType<typeof useReaderPreferences>;
  readerSyncActions: ReactNode;
  readerSyncMessages: ReactNode;
  seekBookPositionInBook: (book: Book, value: number, autoPlay?: boolean) => void;
  seekBy: (delta: number) => void;
  selectedBook: Book;
  selectedChapterSegments: ChapterSegment[];
  sleepTimer: ReturnType<typeof useSleepTimer>;
  speed: number;
  togglePlayback: () => void;
}) {
  const {
    activeCompanion,
    activeCompanionIsBook,
    activeCompanionUrl,
    narrationFollowActive,
    readerScope,
    selectedSyncFragments,
    showGallery
  } = readalong;
  const {
    followAggressiveness,
    readalongEnabled
  } = readerPreferences;
  const {
    sleepRemaining
  } = sleepTimer;

  return (
    selectedBook && activeCompanion && activeCompanionUrl && activeCompanion.extension === "epub" && !showGallery ? (
      <EpubReadalong
        key={`${readerScope}:${selectedBook.id}:${activeCompanion.id}`}
        bookId={selectedBook.id}
        storageScope={readerScope}
        title={selectedBook.title}
        url={activeCompanionUrl}
        listeningChapter={activeCompanionIsBook
          ? (isViewingPlayingBook ? activeChapter?.title : chapterAtBookPosition(selectedChapterSegments, selectedBook.progress?.bookPositionSeconds ?? 0)?.title) ?? null
          : null}
        loadSource={(companionUrl, signal) =>
          loadEpubSource(selectedBook, activeCompanion, companionUrl, signal)
        }
        loadCachedSource={(signal) => getCachedEpubBytes(selectedBook, activeCompanion, signal)}
        loadWholeFile={(companionUrl, signal) =>
          loadCompanionBytes(selectedBook, activeCompanion, companionUrl, signal)
        }
        syncTarget={
          readalongEnabled && activeCompanionIsBook && !(narrationFollowActive && selectedSyncFragments) && isViewingPlayingBook && activeChapter
            ? activeChapter
            : null
        }
        syncFragments={narrationFollowActive && activeCompanionIsBook ? selectedSyncFragments : null}
        audioChapters={selectedBook.chapters}
        positionSeconds={narrationFollowActive && isViewingPlayingBook ? bookPosition : 0}
        followLeadSeconds={FOLLOW_AGGRESSIVENESS_LEAD_SECONDS[followAggressiveness]}
        onSeekTo={
          narrationFollowActive
            ? (seconds) => seekBookPositionInBook(selectedBook, seconds, true)
            : undefined
        }
        immersive={native}
        onClose={closeReadalong}
        chapterTitle={isViewingPlayingBook ? activeChapter?.title ?? null : null}
        positionLabel={
          isViewingPlayingBook
            ? formatTime(activeChapter ? Math.max(0, displayBookPosition - activeChapter.startSeconds) : displayBookPosition)
            : null
        }
        playback={
          isViewingPlayingBook
            ? {
                playing: isPlaying,
                speed,
                sleepRemaining,
                onToggle: togglePlayback,
                onSkip: seekBy,
                onOpen: openNativePlayerSheet
              }
            : null
        }
        onListen={isViewingPlayingBook ? undefined : () => playSelectedBook(selectedBook)}
        syncTools={
          narrationFollowActive && (readerSyncActions || readerSyncMessages) ? (
            <>
              <div className="epub-sheet-row">{readerSyncActions}</div>
              {readerSyncMessages}
            </>
          ) : null
        }
        companionSwitcher={companionTabs}
      />
    ) : null
  );
}

export function renderReadalongPanel({
  activeChapter,
  closeReadalong,
  companionTabs,
  displayBookPosition,
  epubReaderElement,
  immersiveEpub,
  nativeChrome,
  readalong,
  readerSyncActions,
  readerSyncMessages,
  selectedBook
}: {
  activeChapter: ChapterSegment | null;
  closeReadalong: () => void;
  companionTabs: ReactNode;
  displayBookPosition: number;
  epubReaderElement: ReactNode;
  immersiveEpub: boolean;
  nativeChrome: ReturnType<typeof useNativeChrome>;
  readalong: ReturnType<typeof useReadalong>;
  readerSyncActions: ReactNode;
  readerSyncMessages: ReactNode;
  selectedBook: Book;
}) {
  const {
    activeCompanion,
    activeCompanionIsBook,
    activeCompanionUrl,
    companionPreviewUrl,
    narrationFollowActive,
    readalongOpen,
    readalongPanelRef,
    selectedCompanionGroups,
    selectedReadAlongMode,
    showGallery
  } = readalong;
  const {
    nativeTabsReady,
    nativeTabsShown
  } = nativeChrome;

  return (
    readalongOpen && selectedBook && (activeCompanion || showGallery) ? immersiveEpub ? (
      // Mount once UIKit has removed the tab bar, so the book lays out a
      // single time at full screen instead of again as the web view grows.
      nativeTabsReady && nativeTabsShown ? null : epubReaderElement
    ) : (
      <section
        className="readalong-panel"
        aria-label={`${selectedBook.title} read along`}
        ref={readalongPanelRef}
      >
        <div className="readalong-header">
          <div>
            <span className="section-label">
              {showGallery ? <Images size={13} /> : <BookOpen size={13} />}{" "}
              {showGallery ? "Pictures" : activeCompanion?.kind === "supplement" ? "Extras" : "Read along"}
            </span>
            <strong>
              {showGallery
                ? `${selectedCompanionGroups.images.length} ${selectedCompanionGroups.images.length === 1 ? "picture" : "pictures"}`
                : activeCompanion?.fileName}
            </strong>
            <span className="readalong-mode">
              {showGallery
                ? "Loose pictures found beside the audio"
                : activeCompanion
                  ? `${activeCompanionIsBook && selectedReadAlongMode ? `${READ_ALONG_MODE_LABELS[selectedReadAlongMode].title} · ` : ""}${describeCompanion(activeCompanion)}`
                  : null}
            </span>
          </div>
          <div className="readalong-actions">
            {narrationFollowActive ? readerSyncActions : null}
            {activeCompanionUrl && !showGallery ? (
              <a className="download-btn" href={activeCompanion ? companionPreviewUrl(activeCompanion) : undefined} target="_blank" rel="noreferrer">
                <ExternalLink size={13} />
                <span>Open</span>
              </a>
            ) : null}
            <button type="button" className="download-btn" onClick={closeReadalong} aria-label="Close the reader">
              <X size={13} />
              <span>Close</span>
            </button>
          </div>
        </div>
        {companionTabs}
        {narrationFollowActive ? readerSyncMessages : null}
        {showGallery ? (
          <div className="readalong-gallery">
            {selectedCompanionGroups.images.map((image) => (
              <a key={image.id} href={companionPreviewUrl(image)} target="_blank" rel="noreferrer">
                <img src={companionPreviewUrl(image)} alt={image.fileName} loading="lazy" />
                <span>{image.fileName}</span>
              </a>
            ))}
          </div>
        ) : epubReaderElement ? (
          epubReaderElement
        ) : activeCompanion && activeCompanionUrl && canPreviewCompanion(activeCompanion.extension) ? (
          <iframe
            className="readalong-frame"
            src={companionPreviewUrl(activeCompanion)}
            title={`${selectedBook.title} ${activeCompanion.kind === "supplement" ? "extras" : "readalong"}`}
            sandbox=""
            referrerPolicy="no-referrer"
          />
        ) : activeCompanion ? (
          <div className="readalong-fallback">
            <ScrollText size={36} strokeWidth={1.4} />
            <p>
              {activeCompanion.extension.toUpperCase()} files are available to open, but this browser
              cannot preview them inline yet.
            </p>
          </div>
        ) : null}
        {activeChapter && !showGallery ? (
          <div className="readalong-sync">
            <span>{activeChapter.title}</span>
            <span>{formatTime(displayBookPosition)}</span>
          </div>
        ) : null}
      </section>
    ) : null
  );
}
