import type { useBookCompletion } from "./useBookCompletion";
import type { useMetadataEditor } from "./useMetadataEditor";
import type { useOfflineDownloads } from "./useOfflineDownloads";
import type { useReadalong } from "./useReadalong";
import type { useReaderPreferences } from "./useReaderPreferences";
import type { useSleepTimer } from "./useSleepTimer";
import type { useUploads } from "./useUploads";
import { type DeviceFoldState, usesFoldLayout } from "./deviceFold";
import {
  ArrowUp,
  Bookmark,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Download,
  FolderOpen,
  Gauge,
  Headphones,
  Images,
  Library,
  ListMusic,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  RotateCw,
  ScrollText,
  SkipBack,
  SkipForward,
  Timer,
  Users,
  Volume2,
  X
} from "lucide-react";
import { CoverArt, DownloadRing } from "./CoverArt";
import { PlaybackSpeedControl, ScrubSlider } from "./PlaybackControls";
import { durationFromTracks, formatDurationLabel, formatTime } from "./formatting";
import { haptic } from "./native";
import { Capacitor } from "@capacitor/core";
import { bookDownloadUrl, mediaUrl } from "./api";
import { tagsForBook } from "./bookMetadata";
import { readerStatusLabel } from "./sharedProgress";
import { READ_ALONG_MODE_LABELS } from "./readalong";
import { formatSleepTimerMinutes, SLEEP_TIMER_MAX_MINUTES, SLEEP_TIMER_MIN_MINUTES } from "./sleepTimer";
import type { ChapterSegment } from "./chapters";
import type { Book, Chapter, SharedProgress, Track } from "./types";
import type { DeviceNotice } from "./ConfirmDialogs";
import type { NativeTab } from "./nativeTabs";
import type { NativePlayerSheet } from "./PlayerSheets";
import type { DeviceDownloadActivity } from "./SettingsCards";
import type { Dispatch, ReactNode, RefObject, SetStateAction, TouchEvent, UIEvent } from "react";
import type { ServerCapabilities } from "./serverCapabilities";

// Beyond this the segments are too thin to read or tap, and their fixed
// borders/gaps overflow a phone screen; fall back to one continuous bar.
const MAX_CHAPTER_SEGMENTS = 32;

export function PlayerPane({
  activeChapter,
  activeTrackIndex,
  beginBookDetailsBackSwipe,
  bookCompletion,
  bookCompletionPercent,
  bookDetailsSwipeStartRef,
  bookDuration,
  bookPosition,
  books,
  capabilities,
  chapterDuration,
  chapterElapsed,
  chapterSegments,
  chaptersListRef,
  chaptersOpen,
  closeReadalong,
  completionError,
  completionPendingBookId,
  currentTrack,
  demoMode,
  descriptionCanExpand,
  descriptionExpanded,
  displayBookRemainingSeconds,
  downloadStatus,
  downloadedBookIds,
  finishBookDetailsBackSwipe,
  handlePlayerPaneScroll,
  hasNextChapter,
  hasPreviousChapter,
  isOperaLibre,
  isPlaying,
  isViewingPlayingBook,
  jumpToChapter,
  jumpToChapterFromSheet,
  jumpToPlayerTop,
  localMode,
  metadataEditor,
  native,
  nativePlayerView,
  nativeTab,
  nextChapter,
  nowPlayingBook,
  offlineDownloads,
  openNativePlayerSheet,
  openPlaybackView,
  playPending,
  playSelectedBook,
  playbackBook,
  playbackDescription,
  playbackError,
  playbackFold,
  playerPaneRef,
  position,
  readalong,
  readalongPanelElement,
  readerPreferences,
  restartOrPreviousChapter,
  returnToLibrary,
  scrollToPlayer,
  scrubbedElapsed,
  seekBookPosition,
  seekBy,
  seekTo,
  selectedBook,
  selectedChapterSegments,
  selectedDescription,
  selectedDownload,
  selectedSharedReaders,
  setChaptersOpen,
  setDescriptionExpanded,
  setLibraryOpen,
  setScrubPreview,
  setSelectedBookId,
  setShowChapterJumpTop,
  setVolume,
  showChapterJumpTop,
  sleepTimer,
  sliderMax,
  speed,
  togglePlayback,
  trackListSectionRef,
  upcomingChapters,
  updateSpeed,
  uploads,
  volume,
  withWebViewTransition
}: {
  activeChapter: ChapterSegment | null;
  activeTrackIndex: number;
  beginBookDetailsBackSwipe: (event: TouchEvent<HTMLElement>) => void;
  bookCompletion: ReturnType<typeof useBookCompletion>;
  bookCompletionPercent: number | null;
  bookDetailsSwipeStartRef: RefObject<{ clientX: number; clientY: number; } | null>;
  bookDuration: number;
  bookPosition: number;
  books: Book[];
  capabilities: ServerCapabilities;
  chapterDuration: number;
  chapterElapsed: number;
  chapterSegments: ChapterSegment[];
  chaptersListRef: RefObject<HTMLDivElement | null>;
  chaptersOpen: boolean;
  closeReadalong: () => void;
  completionError: DeviceNotice | null;
  completionPendingBookId: string | null;
  currentTrack: Track | null;
  demoMode: boolean;
  descriptionCanExpand: boolean;
  descriptionExpanded: boolean;
  displayBookRemainingSeconds: number | null;
  downloadStatus: DeviceNotice | null;
  downloadedBookIds: Set<string>;
  finishBookDetailsBackSwipe: (event: TouchEvent<HTMLElement>) => void;
  handlePlayerPaneScroll: (event: UIEvent<HTMLElement>) => void;
  hasNextChapter: boolean;
  hasPreviousChapter: boolean;
  isOperaLibre: boolean;
  isPlaying: boolean;
  isViewingPlayingBook: boolean;
  jumpToChapter: (chapter: Chapter) => void;
  jumpToChapterFromSheet: (chapter: Chapter) => void;
  jumpToPlayerTop: () => void;
  localMode: boolean;
  metadataEditor: ReturnType<typeof useMetadataEditor>;
  native: boolean;
  nativePlayerView: "now" | "details" | "chapters";
  nativeTab: NativeTab;
  nextChapter: () => void;
  nowPlayingBook: Book | null;
  offlineDownloads: ReturnType<typeof useOfflineDownloads>;
  openNativePlayerSheet: (sheet: Exclude<NativePlayerSheet, null>) => void;
  openPlaybackView: (view: "now" | "details" | "chapters") => void;
  playPending: boolean;
  playSelectedBook: (book: Book) => Promise<void>;
  playbackBook: Book | null;
  playbackDescription: string | null;
  playbackError: string | null;
  playbackFold: DeviceFoldState;
  playerPaneRef: RefObject<HTMLElement | null>;
  position: number;
  readalong: ReturnType<typeof useReadalong>;
  readalongPanelElement: ReactNode;
  readerPreferences: ReturnType<typeof useReaderPreferences>;
  restartOrPreviousChapter: () => void;
  returnToLibrary: () => void;
  scrollToPlayer: () => void;
  scrubbedElapsed: number;
  seekBookPosition: (value: number, autoPlay?: boolean) => void;
  seekBy: (delta: number) => void;
  seekTo: (value: number) => void;
  selectedBook: Book;
  selectedChapterSegments: ChapterSegment[];
  selectedDescription: string | null;
  selectedDownload: DeviceDownloadActivity | undefined;
  selectedSharedReaders: SharedProgress[];
  setChaptersOpen: Dispatch<SetStateAction<boolean>>;
  setDescriptionExpanded: Dispatch<SetStateAction<boolean>>;
  setLibraryOpen: Dispatch<SetStateAction<boolean>>;
  setScrubPreview: Dispatch<SetStateAction<number | null>>;
  setSelectedBookId: Dispatch<SetStateAction<string | null>>;
  setShowChapterJumpTop: Dispatch<SetStateAction<boolean>>;
  setVolume: Dispatch<SetStateAction<number>>;
  showChapterJumpTop: boolean;
  sleepTimer: ReturnType<typeof useSleepTimer>;
  sliderMax: number;
  speed: number;
  togglePlayback: () => void;
  trackListSectionRef: RefObject<HTMLElement | null>;
  upcomingChapters: ChapterSegment[];
  updateSpeed: (value: number) => void;
  uploads: ReturnType<typeof useUploads>;
  volume: number;
  withWebViewTransition: (update: () => void) => void;
}) {
  const {
    cancelOfflineDownload,
    downloadForOffline,
    removeOfflineDownload
  } = offlineDownloads;
  const {
    changeBookCompletion,
    markBookUnplayed
  } = bookCompletion;
  const {
    configureSleepTimer,
    setSleepCustomDraft,
    setSleepCustomOpen,
    sleepChoices,
    sleepCustomDraft,
    sleepCustomMinutes,
    sleepCustomOpen,
    sleepMinutes,
    sleepRemaining,
    startCustomSleepTimer
  } = sleepTimer;
  const {
    openMetadataEditor
  } = metadataEditor;
  const {
    openReadalong,
    readalongAvailable,
    readalongOpen,
    selectedCompanionGroups,
    selectedHasExtras,
    selectedReadAlongMode,
    showReaderInNowView
  } = readalong;
  const {
    readalongEnabled
  } = readerPreferences;
  const {
    setEbookUploadBook,
    setEbookUploadError,
    setEbookUploadFile
  } = uploads;

  return (
    <section
      className={`player-pane native-player-view-${nativePlayerView} ${
        isViewingPlayingBook && currentTrack ? "has-native-player" : ""
      } ${showReaderInNowView ? "has-reader" : ""} ${
        nativeTab === "reading" && usesFoldLayout(playbackFold) && playbackFold.fold?.axis === "horizontal"
          ? "" : "fit-playback"
      }`}
      ref={playerPaneRef}
      onScroll={handlePlayerPaneScroll}
      onTouchStart={beginBookDetailsBackSwipe}
      onTouchEnd={finishBookDetailsBackSwipe}
      onTouchCancel={() => { bookDetailsSwipeStartRef.current = null; }}
    >
      <button
        type="button"
        className="library-open-btn"
        aria-label="Open library"
        onClick={() => setLibraryOpen(true)}
      >
        <Library size={16} />
        <span>Library</span>
      </button>
      {/* The details view stands on its own: every block that needs a live
          track is already gated on `isViewingPlayingBook`, so a book opened
          from the shelf with nothing playing renders its preview + "Begin
          this reading" instead of falling through to the empty player. The
          empty player stays for the "now" view, which has nothing to show
          until playback starts. */}
      {selectedBook && (currentTrack || nativePlayerView !== "now") ? (
        <>
          {isViewingPlayingBook && nativePlayerView === "now" && nowPlayingBook && currentTrack ? (
            <section className={`native-now-playing ${showReaderInNowView ? "has-reader" : ""}`} aria-label="Now playing">
              {/* The halves group the stack for a foldable phone, which sets
                  them either side of its fold. Everywhere else they take no
                  box and their children lay out in the card's grid. */}
              <div className="native-now-half native-now-lead">
                <div className="native-now-artwork">
                  <CoverArt book={nowPlayingBook} size="large" />
                </div>

                <div className="native-now-copy">
                  <span className="native-now-kicker">
                    {activeChapter ? `Chapter ${activeChapter.chapterNumber}` : "Now playing"}
                  </span>
                  <h2>{activeChapter?.title ?? currentTrack.title}</h2>
                  <p>{nowPlayingBook.title}</p>
                  <span>{nowPlayingBook.author ?? currentTrack.metadata.album ?? "Audiobook"}</span>
                </div>
              </div>

              <div className="native-now-half native-now-controls">
                <div className="native-now-timeline">
                  <ScrubSlider
                    ariaLabel={activeChapter ? `Playback position in ${activeChapter.title}` : "Playback position"}
                    max={activeChapter ? chapterDuration : Math.max(1, sliderMax)}
                    value={activeChapter ? Math.min(chapterElapsed, chapterDuration) : Math.min(position, Math.max(1, sliderMax))}
                    onPreview={setScrubPreview}
                    onCommit={(value) => {
                      if (activeChapter) {
                        seekBookPosition(activeChapter.startSeconds + value);
                      } else {
                        seekTo(value);
                      }
                    }}
                  />
                  <div className="native-now-time-row">
                    <span>{formatTime(scrubbedElapsed)}</span>
                    <span>
                      {activeChapter
                        ? `−${formatTime(Math.max(0, chapterDuration - scrubbedElapsed))}`
                        : `−${formatTime(Math.max(0, sliderMax - scrubbedElapsed))}`}
                    </span>
                  </div>
                  {displayBookRemainingSeconds !== null && bookCompletionPercent !== null ? (
                    <div
                      className="book-time-row"
                      aria-label={`${formatTime(displayBookRemainingSeconds)} remaining in the book, ${bookCompletionPercent}% complete`}
                    >
                      <span>{formatTime(displayBookRemainingSeconds)} left in book</span>
                      <span>{bookCompletionPercent}% complete</span>
                    </div>
                  ) : null}
                </div>

                <div className="native-now-transport">
                  {activeChapter ? (
                    <button
                      type="button"
                      className="native-now-chapter"
                      aria-label={chapterElapsed > 5 ? "Restart chapter" : "Previous chapter"}
                      onClick={restartOrPreviousChapter}
                      disabled={chapterElapsed <= 5 && !hasPreviousChapter}
                    >
                      <SkipBack size={27} strokeWidth={1.65} />
                      <span>{chapterElapsed > 5 ? "Restart" : "Previous"}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="native-now-seek"
                    aria-label="Rewind 15 seconds"
                    onClick={() => seekBy(-15)}
                  >
                    <RotateCcw size={24} strokeWidth={1.7} />
                    <span>15s</span>
                  </button>
                  <button
                    type="button"
                    className={`native-now-play${playPending ? " play-pending" : ""}`}
                    aria-label={playPending ? "Cancel play" : isPlaying ? "Pause" : "Play"}
                    aria-busy={playPending}
                    onClick={togglePlayback}
                  >
                    {isPlaying || playPending ? <Pause size={39} fill="currentColor" /> : <Play size={39} fill="currentColor" />}
                    {playPending ? <span className="play-pending-ring" aria-hidden="true" /> : null}
                  </button>
                  <button
                    type="button"
                    className="native-now-seek"
                    aria-label="Forward 30 seconds"
                    onClick={() => seekBy(30)}
                  >
                    <RotateCw size={24} strokeWidth={1.7} />
                    <span>30s</span>
                  </button>
                  {activeChapter ? (
                    <button
                      type="button"
                      className="native-now-chapter"
                      aria-label="Next chapter"
                      onClick={nextChapter}
                      disabled={!hasNextChapter}
                    >
                      <SkipForward size={27} strokeWidth={1.65} />
                      <span>Next</span>
                    </button>
                  ) : null}
                </div>

                <div className="native-now-utility">
                  <button
                    type="button"
                    onClick={() => openNativePlayerSheet("speed")}
                  >
                    <Gauge size={16} /> {speed}×
                  </button>
                  <button type="button" onClick={() => {
                    setSleepCustomOpen(false);
                    setSleepCustomDraft("");
                    openNativePlayerSheet("sleep");
                  }}>
                    <Timer size={16} /> {sleepRemaining > 0 ? `${Math.ceil(sleepRemaining / 60)}m left` : "Sleep timer"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (playbackBook) setSelectedBookId(playbackBook.id);
                      openNativePlayerSheet("details");
                    }}
                  >
                    <Bookmark size={16} /> Details
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (playbackBook) setSelectedBookId(playbackBook.id);
                      openNativePlayerSheet("chapters");
                    }}
                  >
                    <ListMusic size={16} /> Chapters
                  </button>
                  {readalongEnabled && playbackBook?.readingFile ? (
                    <button
                      type="button"
                      className="native-now-read"
                      onClick={() => {
                        haptic("light");
                        openReadalong(playbackBook);
                      }}
                    >
                      <BookOpen size={16} /> Read along
                    </button>
                  ) : null}
                </div>
              </div>

              {!native ? (
                <div className="web-now-extras">
                  <section className="web-now-panel web-now-about" aria-labelledby="web-now-about-title">
                    <header className="web-now-panel-head">
                      <div>
                        <span className="web-now-panel-kicker"><ScrollText size={13} /> Edition</span>
                        <h3 id="web-now-about-title">About this book</h3>
                      </div>
                      <button type="button" onClick={() => openNativePlayerSheet("details")}>View details</button>
                    </header>
                    <p>
                      {playbackDescription
                        ?? `${nowPlayingBook.title}${nowPlayingBook.author ? ` by ${nowPlayingBook.author}` : ""}${nowPlayingBook.narrator ? `, narrated by ${nowPlayingBook.narrator}` : ""}.`}
                    </p>
                    <div className="web-now-tags" aria-label="Book metadata">
                      {nowPlayingBook.publishedDate ? <span>{nowPlayingBook.publishedDate}</span> : null}
                      {nowPlayingBook.metadata.publisher ? <span>{nowPlayingBook.metadata.publisher}</span> : null}
                      {nowPlayingBook.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
                    </div>
                  </section>

                  <section className="web-now-panel web-now-session" aria-labelledby="web-now-session-title">
                    <header className="web-now-panel-head">
                      <div>
                        <span className="web-now-panel-kicker"><Headphones size={13} /> Session</span>
                        <h3 id="web-now-session-title">Listening progress</h3>
                      </div>
                      <strong>{bookCompletionPercent ?? 0}%</strong>
                    </header>
                    <div className="web-now-progressbar" role="img" aria-label={`${bookCompletionPercent ?? 0}% complete`}>
                      <span style={{ width: `${bookCompletionPercent ?? 0}%` }} />
                    </div>
                    <dl className="web-now-facts">
                      <div>
                        <dt>Remaining</dt>
                        <dd>{displayBookRemainingSeconds !== null ? formatDurationLabel(displayBookRemainingSeconds) ?? formatTime(displayBookRemainingSeconds) : "—"}</dd>
                      </div>
                      <div>
                        <dt>Runtime</dt>
                        <dd>{formatDurationLabel(bookDuration) ?? formatTime(bookDuration)}</dd>
                      </div>
                      <div>
                        <dt>Chapter</dt>
                        <dd>{activeChapter ? `${activeChapter.chapterNumber} of ${chapterSegments.length}` : "—"}</dd>
                      </div>
                    </dl>
                    <label className="web-now-volume" htmlFor="web-now-volume">
                      <span><Volume2 size={13} /> Volume</span>
                      <input
                        id="web-now-volume"
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={volume}
                        onChange={(event) => setVolume(Number(event.currentTarget.value))}
                      />
                      <strong>{Math.round(volume * 100)}%</strong>
                    </label>
                  </section>

                  <section className="web-now-panel web-now-up-next" aria-labelledby="web-now-up-next-title">
                    <header className="web-now-panel-head">
                      <div>
                        <span className="web-now-panel-kicker"><ListMusic size={13} /> Contents</span>
                        <h3 id="web-now-up-next-title">Up next</h3>
                      </div>
                      <button type="button" onClick={() => openNativePlayerSheet("chapters")}>All chapters</button>
                    </header>
                    {upcomingChapters.length > 0 ? (
                      <div className="web-now-chapter-list">
                        {upcomingChapters.map((chapter) => (
                          <button type="button" key={chapter.id} onClick={() => jumpToChapterFromSheet(chapter)}>
                            <span>{String(chapter.chapterNumber).padStart(2, "0")}</span>
                            <strong>{chapter.title}</strong>
                            <em>{formatTime(chapter.durationSeconds)}</em>
                            <ChevronRight size={15} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="web-now-end-copy">You’re in the final chapter of this book.</p>
                    )}
                  </section>
                </div>
              ) : null}
              {showReaderInNowView ? <div className="web-now-reader">{readalongPanelElement}</div> : null}
            </section>
          ) : null}
          {/* On the shelf tab the details page is a child page of the library
              list, so it always needs its own way back — even with nothing
              playing. "Back to Now Playing" still requires a playing book. */}
          {nativePlayerView !== "now" && (playbackBook || (native && nativeTab === "shelf")) ? (
            <button
              type="button"
              className="native-player-return"
              onClick={() => {
                if (native && nativeTab === "shelf") {
                  returnToLibrary();
                  return;
                }
                haptic("light");
                withWebViewTransition(() => openPlaybackView("now"));
              }}
            >
              {native && nativeTab === "shelf" ? (
                <><span className="native-player-return-icon"><ChevronLeft size={21} /></span><span>Back to Library</span></>
              ) : (
                <><span className="native-player-return-icon"><ChevronLeft size={21} /></span><span>Back to Now Playing</span></>
              )}
            </button>
          ) : null}
          <div className="folio">
            <span>Vol. I <span className="dot">·</span> The Reading Room</span>
            <span>Folio {String(activeTrackIndex + 1).padStart(3, "0")} / {String(selectedBook.tracks.length).padStart(3, "0")}</span>
          </div>

          <div className="book-heading">
            <CoverArt book={selectedBook} size="large" />
            <div className="meta">
              <div className="heading-top">
                <span className="eyebrow">
                  <Bookmark size={13} /> {isViewingPlayingBook ? "Now Reading" : "Book Details"}
                </span>
                <div className="heading-actions">
                  {capabilities.metadataEditing && selectedBook.source !== "device" ? (
                    <button
                      className="download-btn"
                      type="button"
                      onClick={() => {
                        haptic("light");
                        openMetadataEditor(selectedBook);
                      }}
                      aria-label={`Edit info for ${selectedBook.title}`}
                    >
                      <Pencil size={13} />
                      <span>Edit Info</span>
                    </button>
                  ) : null}
                  {capabilities.uploads && selectedBook.readingFile?.extension !== "epub" && selectedBook.source !== "device" ? (
                    <button
                      className="download-btn"
                      type="button"
                      onClick={() => {
                        haptic("light");
                        setEbookUploadBook(selectedBook);
                        setEbookUploadFile(null);
                        setEbookUploadError(null);
                      }}
                      aria-label={`Upload matching ebook for ${selectedBook.title}`}
                    >
                      <BookOpen size={13} />
                      <span>Add EPUB</span>
                    </button>
                  ) : null}
                  <button
                    className={`download-btn ${
                      selectedBook.progress?.status === "finished" ? "active" : ""
                    }`}
                    type="button"
                    onClick={() => {
                      haptic("light");
                      void changeBookCompletion(
                        selectedBook,
                        selectedBook.progress?.status !== "finished"
                      );
                    }}
                    disabled={completionPendingBookId === selectedBook.id}
                    aria-pressed={selectedBook.progress?.status === "finished"}
                    aria-label={
                      selectedBook.progress?.status === "finished"
                        ? `Mark ${selectedBook.title} unfinished`
                        : `Mark ${selectedBook.title} finished`
                    }
                  >
                    {completionPendingBookId === selectedBook.id ? (
                      <LoaderCircle size={13} className="spin-icon" />
                    ) : (
                      <CircleCheck size={13} />
                    )}
                    <span>
                      {selectedBook.progress?.status === "finished"
                        ? "Mark Unfinished"
                        : "Mark Finished"}
                    </span>
                  </button>
                  {selectedBook.progress && selectedBook.progress.status !== "notStarted" ? (
                    <button
                      className="download-btn"
                      type="button"
                      onClick={() => markBookUnplayed(selectedBook)}
                      disabled={completionPendingBookId === selectedBook.id}
                      aria-label={`Mark ${selectedBook.title} as unplayed and reset listening progress`}
                    >
                      {completionPendingBookId === selectedBook.id ? (
                        <LoaderCircle size={13} className="spin-icon" />
                      ) : (
                        <RotateCcw size={13} />
                      )}
                      <span>Mark Unplayed</span>
                    </button>
                  ) : null}
                  {readalongAvailable ? (
                    <button
                      className={`download-btn ${readalongOpen ? "active" : ""}`}
                      type="button"
                      onClick={() => {
                        haptic("light");
                        if (readalongOpen) closeReadalong();
                        else openReadalong(selectedBook);
                      }}
                      aria-pressed={readalongOpen}
                      aria-label={`${readalongOpen ? "Close" : "Open"} ${selectedBook.readingFile ? "read along" : "extras"} for ${selectedBook.title}`}
                    >
                      {selectedBook.readingFile ? <BookOpen size={13} /> : <Images size={13} />}
                      <span>{selectedBook.readingFile ? "Read Along" : "Extras"}</span>
                    </button>
                  ) : null}
                  {selectedBook.deviceBookId ? (
                    <span className="download-btn active device-status" aria-label="Imported from this device">
                      <FolderOpen size={13} />
                      <span>On device</span>
                    </span>
                  ) : demoMode ? (
                    <span className="download-btn active device-status" aria-label="Included with the on-device demo">
                      <CircleCheck size={13} />
                      <span>On device</span>
                    </span>
                  ) : Capacitor.isNativePlatform() && (capabilities.downloads || downloadedBookIds.has(selectedBook.id) || selectedDownload) ? (
                    <button
                      className={`download-btn ${downloadedBookIds.has(selectedBook.id) ? "active" : ""} ${
                        selectedDownload ? "downloading" : ""
                      }`}
                      type="button"
                      onClick={() => {
                        haptic("light");
                        void (selectedDownload
                          ? cancelOfflineDownload(selectedBook)
                          : downloadedBookIds.has(selectedBook.id)
                            ? removeOfflineDownload(selectedBook)
                            : downloadForOffline(selectedBook));
                      }}
                      aria-label={
                        selectedDownload
                          ? `Cancel download of ${selectedBook.title}`
                          : downloadedBookIds.has(selectedBook.id)
                            ? `Remove downloaded copy of ${selectedBook.title}`
                          : `Download ${selectedBook.title} for offline playback`
                      }
                    >
                      {selectedDownload ? (
                        <DownloadRing fraction={selectedDownload.fraction} />
                      ) : (
                        <Download size={13} />
                      )}
                      <span>
                        {selectedDownload
                          ? "Cancel"
                          : downloadedBookIds.has(selectedBook.id)
                            ? "Downloaded"
                            : "Download"}
                      </span>
                    </button>
                  ) : capabilities.bookArchive ? (
                    <a
                      className="download-btn"
                      href={bookDownloadUrl(selectedBook.id)}
                      download
                      aria-label={`Download ${selectedBook.title} as zip`}
                    >
                      <Download size={13} />
                      <span>Download</span>
                    </a>
                  ) : !native && capabilities.downloads ? (
                    <details className="track-downloads">
                      <summary className="download-btn"><Download size={13} /> Download tracks</summary>
                      <ul>
                        {selectedBook.tracks.map((track) => (
                          <li key={track.id}>
                            <a href={mediaUrl(track.downloadUrl ?? track.streamUrl)}
                              target="_blank" rel="noreferrer" download>{track.title}</a>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {Capacitor.isNativePlatform() && downloadStatus?.bookId === selectedBook.id ? (
                    <span className="download-status">{downloadStatus.message}</span>
                  ) : null}
                  {playbackError ? <span className="download-status">{playbackError}</span> : null}
                  {completionError?.bookId === selectedBook.id ? (
                    <span className="download-status" role="alert">
                      {completionError.message}
                    </span>
                  ) : null}
                </div>
              </div>
              {/* The web sets the title in one of three sizes by its length, in
                  a box of fixed height, so a long title neither pushes the rest
                  of the page down nor needs a different layout. */}
              <h2 data-length={titleLengthClass(selectedBook.title)}>
                <span>{selectedBook.title}</span>
              </h2>
              {!isViewingPlayingBook ? (
                <div className="book-quick-start">
                  <button
                    type="button"
                    className="book-quick-play"
                    aria-label={`Play ${selectedBook.title}`}
                    onClick={() => void playSelectedBook(selectedBook)}
                  >
                    <span className="book-quick-play-icon"><Play size={20} fill="currentColor" /></span>
                    <span className="book-quick-play-copy">
                      <strong>
                        {selectedBook.progress?.status === "inProgress"
                          ? "Resume this book"
                          : selectedBook.progress?.status === "finished"
                            ? "Read it again"
                            : "Begin this reading"}
                      </strong>
                      <small>
                        {selectedBook.progress?.status === "inProgress"
                          && formatDurationLabel(selectedBook.progress.remainingSeconds)
                          ? `${formatDurationLabel(selectedBook.progress.remainingSeconds)} left`
                          : formatDurationLabel(selectedBook.durationSeconds ?? durationFromTracks(selectedBook)) ?? "Start from the beginning"}
                      </small>
                    </span>
                  </button>
                  {playbackBook && playbackBook.id !== selectedBook.id ? (
                    <button type="button" className="book-quick-return" onClick={scrollToPlayer}>
                      <Headphones size={14} />
                      <span>Now playing <em>{playbackBook.title}</em></span>
                    </button>
                  ) : null}
                </div>
              ) : null}
              <p className="book-credits" title={[selectedBook.author, selectedBook.narrator ? `Narrated by ${selectedBook.narrator}` : null].filter(Boolean).join(" • ") || undefined}>
                {selectedBook.author ? <span>{selectedBook.author}</span> : null}
                {selectedBook.narrator ? <span>Narrated by {selectedBook.narrator}</span> : null}
                {!selectedBook.author && !selectedBook.narrator ? <span>{selectedBook.trackCount} tracks</span> : null}
              </p>
              {native && formatDurationLabel(selectedBook.durationSeconds ?? durationFromTracks(selectedBook)) ? (
                <div className="book-runtime" aria-label="Total runtime">
                  <span className="book-runtime-label">Runtime</span>
                  <span className="book-runtime-value">
                    {formatDurationLabel(selectedBook.durationSeconds ?? durationFromTracks(selectedBook))}
                  </span>
                </div>
              ) : null}
              {/* On the web every book gets the same four facts in the same
                  places, blank or not, and the subjects keep to a single
                  scrolling line, so the page holds its shape from one book to
                  the next. */}
              {!native ? (
                <>
                  <dl className="book-colophon">
                    {[
                      {
                        label: "Series",
                        value: selectedBook.metadata.series
                          ? `${selectedBook.metadata.series}${selectedBook.metadata.seriesPosition ? ` · #${selectedBook.metadata.seriesPosition}` : ""}`
                          : null
                      },
                      { label: "Published", value: selectedBook.publishedDate || null },
                      { label: "Publisher", value: selectedBook.metadata.publisher || null },
                      {
                        label: "Runtime",
                        value: formatDurationLabel(selectedBook.durationSeconds ?? durationFromTracks(selectedBook)) ?? null
                      }
                    ].map((fact) => (
                      <div key={fact.label}>
                        <dt>{fact.label}</dt>
                        <dd title={fact.value ?? undefined}>{fact.value ?? "—"}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="metadata-strip book-subjects">
                    {tagsForBook(selectedBook).map((tag) => (
                      <span className="metadata-custom-tag" key={tag.name}>
                        {tag.name}{tag.position ? ` · #${tag.position}` : ""}
                      </span>
                    ))}
                    {selectedBook.genres.map((genre) => <span key={genre}>{genre}</span>)}
                  </div>
                </>
              ) : null}
            </div>
          </div>

          {native ? (
            <div className="metadata-strip">
              {selectedBook.metadata.series ? (
                <span>{selectedBook.metadata.series}{selectedBook.metadata.seriesPosition ? ` · #${selectedBook.metadata.seriesPosition}` : ""}</span>
              ) : null}
              {tagsForBook(selectedBook).map((tag) => (
                <span className="metadata-custom-tag" key={tag.name}>
                  {tag.name}{tag.position ? ` · #${tag.position}` : ""}
                </span>
              ))}
              {selectedBook.publishedDate ? <span>{selectedBook.publishedDate}</span> : null}
              {selectedBook.metadata.publisher ? <span>{selectedBook.metadata.publisher}</span> : null}
              {selectedBook.genres.slice(0, 2).map((genre) => <span key={genre}>{genre}</span>)}
            </div>
          ) : null}

          {selectedSharedReaders.length > 0 ? (
            <section className="shared-readers" aria-label="Other listeners">
              <span className="section-label"><Users size={13} /> Also read by</span>
              <ul>
                {selectedSharedReaders.map((reader) => (
                  <li key={reader.userId} className={reader.status}>
                    <span className="shared-reader-name">{reader.username}</span>
                    <span className="shared-reader-status">{readerStatusLabel(reader)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {selectedDescription ? (
            <div className="book-description-wrap">
              <p
                className={`book-description ${descriptionCanExpand && !descriptionExpanded ? "clamped" : ""}`}
                id="selected-book-description"
              >
                {selectedDescription}
              </p>
              {descriptionCanExpand ? (
                <button
                  type="button"
                  className="book-description-toggle"
                  aria-controls="selected-book-description"
                  aria-expanded={descriptionExpanded}
                  onClick={() => {
                    haptic("light");
                    setDescriptionExpanded((expanded) => !expanded);
                  }}
                >
                  {descriptionExpanded ? "Less" : "More"}
                </button>
              ) : null}
            </div>
          ) : null}

          {!readalongOpen && readalongAvailable ? (
            <section className={`readalong-invite ${selectedBook.readingFile ? "" : "extras"}`} aria-label="Read along">
              <span className="readalong-invite-icon" aria-hidden="true">
                {selectedBook.readingFile ? <BookOpen size={22} strokeWidth={1.4} /> : <Images size={22} strokeWidth={1.4} />}
              </span>
              <div className="readalong-invite-copy">
                <strong>
                  {selectedBook.readingFile
                    ? selectedHasExtras
                      ? "Read along with the ebook — extras included"
                      : "Read along with the ebook"
                    : "Extras included with this book"}
                </strong>
                <span>
                  {selectedBook.readingFile && selectedReadAlongMode
                    ? `${READ_ALONG_MODE_LABELS[selectedReadAlongMode].title}. ${READ_ALONG_MODE_LABELS[selectedReadAlongMode].detail}`
                    : [
                        selectedCompanionGroups.supplements.length > 0
                          ? `${selectedCompanionGroups.supplements.length} picture ${selectedCompanionGroups.supplements.length === 1 ? "document" : "documents"}`
                          : null,
                        selectedCompanionGroups.images.length > 0
                          ? `${selectedCompanionGroups.images.length} ${selectedCompanionGroups.images.length === 1 ? "picture" : "pictures"}`
                          : null
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
              </div>
              <button
                type="button"
                className="download-btn active"
                onClick={() => {
                  haptic("light");
                  openReadalong(selectedBook);
                }}
              >
                {selectedBook.readingFile ? <BookOpen size={13} /> : <Images size={13} />}
                <span>{selectedBook.readingFile ? "Open reader" : "View extras"}</span>
              </button>
            </section>
          ) : null}

          {showReaderInNowView ? null : readalongPanelElement}

          {isViewingPlayingBook && currentTrack ? (
            <>
              <div className="track-line">
                <span className="title">{currentTrack.title}</span>
                <span className="ordinal">
                  {String(activeTrackIndex + 1).padStart(2, "0")} / {String(selectedBook.tracks.length).padStart(2, "0")}
                </span>
              </div>

              <div className="transport">
                {activeChapter ? (
                  <button
                    className="round-button secondary transport-skip"
                    aria-label={chapterElapsed > 5 ? "Restart chapter" : "Previous chapter"}
                    onClick={restartOrPreviousChapter}
                    disabled={chapterElapsed <= 5 && !hasPreviousChapter}
                  >
                    <SkipBack size={22} strokeWidth={1.7} />
                    <small>{chapterElapsed > 5 ? "Restart" : "Previous"}</small>
                  </button>
                ) : null}
                <button
                  className="round-button secondary transport-skip"
                  aria-label="Rewind 15 seconds"
                  onClick={() => seekBy(-15)}
                >
                  <RotateCcw size={22} strokeWidth={1.7} />
                  <small>15s</small>
                </button>
                <button
                  className={`round-button primary${playPending ? " play-pending" : ""}`}
                  aria-label={playPending ? "Cancel play" : isPlaying ? "Pause" : "Play"}
                  aria-busy={playPending}
                  onClick={togglePlayback}
                >
                  {isPlaying || playPending ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
                  {playPending ? <span className="play-pending-ring" aria-hidden="true" /> : null}
                </button>
                <button
                  className="round-button secondary transport-skip"
                  aria-label="Forward 30 seconds"
                  onClick={() => seekBy(30)}
                >
                  <RotateCw size={22} strokeWidth={1.7} />
                  <small>30s</small>
                </button>
                {activeChapter ? (
                  <button
                    className="round-button secondary transport-skip"
                    aria-label="Next chapter"
                    onClick={nextChapter}
                    disabled={!hasNextChapter}
                  >
                    <SkipForward size={22} strokeWidth={1.7} />
                    <small>Next</small>
                  </button>
                ) : null}
              </div>

              <div className="timeline">
                {activeChapter && chapterSegments.length > 1 ? (
                  <>
                    <div className="chapter-now">
                      <span>{activeChapter.title}</span>
                      <span>
                        Chapter {activeChapter.chapterNumber} / {chapterSegments.length}
                      </span>
                    </div>
                    {chapterSegments.length <= MAX_CHAPTER_SEGMENTS ? (
                      <div className="chapter-segments" aria-label="Book chapter progress">
                        {chapterSegments.map((chapter) => {
                          const isActive = chapter.id === activeChapter.id;
                          const isComplete = bookPosition >= chapter.endSeconds;
                          const fill =
                            isComplete
                              ? 100
                              : isActive
                                ? Math.max(0, Math.min(100, (chapterElapsed / chapterDuration) * 100))
                                : 0;
                          const segmentClass = `chapter-segment ${isActive ? "active" : ""} ${isComplete ? "complete" : ""}`;
                          // On touch the slivers are impossible to hit on
                          // purpose and far too easy to hit by accident —
                          // keep them purely visual there; the chapter list
                          // below handles deliberate jumps.
                          return native ? (
                            <div
                              key={chapter.id}
                              className={segmentClass}
                              style={{ flexGrow: chapter.durationSeconds }}
                              aria-hidden="true"
                            >
                              <span style={{ width: `${fill}%` }} />
                            </div>
                          ) : (
                            <button
                              key={chapter.id}
                              className={segmentClass}
                              style={{ flexGrow: chapter.durationSeconds }}
                              title={`${chapter.title} · ${formatTime(chapter.startSeconds)}`}
                              aria-label={`Jump to ${chapter.title}`}
                              onClick={() => seekBookPosition(chapter.startSeconds)}
                            >
                              <span style={{ width: `${fill}%` }} />
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="book-progressbar" aria-label="Book progress" role="img">
                        <span
                          style={{
                            width: `${bookDuration > 0 ? Math.min(100, Math.max(0, (bookPosition / bookDuration) * 100)) : 0}%`
                          }}
                        />
                      </div>
                    )}
                  </>
                ) : null}
                {activeChapter ? (
                  <ScrubSlider
                    ariaLabel={`Playback position in ${activeChapter.title}`}
                    max={chapterDuration}
                    value={Math.min(chapterElapsed, chapterDuration)}
                    onPreview={setScrubPreview}
                    onCommit={(value) => seekBookPosition(activeChapter.startSeconds + value)}
                  />
                ) : (
                  <ScrubSlider
                    ariaLabel="Playback position"
                    max={Math.max(1, sliderMax)}
                    value={Math.min(position, Math.max(1, sliderMax))}
                    onPreview={setScrubPreview}
                    onCommit={seekTo}
                  />
                )}
                <div className="time-row">
                  <span className="elapsed">
                    {formatTime(scrubbedElapsed)}
                  </span>
                  <span>
                    {activeChapter ? formatTime(chapterDuration) : formatTime(sliderMax)}
                  </span>
                </div>
                {displayBookRemainingSeconds !== null && bookCompletionPercent !== null ? (
                  <div
                    className="book-time-row"
                    aria-label={`${formatTime(displayBookRemainingSeconds)} remaining in the book, ${bookCompletionPercent}% complete`}
                  >
                    <span>{formatTime(displayBookRemainingSeconds)} left in book</span>
                    <span>{bookCompletionPercent}% complete</span>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="book-preview-actions">
              {native ? (
                <button
                  type="button"
                  className="preview-primary"
                  aria-label={`Play ${selectedBook.title}`}
                  onClick={() => void playSelectedBook(selectedBook)}
                >
                  <span className="preview-primary-icon"><Play size={19} fill="currentColor" /></span>
                  <span>
                    {selectedBook.progress?.status === "inProgress"
                      ? `Resume${
                          formatDurationLabel(selectedBook.progress.remainingSeconds)
                            ? ` · ${formatDurationLabel(selectedBook.progress.remainingSeconds)} left`
                            : ""
                        }`
                      : selectedBook.progress?.status === "finished"
                        ? "Read it again"
                        : "Begin this reading"}
                  </span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="round-button primary"
                    aria-label={`Play ${selectedBook.title}`}
                    onClick={() => void playSelectedBook(selectedBook)}
                  >
                    <Play size={30} fill="currentColor" />
                  </button>
                  <span className="preview-cta">
                    {selectedBook.progress?.status === "inProgress"
                      ? `Resume${
                          formatDurationLabel(selectedBook.progress.remainingSeconds)
                            ? ` · ${formatDurationLabel(selectedBook.progress.remainingSeconds)} left`
                            : ""
                        }`
                      : selectedBook.progress?.status === "finished"
                        ? "Read it again"
                        : "Begin this reading"}
                  </span>
                </>
              )}
              {playbackBook && playbackBook.id !== selectedBook.id ? (
                <button type="button" className="preview-return" onClick={scrollToPlayer}>
                  {native ? (
                    <><Play size={13} fill="currentColor" /><span>Return to <em>{playbackBook.title}</em></span></>
                  ) : (
                    <>Still playing · <em>{playbackBook.title}</em></>
                  )}
                </button>
              ) : null}
            </div>
          )}

          {isViewingPlayingBook ? (
            <div className="controls-grid">
              <section className="control-section">
                <div className="section-label"><Gauge size={13} /> Cadence</div>
                <PlaybackSpeedControl value={speed} onChange={updateSpeed} rotary={native} />
              </section>

              {/* Phones have hardware volume buttons; a second software
                  volume just adds a card. */}
              {!native ? (
                <section className="control-section">
                  <label className="section-label" htmlFor="volume"><Volume2 size={13} /> Volume</label>
                  <input
                    id="volume"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={volume}
                    onChange={(event) => setVolume(Number(event.currentTarget.value))}
                  />
                </section>
              ) : null}

              <section className="control-section">
                <label className="section-label" htmlFor="sleep"><Timer size={13} /> Nightfall</label>
                <select
                  id="sleep"
                  value={sleepCustomOpen ? "custom" : String(sleepMinutes)}
                  onChange={(event) => {
                    const choice = event.currentTarget.value;
                    if (choice === "custom") {
                      setSleepCustomDraft(sleepMinutes > 0 ? String(sleepMinutes) : "");
                      setSleepCustomOpen(true);
                      return;
                    }
                    configureSleepTimer(Number(choice));
                  }}
                >
                  <option value="0">—</option>
                  {sleepChoices.map((option) => (
                    <option key={option} value={String(option)}>
                      {formatSleepTimerMinutes(option)}
                    </option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
                {sleepCustomOpen ? (
                  <form className="sleep-custom" onSubmit={startCustomSleepTimer}>
                    <input
                      type="number"
                      autoFocus
                      inputMode="numeric"
                      enterKeyHint="done"
                      min={SLEEP_TIMER_MIN_MINUTES}
                      max={SLEEP_TIMER_MAX_MINUTES}
                      step={1}
                      placeholder="Minutes"
                      aria-label="Custom sleep timer in minutes"
                      value={sleepCustomDraft}
                      onChange={(event) => setSleepCustomDraft(event.currentTarget.value)}
                    />
                    <button type="submit" disabled={sleepCustomMinutes === null}>Set</button>
                    <button type="button" className="sleep-custom-cancel" aria-label="Cancel custom timer" onClick={() => { haptic("light"); setSleepCustomOpen(false); }}><X size={16} /></button>
                  </form>
                ) : null}
                {sleepRemaining > 0 ? <span className="sleep-copy">{formatTime(sleepRemaining)} remaining</span> : null}
              </section>
            </div>
          ) : null}

          {selectedChapterSegments.length > 0 ? (
            <section className="track-list-section" ref={trackListSectionRef}>
              <button
                type="button"
                className="track-list-header track-list-toggle"
                aria-expanded={chaptersOpen}
                onClick={() => {
                  haptic("light");
                  setChaptersOpen((open) => {
                    if (open) setShowChapterJumpTop(false);
                    return !open;
                  });
                }}
              >
                <span className="title-of-contents">Embedded Chapters</span>
                <span className="section-label">
                  <ListMusic size={13} /> {selectedChapterSegments.length} Markers
                  <ChevronDown size={14} className={`toggle-chevron ${chaptersOpen ? "open" : ""}`} />
                </span>
              </button>
              {chaptersOpen ? (
                <div className="track-list" ref={chaptersListRef}>
                  {selectedChapterSegments.map((chapter, index) => (
                    <button
                      key={chapter.id}
                      data-chapter-id={chapter.id}
                      className={`track-row ${isViewingPlayingBook && chapter.id === activeChapter?.id ? "active" : ""}`}
                      onClick={() => jumpToChapter(chapter)}
                    >
                      <span className="num">{String(index + 1).padStart(2, "0")}</span>
                      <strong>{chapter.title}</strong>
                      <em>{formatTime(chapter.durationSeconds)}</em>
                    </button>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
          {native && nativeTab === "shelf" && nativePlayerView === "details" && showChapterJumpTop ? (
            <button type="button" className="chapter-jump-top" onClick={jumpToPlayerTop} aria-label="Jump to top of book details">
              <ArrowUp size={16} />
              <span>Top</span>
            </button>
          ) : null}
        </>
      ) : (
        <div className="empty-player">
          <Headphones size={48} strokeWidth={1.25} />
          {books.length > 0 ? (
            <>
              <h2>Nothing <em>playing</em></h2>
              <p>Choose a book from your shelf to begin listening.</p>
            </>
          ) : (
            <>
              <h2>An empty <em>shelf</em></h2>
              <p>{localMode
                ? "Choose audiobook files from this device to start listening."
                : isOperaLibre
                  ? "Add audiobook files to your server’s library folder, then refresh the library."
                  : "Check your Jellyfin Books library and this account’s access, then refresh the library."}</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function titleLengthClass(title: string) {
  if (title.length <= 22) return "short";
  if (title.length <= 44) return "medium";
  return "long";
}
