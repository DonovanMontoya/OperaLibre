import {
  AlertCircle,
  ArrowUp,
  Bell,
  Bookmark,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Cloud,
  CloudDownload,
  Download,
  FolderOpen,
  Gauge,
  Headphones,
  KeyRound,
  LoaderCircle,
  LayoutGrid,
  Library,
  List,
  ListMusic,
  LocateFixed,
  LogOut,
  Maximize2,
  Minimize2,
  Minus,
  Network,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  RotateCw,
  Search,
  ServerOff,
  ShieldCheck,
  Smartphone,
  Settings,
  SkipBack,
  SkipForward,
  Sparkles,
  Timer,
  Trash2,
  Upload,
  ScrollText,
  UserCog,
  Users,
  Volume2,
  X
} from "lucide-react";
import type { Book as EpubBook, Contents, EpubCFI, Location, NavItem, Rendition } from "epubjs";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  freshestProgress,
  isSuspectProgressReset,
  progressAfterSave,
  progressFromBookSummary,
  progressTimestamp,
  readProgressCheckpoint,
  resolveActivePlaybackBookId,
  resolveBookId,
  resolveProgressLocation,
  shouldResumeSavedPosition,
  summarizeBookProgress,
  writeProgressCheckpoint
} from "./reliability";
import {
  formatPlaybackSpeed,
  normalizePlaybackSpeed,
  PLAYBACK_SPEED_MAX,
  PLAYBACK_SPEED_MIN,
  PLAYBACK_SPEED_PRESETS,
  PLAYBACK_SPEED_STEP,
  PLAYBACK_SPEED_VALUES,
  readPlaybackSpeed,
  writePlaybackSpeed
} from "./playbackSpeed";
import {
  bookVolumeStorageKey,
  BOOK_GAIN_DB_MAX,
  BOOK_GAIN_DB_MIN,
  BOOK_GAIN_DB_PRESETS,
  BOOK_GAIN_DB_STEP,
  BOOK_GAIN_DEFAULT,
  bookGainFromDb,
  bookGainToDb,
  formatBookGainDb,
  createBookGainSync,
  mergeServerBookGains,
  readBookGains,
  writeBookGains
} from "./bookVolume";
import { compareReadingStatus, readingStatus, readingStatusLabel } from "./bookProgress";
import { PlaybackGainChain, streamCanBeBoosted } from "./playbackGain";
import { isLibationAdding } from "./libationState";
import { displayBookDescription, enrichBooksFromLibation } from "./bookMetadata";
import { buildChapterSegments, chapterAtBookPosition } from "./chapters";
import {
  bookDownloadUrl,
  activateServerAlias,
  addServerAlias,
  clearServerUrl,
  completeLibationAccountLogin,
  cancelLibationAccountLogin,
  deleteLibationAccount,
  generateSyncMap,
  getAlignmentStatus,
  getAuthStatus,
  getBooks,
  getJob,
  getSyncMap,
  getLibationBooks,
  getLibationAccess,
  getLibationStatus,
  getFinishFeed,
  getMe,
  markFinishFeedSeen,
  getProgress,
  getServerStorageKey,
  getServerAliases,
  getServerIdentityUrl,
  getServerUrl,
  getServerType,
  getStoredMediaToken,
  getStoredToken,
  hasUserConfiguredServer,
  isNetworkError,
  isLocalMode,
  enterLocalMode,
  exitLocalMode,
  liberateAllLibationBooks,
  liberateLibationBook,
  listLibationRequests,
  listJobs,
  logout as apiLogout,
  mediaUrl,
  pingServer,
  readalongUrl,
  reconnectUsingServerAliases,
  requestLibationBook,
  reportPlaybackStarted,
  removeServerAlias,
  rescanLibrary,
  saveProgress,
  setBookCompletion,
  setBookVolume,
  setStoredMediaToken,
  setStoredToken,
  setUnauthorizedHandler,
  syncLibationLibrary,
  startLibationAccountLogin,
  uploadAudiobook,
  updateBookMetadata
} from "./api";
import type { ServerAlias } from "./api";
import {
  cacheLibrary,
  cacheOfflineUser,
  cacheProgress,
  cancelBookOfflineDownload,
  downloadBookForOffline,
  getBookBackgroundDownloadStatus,
  getCachedLibrary,
  getCachedProgress,
  getOfflineCoverUrl,
  getOfflineTrackUrl,
  getOfflineUser,
  isBookDownloaded,
  releaseOfflineMediaUrl,
  removeBookDownload
} from "./offline";
import { isNativeApp } from "./api";
import { isSupportedAudioFileName, SUPPORTED_AUDIO_EXTENSIONS } from "./mediaFiles";
import { haptic, openNativeBrowser, selectionHaptic } from "./native";
import { isLeftEdgeBackSwipe } from "./nativeNavigation";
import {
  disableRotationLock,
  enableRotationLock,
  isRotationLockAvailable,
  readStoredRotationLock
} from "./rotationLock";
import {
  attachNativeAudioPlayer,
  getNativeAudioRecovery,
  pauseNativeAudio,
  playNativeAudio,
  seekNativeAudio,
  setNativeAudioGain,
  updateNativeAudioNowPlaying,
  usesNativeAudioPlayer,
  type NativeAudioQueueTrack
} from "./nativeAudio";
import { DEMO_USER, enterDemoMode, exitDemoMode, isDemoMode } from "./demo";
import { NATIVE_STARTUP_SETTLE_MS, shouldAcceptNativeTrackChange } from "./startup";
import {
  backfillDeviceLibraryMetadata,
  DEVICE_USER,
  getDeviceBooks,
  getDeviceProgress,
  importAudiobookFromDevice,
  mergeDeviceAndServerBooks,
  migrateDeviceLibraryFileExtensions,
  removeDeviceBook,
  saveDeviceProgress,
  setDeviceBookCompletion
} from "./localLibrary";
import { AuthGate, ServerSetup } from "./Auth";
import { AdminPanel } from "./Admin";
import { ProfilePage } from "./Profile";
import { ProgressSharingCard, isNotifiedOfFinishes } from "./ProgressSharing";
import {
  EMPTY_FINISH_FEED,
  arrivedSince,
  finishAnnouncement,
  finishBannerText,
  finishedAgoLabel
} from "./finishFeed";
import { ensureFinishBannerPermission, postFinishBanner } from "./finishNotifications";
import { readerStatusLabel, summarizeSharedProgress } from "./sharedProgress";
import type {
  AlignmentStatus,
  AuthUser,
  Book,
  BookMetadataUpdate,
  Chapter,
  FinishFeed,
  JobStatus,
  LibationBook,
  LibationAccount,
  LibationDownloadRequest,
  LibationLoginStarted,
  LibationStatus,
  SyncFragment,
  SyncMap,
  Progress,
  Track
} from "./types";

const SLEEP_OPTIONS = [5, 15, 30, 45, 60];
const APP_STATE_STORAGE_PREFIX = "operalibre.appState";
const LIBATION_CONFIRM_TIMEOUT_MS = 12_000;
const LIBATION_READER_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;
const PROGRESS_SAVE_INTERVAL_MS = 2_000;

type NativeTab = "shelf" | "reading" | "ledger" | "admin" | "settings";
type NativePlayerSheet = "speed" | "sleep" | "chapters" | "details" | null;
type DeviceDownloadActivity = {
  bookId: string;
  // Kept alongside the id so the queue row survives the book leaving `books`
  // (a library refresh, a filter, a server switch) with Cancel still reachable.
  title: string;
  fraction: number | null;
  state: "queued" | "running";
  queuedAt: number;
};
type DeviceNotice = { message: string; bookId?: string };
type PendingSeek = { trackId: string; positionSeconds: number };
type QueuedProgressSave = {
  bookId: string;
  progress: Progress;
  isPaused: boolean;
  intentionalSeekGeneration: number;
};

function audioSourceMatches(audio: HTMLAudioElement, source: string) {
  if (!source) return false;
  try {
    return audio.currentSrc === new URL(source, document.baseURI).href;
  } catch {
    return audio.currentSrc === source;
  }
}

function readStoredSpeed() {
  try {
    return readPlaybackSpeed(window.localStorage);
  } catch {
    return 1;
  }
}

function writeStoredSpeed(value: number) {
  try {
    writePlaybackSpeed(window.localStorage, value);
  } catch {
    // ignore storage failures
  }
}

function readStoredBookGains(userId: string) {
  try {
    return readBookGains(window.localStorage, bookVolumeStorageKey(getServerStorageKey(), userId));
  } catch {
    return {};
  }
}

/**
 * The cached shelf is a snapshot of the server's answer at some earlier launch,
 * so its gains can predate an adjustment made since — and a launch served from
 * the cache is exactly when the listener has no way to set them again. Drop the
 * field so the cache is treated like a backend that never stored one and the
 * local mirror stays in charge.
 */
function withoutCachedBookGains(books: Book[]): Book[] {
  return books.map(({ volumeGain: _volumeGain, ...book }) => book);
}

function writeStoredBookGains(userId: string, gains: Record<string, number>) {
  try {
    writeBookGains(window.localStorage, bookVolumeStorageKey(getServerStorageKey(), userId), gains);
  } catch {
    // ignore storage failures
  }
}

const SPEED_WHEEL_SPACING_PX = 48;

/**
 * A book's own loudness trim. Audiobooks are mastered at wildly different
 * levels, and the device volume is the wrong knob for that: turning it up for
 * one quiet narrator leaves it far too loud for the next book.
 *
 * The scale is decibels because that is the unit loudness moves in — equal
 * steps sound equally large, which a linear multiplier does not.
 */
function BookVolumeControl({
  value,
  onChange,
  canBoost,
  inputId,
  compact = false
}: {
  value: number;
  onChange: (db: number) => void;
  canBoost: boolean;
  inputId: string;
  /**
   * The desktop card sits in a row of restrained controls — a bare slider, a
   * select — so it stays a bare slider with a value under it. The full form,
   * with its heading and tap-sized presets, is for the phone sheet.
   */
  compact?: boolean;
}) {
  const db = bookGainToDb(value);
  const maximum = canBoost ? BOOK_GAIN_DB_MAX : 0;
  const position = Math.min(db, maximum);
  const presetOptions = BOOK_GAIN_DB_PRESETS.filter((preset) => preset <= maximum);

  const slider = (
    <input
      id={inputId}
      type="range"
      min={BOOK_GAIN_DB_MIN}
      max={maximum}
      step={BOOK_GAIN_DB_STEP}
      value={position}
      aria-valuetext={formatBookGainDb(position)}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
    />
  );

  const hint = canBoost ? null : (
    <span className="book-volume-hint">
      This page can only quiet a book. Lifting one needs the phone or desktop app, or a frontend
      served by OperaLibre itself.
    </span>
  );

  if (compact) {
    // Label, control, one line of state — the shape the Nightfall card beside
    // it already uses.
    return (
      <div className="book-volume book-volume-compact">
        {slider}
        <span className="book-volume-value">{formatBookGainDb(db)}</span>
        {hint}
      </div>
    );
  }

  // Laid out like the cadence control it sits beside: the value reads above the
  // track, the ends of the range label themselves, and the presets close the
  // card.
  return (
    <div className="book-volume book-volume-full">
      <div className="book-volume-heading">
        <output aria-live="polite">{formatBookGainDb(db)}</output>
        <span>{BOOK_GAIN_DB_STEP} dB steps</span>
      </div>
      {slider}
      <div className="book-volume-range-labels" aria-hidden="true">
        <span>{formatBookGainDb(BOOK_GAIN_DB_MIN)}</span>
        <span>{maximum === 0 ? "Original" : `+${maximum} dB`}</span>
      </div>
      {/* A lone "back to normal" pill is not a choice, so the row only earns
          its space where there is something to choose between. */}
      {presetOptions.length > 1 ? (
        <div className="book-volume-presets">
          {presetOptions.map((preset) => (
            <button
              key={preset}
              type="button"
              className={preset === position ? "selected" : ""}
              aria-label={preset === 0 ? "Original level" : `Plus ${preset} decibels`}
              onClick={() => onChange(preset)}
            >
              {preset === 0 ? "0" : `+${preset}`}
            </button>
          ))}
        </div>
      ) : null}
      {hint}
    </div>
  );
}

function PlaybackSpeedControl({
  value,
  onChange,
  rotary = false
}: {
  value: number;
  onChange: (value: number) => void;
  rotary?: boolean;
}) {
  const formattedSpeed = formatPlaybackSpeed(value);
  const currentIndex = PLAYBACK_SPEED_VALUES.indexOf(normalizePlaybackSpeed(value));
  const [wheelDragIndex, setWheelDragIndex] = useState<number | null>(null);
  const visualWheelIndex = wheelDragIndex ?? currentIndex;
  const atMinimum = value <= PLAYBACK_SPEED_MIN;
  const atMaximum = value >= PLAYBACK_SPEED_MAX;
  const dragState = useRef<{
    lastIndex: number;
    pointerId: number;
    startIndex: number;
    startX: number;
  } | null>(null);

  function selectIndex(index: number, withHaptic = false) {
    const nextIndex = Math.min(PLAYBACK_SPEED_VALUES.length - 1, Math.max(0, index));
    const nextValue = PLAYBACK_SPEED_VALUES[nextIndex];
    if (nextValue === value) return;
    if (withHaptic) haptic("light");
    onChange(nextValue);
  }

  return (
    <div className="speed-control">
      {rotary ? (
        <>
          <div className="speed-wheel-shell">
            <button
              type="button"
              aria-label={`Decrease playback speed by ${PLAYBACK_SPEED_STEP} times`}
              disabled={atMinimum}
              onClick={() => selectIndex(currentIndex - 1, true)}
            >
              <Minus size={17} />
            </button>
            <div
              className={`speed-wheel${wheelDragIndex === null ? "" : " dragging"}`}
              role="slider"
              tabIndex={0}
              aria-label="Playback speed"
              aria-orientation="horizontal"
              aria-valuemin={PLAYBACK_SPEED_MIN}
              aria-valuemax={PLAYBACK_SPEED_MAX}
              aria-valuenow={value}
              aria-valuetext={`${formattedSpeed} times${value === 1 ? ", normal" : ""}`}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
                  event.preventDefault();
                  selectIndex(currentIndex - 1, true);
                } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
                  event.preventDefault();
                  selectIndex(currentIndex + 1, true);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  selectIndex(0, true);
                } else if (event.key === "End") {
                  event.preventDefault();
                  selectIndex(PLAYBACK_SPEED_VALUES.length - 1, true);
                }
              }}
              onPointerDown={(event) => {
                dragState.current = {
                  lastIndex: currentIndex,
                  pointerId: event.pointerId,
                  startIndex: currentIndex,
                  startX: event.clientX
                };
                setWheelDragIndex(currentIndex);
                selectionHaptic("start");
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = dragState.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                const dragIndex = Math.min(
                  PLAYBACK_SPEED_VALUES.length - 1,
                  Math.max(0, drag.startIndex + (drag.startX - event.clientX) / SPEED_WHEEL_SPACING_PX)
                );
                setWheelDragIndex(dragIndex);
                const nextIndex = Math.round(dragIndex);
                if (nextIndex === drag.lastIndex) return;
                drag.lastIndex = nextIndex;
                selectionHaptic("change");
                selectIndex(nextIndex);
              }}
              onPointerUp={(event) => {
                if (dragState.current?.pointerId !== event.pointerId) return;
                dragState.current = null;
                setWheelDragIndex(null);
                selectionHaptic("end");
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={() => {
                dragState.current = null;
                setWheelDragIndex(null);
                selectionHaptic("end");
              }}
              onWheel={(event) => {
                if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
                event.preventDefault();
                selectIndex(currentIndex + (event.deltaX > 0 ? 1 : -1), true);
              }}
            >
              <div className="speed-wheel-lens" aria-hidden="true" />
              <div className="speed-wheel-pointer" aria-hidden="true" />
              {PLAYBACK_SPEED_VALUES.map((option, index) => {
                const offset = index - visualWheelIndex;
                if (Math.abs(offset) > 3.5) return null;
                const distance = Math.min(3, Math.round(Math.abs(offset)));
                return (
                  <span
                    key={option}
                    className={`speed-wheel-value distance-${distance}${index === currentIndex ? " selected" : ""}`}
                    style={{
                      "--speed-x": `${offset * SPEED_WHEEL_SPACING_PX}px`,
                      "--speed-turn": `${offset * -32}deg`
                    } as React.CSSProperties}
                    aria-hidden="true"
                  >
                    {formatPlaybackSpeed(option)}
                  </span>
                );
              })}
            </div>
            <button
              type="button"
              aria-label={`Increase playback speed by ${PLAYBACK_SPEED_STEP} times`}
              disabled={atMaximum}
              onClick={() => selectIndex(currentIndex + 1, true)}
            >
              <Plus size={17} />
            </button>
          </div>
          <p className="speed-wheel-hint">
            <span>Swipe to rotate</span>
            <span>{formattedSpeed}× · {PLAYBACK_SPEED_STEP}× steps</span>
          </p>
        </>
      ) : (
        <>
          <div className="speed-slider-heading">
            <output aria-live="polite">{formattedSpeed}×</output>
            <span>{PLAYBACK_SPEED_STEP}× steps</span>
          </div>
          <input
            type="range"
            min={PLAYBACK_SPEED_MIN}
            max={PLAYBACK_SPEED_MAX}
            step={PLAYBACK_SPEED_STEP}
            value={value}
            aria-label="Playback speed"
            aria-valuetext={`${formattedSpeed} times${value === 1 ? ", normal" : ""}`}
            onChange={(event) => onChange(normalizePlaybackSpeed(Number(event.currentTarget.value)))}
          />
          <div className="speed-range-labels" aria-hidden="true">
            <span>{PLAYBACK_SPEED_MIN}×</span>
            <span>{PLAYBACK_SPEED_MAX}×</span>
          </div>
        </>
      )}
      <div className="speed-presets" aria-label="Playback speed presets">
        {PLAYBACK_SPEED_PRESETS.map((option) => (
          <button
            type="button"
            key={option}
            className={value === option ? "selected" : ""}
            aria-pressed={value === option}
            onClick={() => {
              if (rotary && value !== option) haptic("light");
              onChange(option);
            }}
          >
            {formatPlaybackSpeed(option)}×
          </button>
        ))}
      </div>
    </div>
  );
}

// Beyond this the segments are too thin to read or tap, and their fixed
// borders/gaps overflow a phone screen; fall back to one continuous bar.
const MAX_CHAPTER_SEGMENTS = 32;

/**
 * play() rejects for benign reasons (a pause or source change interrupting a
 * pending play). Left unhandled those rejections are noise at best — and the
 * macOS shell treats any unhandled rejection as fatal. Real playback failures
 * still surface through the element's `error` event.
 */
function safePlay(audio: HTMLAudioElement | null | undefined) {
  audio?.play().catch(() => undefined);
}

type SortMode = "title" | "author" | "series" | "genre" | "progress" | "duration" | "account";
type ViewMode = "list" | "grid";
type LibrarySource = "local" | "audible";
type ReaderTheme = "paper" | "sepia" | "night";
type MetadataEditorState = {
  title: string;
  author: string;
  narrator: string;
  publisher: string;
  series: string;
  seriesPosition: string;
  publishedDate: string;
  genres: string;
  asin: string;
  description: string;
};

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "title", label: "Title" },
  { value: "author", label: "Author" },
  { value: "series", label: "Series" },
  { value: "genre", label: "Genre" },
  { value: "progress", label: "Progress" },
  { value: "account", label: "Account" },
  { value: "duration", label: "Length" }
];

const SORT_MODE_STORAGE_KEY = "operalibre.sortMode";
const LIBRARY_SOURCES: LibrarySource[] = ["local", "audible"];

// "account" only makes sense for the Audible shelf; "series"/"genre"/"progress" only
// for the local library — an Audible row is a purchase that has not been downloaded yet,
// so it carries no progress to sort on. Sort mode is persisted per source so switching
// shelves — including across restarts, since librarySource itself always starts back at
// "local" — restores what was last chosen there instead of permanently collapsing to
// "title".
const AUDIBLE_ONLY_SORT_MODES: SortMode[] = ["account"];
const LOCAL_ONLY_SORT_MODES: SortMode[] = ["series", "genre", "progress"];

function isSortModeSupported(source: LibrarySource, mode: SortMode) {
  const unsupported = source === "local" ? AUDIBLE_ONLY_SORT_MODES : LOCAL_ONLY_SORT_MODES;
  return !unsupported.includes(mode);
}

function sortModeStorageKey(source: LibrarySource) {
  return `${SORT_MODE_STORAGE_KEY}.${source}`;
}

// Sort mode used to live in a single shared key. Seed each per-source key from it once so
// an existing choice survives the upgrade instead of silently resetting to "title".
let legacySortModeMigrated = false;

function migrateLegacySortMode() {
  // Runs from a useState initializer, so a storage failure here would throw during render
  // and blank the app. A lost sort preference is not worth that; swallow and move on. The
  // legacy key is only dropped once the per-source keys are actually written.
  try {
    const legacy = window.localStorage.getItem(SORT_MODE_STORAGE_KEY);
    if (legacy === null) return;
    if (SORT_OPTIONS.some((option) => option.value === legacy)) {
      for (const source of LIBRARY_SOURCES) {
        if (window.localStorage.getItem(sortModeStorageKey(source)) !== null) continue;
        if (!isSortModeSupported(source, legacy as SortMode)) continue;
        window.localStorage.setItem(sortModeStorageKey(source), legacy);
      }
    }
    window.localStorage.removeItem(SORT_MODE_STORAGE_KEY);
  } catch {
    // Storage unavailable or full — the shelf just opens on the default sort.
  }
}

function readStoredSortMode(source: LibrarySource): SortMode {
  if (!legacySortModeMigrated) {
    legacySortModeMigrated = true;
    migrateLegacySortMode();
  }
  const stored = window.localStorage.getItem(sortModeStorageKey(source));
  const isValid = SORT_OPTIONS.some((option) => option.value === stored)
    && isSortModeSupported(source, stored as SortMode);
  return isValid ? (stored as SortMode) : "title";
}

function compareShelfLabels(left: string | null | undefined, right: string | null | undefined) {
  const a = left?.trim() ?? "";
  const b = right?.trim() ?? "";
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function bookSortGroupLabel(book: Book, sortMode: SortMode) {
  if (sortMode === "series") return book.metadata.series?.trim() || "Standalone";
  if (sortMode === "genre") return book.genres[0]?.trim() || "Uncategorized";
  if (sortMode === "progress") return readingStatusLabel(readingStatus(book));
  return null;
}

// The caption above each run of rows, naming what the run is grouped by. Only the
// modes bookSortGroupLabel groups ever reach this.
function bookSortGroupCaption(sortMode: SortMode) {
  if (sortMode === "series") return "Series";
  if (sortMode === "genre") return "Genre";
  return "Progress";
}

function formatTime(value: number | null | undefined) {
  if (!Number.isFinite(value ?? NaN)) {
    return "--:--";
  }

  const totalSeconds = Math.max(0, Math.floor(value ?? 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatLibationMessage(status: LibationStatus | null): string | null {
  const rawMessage = status?.message?.trim();
  if (!rawMessage) {
    return null;
  }

  if (/Cannot find settings files at/i.test(rawMessage)) {
    const serverUrl = getServerUrl();
    const configuredPath = status?.libationFilesDir ? `\`${status.libationFilesDir}\`` : "`libation_files_dir`";
    return `The connected OperaLibre server at ${serverUrl} cannot read Libation's settings files. Configure ${configuredPath} on the server to point at the LibationFiles folder that contains AccountsSettings.json and Settings.json, then restart the server.`;
  }

  return rawMessage;
}

function metadataEditorFromBook(book: Book): MetadataEditorState {
  return {
    title: book.title,
    author: book.author ?? "",
    narrator: book.narrator ?? "",
    publisher: book.metadata.publisher ?? "",
    series: book.metadata.series ?? "",
    seriesPosition: book.metadata.seriesPosition ?? "",
    publishedDate: book.publishedDate ?? "",
    genres: book.genres.join(", "),
    asin: book.asin ?? "",
    description: book.description ?? ""
  };
}

function parseGenreInput(value: string) {
  return value
    .split(/[;,]/)
    .map((genre) => genre.trim())
    .filter(Boolean);
}

function metadataUpdateFromEditor(form: MetadataEditorState): BookMetadataUpdate {
  return {
    title: form.title.trim(),
    author: form.author.trim(),
    narrator: form.narrator.trim(),
    publisher: form.publisher.trim(),
    series: form.series.trim(),
    seriesPosition: form.seriesPosition.trim(),
    publishedDate: form.publishedDate.trim(),
    genres: parseGenreInput(form.genres),
    asin: form.asin.trim(),
    description: form.description.trim()
  };
}

function bookSubtitle(book: Book) {
  return [book.author, book.narrator ? `Narrated by ${book.narrator}` : null]
    .filter(Boolean)
    .join(" • ");
}

function currentTrackIndex(book: Book | null, track: Track | null) {
  if (!book || !track) {
    return 0;
  }
  return Math.max(0, book.tracks.findIndex((candidate) => candidate.id === track.id));
}

function trackOffsetSeconds(book: Book, trackIndex: number) {
  return book.tracks
    .slice(0, Math.max(0, trackIndex))
    .reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
}

function durationFromTracks(book: Book) {
  return book.tracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
}

function formatMinutes(minutes: number | null | undefined) {
  if (!Number.isFinite(minutes ?? NaN)) {
    return "Unknown length";
  }
  const totalMinutes = Math.max(0, Math.round(minutes ?? 0));
  const hours = Math.floor(totalMinutes / 60);
  const remainder = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function formatElapsed(startedAt: string | null | undefined, finishedAt?: string | null) {
  if (!startedAt) {
    return null;
  }
  const start = progressTimestamp(startedAt);
  const end = finishedAt ? progressTimestamp(finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return formatDurationLabel((end - start) / 1000);
}

function jobTitle(job: JobStatus) {
  if (job.kind === "libation-sync") {
    return "Checking Audible library";
  }
  if (job.kind === "libation-liberate") {
    return "Audible download";
  }
  if (job.kind === "libation-liberate-all") {
    return "Audible download all";
  }
  return job.kind;
}

function isPendingJob(job: JobStatus) {
  return job.status === "queued" || job.status === "running";
}

function reconcileLibationJobs(jobs: JobStatus[], previousJobs: JobStatus[]) {
  const previousById = new Map(previousJobs.map((job) => [job.id, job]));
  return jobs
    .filter((job) => job.kind.startsWith("libation-"))
    .map((job) => ({
      ...job,
      // Servers from before queued downloads were introduced do not return a
      // targetId. Keep the optimistic association so the title's button stays
      // attached to its job while that server is being upgraded.
      targetId: job.targetId ?? previousById.get(job.id)?.targetId ?? null
    }));
}

function jobStateLabel(job: JobStatus) {
  if (job.status === "queued") {
    return "Queued";
  }
  if (job.status !== "running") {
    return job.status;
  }
  if (job.kind === "libation-sync") {
    return "Syncing";
  }
  if (job.kind === "libation-liberate" || job.kind === "libation-liberate-all") {
    return "Downloading";
  }
  return "Running";
}

function jobDetailLines(job: JobStatus) {
  const text = [job.error, job.output].filter(Boolean).join("\n");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12);
}

function jobSummary(job: JobStatus) {
  if (job.error) {
    return job.error;
  }
  if (job.status === "queued") {
    return "Waiting for the current Libation operation to finish.";
  }
  const lines = job.output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const latest = lines[lines.length - 1];
  if (latest) {
    return latest;
  }
  return job.status === "running" ? "Waiting for Libation output..." : "No output captured.";
}

function formatDurationLabel(seconds: number | null | undefined) {
  if (!Number.isFinite(seconds ?? NaN)) {
    return null;
  }
  const totalMinutes = Math.max(0, Math.ceil((seconds ?? 0) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${Math.max(1, minutes)}m`;
}

function bookProgressLabel(book: Book) {
  if (!book.progress || book.progress.status === "notStarted") {
    return "Not started";
  }
  if (book.progress.status === "finished") {
    return "Finished";
  }
  if (
    book.progress.status === "inProgress"
    && (book.progress.remainingSeconds ?? 1) <= 0
  ) {
    return "In progress";
  }
  const remaining = formatDurationLabel(book.progress.remainingSeconds);
  if (remaining) {
    return `${remaining} left`;
  }
  if (book.progress.status === "inProgress") {
    return "In progress";
  }
  return "Not started";
}

function canPreviewReadalong(book: Book) {
  const extension = book.readingFile?.extension.toLowerCase();
  return extension === "epub" || extension === "pdf" || extension === "txt" || extension === "html" || extension === "htm";
}

function storedStateKey(userId: string, field: "selectedBookId" | "playbackBookId") {
  return `${APP_STATE_STORAGE_PREFIX}.${getServerStorageKey()}.${userId}.${field}`;
}

function readStoredBookId(userId: string, field: "selectedBookId" | "playbackBookId") {
  try {
    return window.localStorage.getItem(storedStateKey(userId, field));
  } catch {
    return null;
  }
}

function writeStoredBookId(userId: string, field: "selectedBookId" | "playbackBookId", bookId: string | null) {
  try {
    const key = storedStateKey(userId, field);
    if (bookId) {
      window.localStorage.setItem(key, bookId);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore storage failures
  }
}

function nativeAudioRecoveryScope(userId: string, bookId: string) {
  return `${getServerStorageKey()}:${userId}:${bookId}`;
}

function flattenToc(items: NavItem[], depth = 0): Array<NavItem & { depth: number }> {
  return items.flatMap((item) => [
    { ...item, depth },
    ...flattenToc(item.subitems ?? [], depth + 1)
  ]);
}

type EpubSyncTarget = {
  id: string;
  title: string;
};

type ParsedReadalongLabel = {
  number: number | null;
  key: string;
};

function normalizeReadalongText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseReadalongLabel(value: string): ParsedReadalongLabel {
  const chapterMatch = value.match(/\bchapter\s+0*(\d+)\b/i);
  const leadingMatch = value.match(/^\s*0*(\d+)\s*[.:)\-–—]\s*/);
  const number = Number(chapterMatch?.[1] ?? leadingMatch?.[1] ?? NaN);
  const withoutNumber = chapterMatch
    ? value.slice((chapterMatch.index ?? 0) + chapterMatch[0].length).replace(/^\s*[.:)\-–—]\s*/, "")
    : value.replace(/^\s*0*\d+\s*[.:)\-–—]\s*/, "");

  return {
    number: Number.isFinite(number) ? number : null,
    key: normalizeReadalongText(withoutNumber)
  };
}

function readalongMatchScore(target: ParsedReadalongLabel, item: ParsedReadalongLabel) {
  let score = 0;
  if (target.number !== null && item.number === target.number) {
    score += 100;
  }
  if (target.key && item.key) {
    if (target.key === item.key) {
      score += 80;
    } else if (target.key.includes(item.key) || item.key.includes(target.key)) {
      score += 45;
    } else {
      const targetWords = new Set(target.key.split(" ").filter((word) => word.length > 3));
      const sharedWords = item.key
        .split(" ")
        .filter((word) => word.length > 3 && targetWords.has(word)).length;
      score += Math.min(35, sharedWords * 10);
    }
  }
  return score;
}

function findTocHrefForSyncTarget(
  toc: Array<NavItem & { depth: number }>,
  syncTarget: EpubSyncTarget
) {
  const parsedTarget = parseReadalongLabel(syncTarget.title);
  const ranked = toc
    .filter((item) => item.href)
    .map((item) => ({
      href: item.href,
      score: readalongMatchScore(parsedTarget, parseReadalongLabel(item.label))
    }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  return best && best.score >= 70 ? best.href : null;
}

function hrefsMatch(displayedHref: string, fragmentHref: string) {
  const clean = (value: string) => {
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep as-is
    }
    return value.split(/[#?]/)[0].replace(/^\.?\//, "");
  };
  const a = clean(displayedHref);
  const b = clean(fragmentHref);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function findActiveFragmentIndex(fragments: SyncFragment[], seconds: number) {
  let low = 0;
  let high = fragments.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (fragments[mid].startSeconds <= seconds) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best < 0) {
    return -1;
  }
  // Keep the fragment active through the silence before the next sentence so
  // the highlight doesn't flicker off between sentences.
  const activeUntil = fragments[best + 1]?.startSeconds ?? fragments[best].endSeconds;
  return seconds < activeUntil ? best : -1;
}

// The haystack index and this needle normalization must collapse text the
// same way so indexOf offsets map back to DOM positions.
function normalizeSyncNeedle(value: string) {
  let out = "";
  let lastWasSpace = true;
  for (const ch of value) {
    if (ch === "\u00AD") {
      continue;
    }
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        out += " ";
        lastWasSpace = true;
      }
    } else {
      out += ch.toLowerCase();
      lastWasSpace = false;
    }
  }
  return out.trim();
}

type DocumentSearchIndex = {
  doc: Document;
  text: string;
  map: Array<{ node: Text; offset: number }>;
};

function buildDocumentSearchIndex(doc: Document): DocumentSearchIndex {
  const pieces: string[] = [];
  const map: Array<{ node: Text; offset: number }> = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let lastWasSpace = true;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    const data = textNode.data;
    for (let offset = 0; offset < data.length; offset += 1) {
      const ch = data[offset];
      if (ch === "\u00AD") {
        continue;
      }
      if (/\s/.test(ch)) {
        if (!lastWasSpace) {
          pieces.push(" ");
          map.push({ node: textNode, offset });
          lastWasSpace = true;
        }
      } else {
        for (const lower of ch.toLowerCase()) {
          pieces.push(lower);
          map.push({ node: textNode, offset });
        }
        lastWasSpace = false;
      }
    }
  }
  return { doc, text: pieces.join(""), map };
}

function findRangeInSearchIndex(index: DocumentSearchIndex, needle: string, fromOffset: number) {
  if (!needle) {
    return null;
  }
  let at = index.text.indexOf(needle, Math.min(fromOffset, index.text.length));
  if (at === -1) {
    at = index.text.indexOf(needle);
  }
  if (at === -1) {
    return null;
  }
  const start = index.map[at];
  const end = index.map[at + needle.length - 1];
  if (!start || !end) {
    return null;
  }
  const range = index.doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, Math.min(end.offset + 1, end.node.data.length));
  return { range, endOffset: at + needle.length };
}

function EpubReadalong({
  title,
  url,
  syncTarget,
  syncFragments,
  positionSeconds,
  onSeekTo
}: {
  title: string;
  url: string;
  syncTarget: EpubSyncTarget | null;
  syncFragments: SyncFragment[] | null;
  positionSeconds: number;
  onSeekTo?: (seconds: number) => void;
}) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<EpubBook | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const syncedTargetRef = useRef<string | null>(null);
  const epubCfiClassRef = useRef<typeof EpubCFI | null>(null);
  const searchIndexRef = useRef<DocumentSearchIndex | null>(null);
  const searchCursorRef = useRef(0);
  const highlightCfiRef = useRef<string | null>(null);
  const highlightThemeRef = useRef<ReaderTheme | null>(null);
  const highlightedFragmentRef = useRef(-1);
  const autoNavHrefRef = useRef<string | null>(null);
  const lastLocationRef = useRef<Location | null>(null);
  const readerUrlRef = useRef(url);
  if (readerUrlRef.current !== url) {
    readerUrlRef.current = url;
    lastLocationRef.current = null;
  }
  const [toc, setToc] = useState<Array<NavItem & { depth: number }>>([]);
  const [location, setLocation] = useState<Location | null>(null);
  const [activeHref, setActiveHref] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [follow, setFollow] = useState(true);
  const [readerTheme, setReaderTheme] = useState<ReaderTheme>(() => {
    const stored = window.localStorage.getItem("operalibre.readerTheme");
    return stored === "sepia" || stored === "night" ? stored : "paper";
  });
  const [fontScale, setFontScale] = useState(() => {
    const stored = Number(window.localStorage.getItem("operalibre.readerFontScale"));
    return Number.isFinite(stored) && stored >= 85 && stored <= 140 ? stored : 100;
  });
  const [focusMode, setFocusMode] = useState(false);

  useEffect(() => {
    if (!viewerRef.current) {
      return;
    }

    let cancelled = false;
    setToc([]);
    setLocation(null);
    setActiveHref("");
    setError(null);
    setErrorDetail(null);
    setIsReady(false);
    syncedTargetRef.current = null;
    searchIndexRef.current = null;
    searchCursorRef.current = 0;
    highlightCfiRef.current = null;
    highlightedFragmentRef.current = -1;
    autoNavHrefRef.current = null;

    const abortController = new AbortController();
    let readyTimeout: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let book: EpubBook | null = null;
    let rendition: Rendition | null = null;
    const handleRelocated = (nextLocation: Location) => {
      lastLocationRef.current = nextLocation;
      setLocation(nextLocation);
      setIsReady(true);
    };
    const handleRendered = () => {
      setIsReady(true);
    };

    const openBook = async () => {
      try {
        const epubModule = await import("epubjs");
        const ePub = epubModule.default;
        epubCfiClassRef.current = epubModule.EpubCFI;
        if (cancelled || !viewerRef.current) {
          return;
        }

        readyTimeout = window.setTimeout(() => {
          if (!cancelled) {
            setError("This EPUB is taking longer than expected to open.");
            abortController.abort();
          }
        }, 15000);

        const response = await fetch(url, {
          credentials: "include",
          signal: abortController.signal
        });
        if (!response.ok) {
          throw new Error(`EPUB request failed with ${response.status}`);
        }
        const data = await response.arrayBuffer();
        if (cancelled || !viewerRef.current) {
          return;
        }
        if (data.byteLength === 0) {
          throw new Error("EPUB response was empty");
        }

        book = ePub(data, {
          replacements: "blobUrl"
        });
        await book.opened;
        if (cancelled || !viewerRef.current) {
          return;
        }

        rendition = book.renderTo(viewerRef.current, {
          width: "100%",
          height: "100%",
          flow: "paginated",
          spread: "none",
          manager: "default"
        });

        rendition.themes.register("operalibre-paper", {
          body: {
            color: "#241b15 !important",
            background: "#fffdf7 !important",
            "font-family": "Georgia, 'Times New Roman', serif !important",
            "line-height": "1.78 !important",
            padding: "0 5% !important"
          },
          p: { "margin-bottom": "1.15em !important" },
          a: { color: "#7c2f2a !important" },
          img: { "max-width": "100% !important", height: "auto !important" }
        });
        rendition.themes.register("operalibre-sepia", {
          body: {
            color: "#3b2b1d !important",
            background: "#f2e5c9 !important",
            "font-family": "Georgia, 'Times New Roman', serif !important",
            "line-height": "1.78 !important",
            padding: "0 5% !important"
          },
          p: { "margin-bottom": "1.15em !important" },
          a: { color: "#7d3f26 !important" },
          img: { "max-width": "100% !important", height: "auto !important" }
        });
        rendition.themes.register("operalibre-night", {
          body: {
            color: "#e7dcc8 !important",
            background: "#171411 !important",
            "font-family": "Georgia, 'Times New Roman', serif !important",
            "line-height": "1.78 !important",
            padding: "0 5% !important"
          },
          p: { "margin-bottom": "1.15em !important" },
          a: { color: "#d9b574 !important" },
          img: { "max-width": "100% !important", height: "auto !important" }
        });

        bookRef.current = book;
        renditionRef.current = rendition;
        rendition.on("relocated", handleRelocated);
        rendition.on("rendered", handleRendered);

        book.loaded.navigation
          .then((navigation) => {
            if (!cancelled) {
              setToc(flattenToc(navigation.toc));
            }
          })
          .catch(() => {
            if (!cancelled) {
              setToc([]);
            }
          });

        await rendition.display(lastLocationRef.current?.start?.cfi);
        if (!cancelled) {
          setIsReady(true);
          setError(null);
          setErrorDetail(null);
          if (readyTimeout !== null) {
            window.clearTimeout(readyTimeout);
            readyTimeout = null;
          }
        }
      } catch (error) {
        if (!cancelled && !abortController.signal.aborted) {
          console.error("EPUB readalong failed", error);
          setError("This EPUB could not be opened inline.");
          setErrorDetail(error instanceof Error ? error.message : String(error));
        }
      }
    };

    resizeObserver = new ResizeObserver(() => {
      const bounds = viewerRef.current?.getBoundingClientRect();
      if (bounds && bounds.width > 0 && bounds.height > 0 && rendition) {
        rendition.resize(Math.floor(bounds.width), Math.floor(bounds.height));
      }
    });
    resizeObserver.observe(viewerRef.current);
    void openBook();

    return () => {
      cancelled = true;
      abortController.abort();
      if (readyTimeout !== null) {
        window.clearTimeout(readyTimeout);
      }
      resizeObserver?.disconnect();
      rendition?.off("relocated", handleRelocated);
      rendition?.off("rendered", handleRendered);
      rendition?.destroy();
      book?.destroy();
      renditionRef.current = null;
      bookRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    window.localStorage.setItem("operalibre.readerTheme", readerTheme);
    if (isReady) {
      renditionRef.current?.themes.select(`operalibre-${readerTheme}`);
    }
  }, [isReady, readerTheme]);

  useEffect(() => {
    window.localStorage.setItem("operalibre.readerFontScale", String(fontScale));
    if (isReady) {
      renditionRef.current?.themes.fontSize(`${fontScale}%`);
    }
  }, [fontScale, isReady]);

  useEffect(() => {
    if (!focusMode) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFocusMode(false);
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [focusMode]);

  useEffect(() => {
    if (!syncTarget || !isReady || toc.length === 0 || syncedTargetRef.current === syncTarget.id) {
      return;
    }

    const href = findTocHrefForSyncTarget(toc, syncTarget);
    if (!href) {
      return;
    }

    syncedTargetRef.current = syncTarget.id;
    setActiveHref(href);
    void renditionRef.current?.display(href);
  }, [isReady, syncTarget, toc]);

  const fragmentIndex = useMemo(
    () =>
      syncFragments && syncFragments.length > 0
        ? findActiveFragmentIndex(syncFragments, positionSeconds)
        : -1,
    [positionSeconds, syncFragments]
  );

  // Sentence-level readalong: highlight the fragment being narrated and keep
  // it on screen, following page turns and chapter boundaries.
  useEffect(() => {
    const rendition = renditionRef.current;
    // The night page is dark, so the marker must lighten instead of darken.
    const highlightStyles =
      readerTheme === "night"
        ? { fill: "#e8b64c", "fill-opacity": "0.4", "mix-blend-mode": "screen" }
        : { fill: "#d9a441", "fill-opacity": "0.32", "mix-blend-mode": "multiply" };
    if (!follow || !syncFragments || fragmentIndex < 0) {
      if (rendition && highlightCfiRef.current) {
        try {
          rendition.annotations.remove(highlightCfiRef.current, "highlight");
        } catch {
          // stale annotation already gone
        }
      }
      highlightCfiRef.current = null;
      highlightedFragmentRef.current = -1;
      return;
    }
    if (!isReady || !rendition || !location) {
      return;
    }
    const fragment = syncFragments[fragmentIndex];
    const currentHref = location.start?.href ?? "";
    if (!hrefsMatch(currentHref, fragment.href)) {
      if (autoNavHrefRef.current !== fragment.href) {
        autoNavHrefRef.current = fragment.href;
        highlightedFragmentRef.current = -1;
        void rendition.display(fragment.href);
      }
      return;
    }
    autoNavHrefRef.current = null;
    if (highlightedFragmentRef.current === fragmentIndex) {
      if (highlightThemeRef.current !== readerTheme && highlightCfiRef.current) {
        try {
          rendition.annotations.remove(highlightCfiRef.current, "highlight");
        } catch {
          // stale annotation already gone
        }
        rendition.annotations.highlight(
          highlightCfiRef.current,
          {},
          () => onSeekTo?.(fragment.startSeconds),
          "readalong-highlight",
          highlightStyles
        );
        highlightThemeRef.current = readerTheme;
      }
      return;
    }

    const contentsList = ([] as Contents[]).concat(
      (rendition.getContents() as unknown as Contents[]) ?? []
    );
    const contents = contentsList.find((candidate) => candidate?.document?.body);
    const doc = contents?.document;
    if (!contents || !doc) {
      return;
    }
    if (!searchIndexRef.current || searchIndexRef.current.doc !== doc) {
      searchIndexRef.current = buildDocumentSearchIndex(doc);
      searchCursorRef.current = 0;
    }

    // Mark the fragment handled up front so a missing sentence doesn't retry
    // on every relocation.
    highlightedFragmentRef.current = fragmentIndex;

    const found = findRangeInSearchIndex(
      searchIndexRef.current,
      normalizeSyncNeedle(fragment.text),
      searchCursorRef.current
    );
    if (!found) {
      return;
    }
    searchCursorRef.current = found.endOffset;

    let cfi: string;
    try {
      cfi = contents.cfiFromRange(found.range);
    } catch {
      return;
    }
    if (highlightCfiRef.current) {
      try {
        rendition.annotations.remove(highlightCfiRef.current, "highlight");
      } catch {
        // stale annotation already gone
      }
    }
    rendition.annotations.highlight(
      cfi,
      {},
      () => onSeekTo?.(fragment.startSeconds),
      "readalong-highlight",
      highlightStyles
    );
    highlightCfiRef.current = cfi;
    highlightThemeRef.current = readerTheme;

    const EpubCfiClass = epubCfiClassRef.current;
    if (EpubCfiClass && location.start?.cfi && location.end?.cfi) {
      try {
        const comparator = new EpubCfiClass();
        if (
          comparator.compare(cfi, location.end.cfi) >= 0 ||
          comparator.compare(cfi, location.start.cfi) < 0
        ) {
          void rendition.display(cfi);
        }
      } catch {
        // invalid comparison; leave the page as-is
      }
    }
  }, [follow, fragmentIndex, isReady, location, onSeekTo, readerTheme, syncFragments]);

  const percent = location?.start?.percentage;
  const locationLabel = Number.isFinite(percent ?? NaN)
    ? `${Math.round((percent ?? 0) * 100)}%`
    : isReady
      ? "Ready"
      : "Loading";
  const currentTocItem = useMemo(() => {
    const href = location?.start?.href;
    if (!href) {
      return null;
    }
    let match: (NavItem & { depth: number }) | null = null;
    for (const item of toc) {
      if (hrefsMatch(href, item.href)) {
        match = item;
      }
    }
    return match;
  }, [location, toc]);
  const selectedTocHref = currentTocItem?.href ?? activeHref;

  const reader = (
    <div className={`epub-reader theme-${readerTheme} ${focusMode ? "focus-mode" : ""}`}>
      <div className="epub-reader-chrome">
        <div className="epub-toolbar">
          <button type="button" onClick={() => void renditionRef.current?.prev()} aria-label="Previous page">
            <ChevronLeft size={17} />
          </button>
          <div className="epub-location">
            <select
              aria-label={`${title} table of contents`}
              value={selectedTocHref}
              onChange={(event) => {
                const href = event.currentTarget.value;
                setActiveHref(href);
                syncedTargetRef.current = null;
                if (href) {
                  void renditionRef.current?.display(href);
                }
              }}
            >
              <option value="">Contents</option>
              {toc.map((item) => (
                <option key={`${item.href}-${item.label}`} value={item.href}>
                  {"\u00A0".repeat(item.depth * 2)}{item.label}
                </option>
              ))}
            </select>
            <span className="epub-status">
              {syncFragments && follow && fragmentIndex >= 0
                ? `Following · ${locationLabel}`
                : syncTarget
                  ? `Synced · ${locationLabel}`
                  : locationLabel}
            </span>
          </div>
          <button type="button" onClick={() => void renditionRef.current?.next()} aria-label="Next page">
            <ChevronRight size={17} />
          </button>
        </div>

        <div className="epub-preferences" aria-label="Reader appearance">
          <div className="epub-theme-options" aria-label="Reading theme">
            {(["paper", "sepia", "night"] as const).map((theme) => (
              <button
                type="button"
                key={theme}
                className={readerTheme === theme ? "selected" : ""}
                aria-pressed={readerTheme === theme}
                onClick={() => setReaderTheme(theme)}
              >
                {theme}
              </button>
            ))}
          </div>
          <div className="epub-font-controls">
            <button
              type="button"
              aria-label="Decrease reader text size"
              disabled={fontScale <= 85}
              onClick={() => setFontScale((size) => Math.max(85, size - 10))}
            >
              <Minus size={15} />
            </button>
            <span aria-label={`Reader text size ${fontScale}%`}>Aa&nbsp; {fontScale}%</span>
            <button
              type="button"
              aria-label="Increase reader text size"
              disabled={fontScale >= 140}
              onClick={() => setFontScale((size) => Math.min(140, size + 10))}
            >
              <Plus size={15} />
            </button>
          </div>
          {syncFragments && syncFragments.length > 0 ? (
            <button
              type="button"
              className={`epub-tool-button ${follow ? "selected" : ""}`}
              onClick={() =>
                setFollow((enabled) => {
                  const next = !enabled;
                  if (next) {
                    highlightedFragmentRef.current = -1;
                  }
                  return next;
                })
              }
              aria-pressed={follow}
              aria-label={follow ? "Stop following narration" : "Follow narration"}
              title={follow ? "Stop following narration" : "Follow narration"}
            >
              <LocateFixed size={15} />
              <span>Follow</span>
            </button>
          ) : null}
          <button
            type="button"
            className="epub-tool-button"
            onClick={() => setFocusMode((enabled) => !enabled)}
            aria-pressed={focusMode}
            aria-label={focusMode ? "Exit reader focus mode" : "Open reader focus mode"}
            title={focusMode ? "Exit focus mode (Esc)" : "Focus mode"}
          >
            {focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            <span>{focusMode ? "Close" : "Focus"}</span>
          </button>
        </div>
      </div>
      <div className="epub-stage" ref={viewerRef}>
        <span className="epub-progress" style={{ width: `${Math.max(0, Math.min(100, (percent ?? 0) * 100))}%` }} />
        {!isReady && !error ? <span className="epub-loading">Loading EPUB…</span> : null}
        {error ? (
          <span className="epub-error">
            {error}
            {errorDetail ? <small>{errorDetail}</small> : null}
          </span>
        ) : null}
      </div>
    </div>
  );
  return reader;
}

/**
 * Range input that only commits the seek when the interaction ends, so
 * brushing against the bar can't silently move playback — a stray touch can
 * be dragged back to where it started before letting go.
 */
function ScrubSlider({
  ariaLabel,
  max,
  value,
  onCommit
}: {
  ariaLabel: string;
  max: number;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [dragValue, setDragValue] = useState<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  const displayedValue = dragValue ?? value;
  const progressPercent = max > 0
    ? Math.min(100, Math.max(0, (displayedValue / max) * 100))
    : 0;
  const commit = () => {
    if (pendingRef.current !== null) {
      onCommit(pendingRef.current);
      pendingRef.current = null;
    }
    setDragValue(null);
  };
  return (
    <input
      aria-label={ariaLabel}
      type="range"
      min="0"
      max={max}
      step="1"
      value={displayedValue}
      style={{ "--scrub-progress": `${progressPercent}%` } as React.CSSProperties}
      onChange={(event) => {
        const next = Number(event.currentTarget.value);
        pendingRef.current = next;
        setDragValue(next);
      }}
      onPointerUp={commit}
      onTouchEnd={commit}
      onKeyUp={commit}
      onBlur={commit}
    />
  );
}

function DownloadRing({ fraction }: { fraction: number | null }) {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const filled = fraction === null ? 0.28 : Math.max(0.02, Math.min(1, fraction));
  return (
    <svg
      className={`download-ring ${fraction === null ? "indeterminate" : ""}`}
      viewBox="0 0 14 14"
      width={14}
      height={14}
      role="img"
      aria-label={fraction === null ? "Preparing download" : `Downloading, ${Math.round(fraction * 100)}%`}
    >
      <circle className="download-ring-track" cx="7" cy="7" r={radius} />
      <circle
        className="download-ring-fill"
        cx="7"
        cy="7"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - filled)}
      />
    </svg>
  );
}

function CoverArt({ book, size }: { book: Book; size: "small" | "large" }) {
  const className = size === "small" ? "cover-mark" : "large-cover";
  const [offlineCoverUrl, setOfflineCoverUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let resolvedUrl: string | null = null;
    setLoadFailed(false);
    if (isNativeApp()) {
      void getOfflineCoverUrl(book).then((url) => {
        resolvedUrl = url;
        if (active) {
          setOfflineCoverUrl(url);
          // A downloaded cover can arrive after the network fetch failed.
          if (url) setLoadFailed(false);
        } else {
          releaseOfflineMediaUrl(url);
        }
      });
    }
    return () => {
      active = false;
      releaseOfflineMediaUrl(resolvedUrl);
    };
  }, [book]);
  // A device import has no server URL at all: its only cover is the local one.
  const coverSrc = offlineCoverUrl ?? (book.coverArtUrl ? mediaUrl(book.coverArtUrl) : null);
  if (coverSrc && !loadFailed) {
    return (
      <img
        className={className}
        src={coverSrc}
        alt=""
        loading={size === "small" ? "lazy" : "eager"}
        decoding="async"
        fetchPriority={size === "large" ? "high" : "auto"}
        onError={() => setLoadFailed(true)}
      />
    );
  }
  return (
    <span className={className} aria-hidden="true">
      <Headphones size={size === "small" ? 22 : 42} strokeWidth={1.25} />
    </span>
  );
}

function LibationCoverArt({ book }: { book: LibationBook }) {
  const [loadFailed, setLoadFailed] = useState(false);
  if (book.coverArtUrl && !loadFailed) {
    return (
      <img
        className="audible-cover"
        src={mediaUrl(book.coverArtUrl)}
        alt=""
        loading="lazy"
        onError={() => setLoadFailed(true)}
      />
    );
  }
  return (
    <span className="audible-cover placeholder" aria-hidden="true">
      <Headphones size={22} strokeWidth={1.25} />
    </span>
  );
}

const PULL_REFRESH_THRESHOLD = 64;

/**
 * iOS-style pull-to-refresh. Tracks a downward drag that starts with the
 * pane scrolled to the top and fires `onRefresh` once the pull passes the
 * threshold. Disabled (no handlers attached) outside the native shell.
 */
function usePullToRefresh(enabled: boolean, onRefresh: () => Promise<unknown>) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const pullDistance = useRef(0);

  function updatePull(next: number) {
    if (pullDistance.current < PULL_REFRESH_THRESHOLD && next >= PULL_REFRESH_THRESHOLD) {
      haptic("light");
    }
    pullDistance.current = next;
    setPull(next);
  }

  function onTouchStart(event: React.TouchEvent<HTMLElement>) {
    if (refreshing) {
      return;
    }
    startY.current = event.currentTarget.scrollTop <= 0 ? event.touches[0].clientY : null;
  }

  function onTouchMove(event: React.TouchEvent<HTMLElement>) {
    if (refreshing || startY.current === null) {
      return;
    }
    if (event.currentTarget.scrollTop > 0) {
      startY.current = null;
      updatePull(0);
      return;
    }
    const delta = event.touches[0].clientY - startY.current;
    updatePull(delta > 0 ? Math.min(96, delta * 0.45) : 0);
  }

  function settle() {
    const distance = pullDistance.current;
    startY.current = null;
    updatePull(0);
    if (!refreshing && distance >= PULL_REFRESH_THRESHOLD) {
      haptic("medium");
      setRefreshing(true);
      void onRefresh().finally(() => setRefreshing(false));
    }
  }

  if (!enabled) {
    return { pull: 0, refreshing: false, handlers: {} };
  }
  return {
    pull,
    refreshing,
    handlers: { onTouchStart, onTouchMove, onTouchEnd: settle, onTouchCancel: settle }
  };
}

type AuthState =
  | { phase: "loading" }
  | { phase: "server"; returnToLocal?: boolean }
  | { phase: "setup"; setupTokenRequired: boolean; setupLocalOnly: boolean }
  | { phase: "login" }
  | { phase: "ready"; user: AuthUser };

function initialAuthState(): AuthState {
  if (isDemoMode()) return { phase: "ready", user: DEMO_USER };
  if (isLocalMode()) return { phase: "ready", user: DEVICE_USER };
  if (!hasUserConfiguredServer()) return { phase: "server" };

  // A native launch should not sit behind a network timeout. This is the same
  // cached identity used for offline mode; checkAuth validates it in the
  // background and still returns to login if the server rejects the session.
  // Media elements cannot send the API Authorization header, so the native
  // shelf must wait for its query-safe media credential before it renders
  // remote artwork. This matters on the first launch after upgrading from a
  // build that only persisted the full session token.
  const cachedUser = isNativeApp() && getStoredToken() && getStoredMediaToken()
    ? getOfflineUser()
    : null;
  return cachedUser
    ? { phase: "ready", user: cachedUser }
    : { phase: "loading" };
}

function NativeLaunchPlaceholder() {
  return (
    <div className="native-launch-placeholder" role="status" aria-label="Opening OperaLibre">
      <span>OperaLibre</span>
    </div>
  );
}

export default function App() {
  const [authState, setAuthState] = useState<AuthState>(initialAuthState);

  const checkAuth = useCallback(async () => {
    if (isDemoMode()) {
      setAuthState({ phase: "ready", user: DEMO_USER });
      return;
    }
    if (isLocalMode()) {
      setAuthState({ phase: "ready", user: DEVICE_USER });
      return;
    }
    if (!hasUserConfiguredServer()) {
      setAuthState({ phase: "server" });
      return;
    }
    try {
      const status = await getAuthStatus();
      if (status.setupRequired) {
        setStoredToken(null);
        setAuthState({
          phase: "setup",
          setupTokenRequired: status.setupTokenRequired ?? false,
          setupLocalOnly: status.setupLocalOnly ?? false
        });
        return;
      }
      if (status.user) {
        // Servers released before the narrower media credential return no
        // mediaToken and still expect the session token on media URLs.
        setStoredMediaToken(status.mediaToken ?? getStoredToken());
        cacheOfflineUser(status.user);
        setAuthState({ phase: "ready", user: status.user });
        return;
      }
      const token = getStoredToken();
      if (!token) {
        setAuthState({ phase: "login" });
        return;
      }
      try {
        const user = await getMe();
        cacheOfflineUser(user);
        setAuthState({ phase: "ready", user });
      } catch (error) {
        // Keep the token when the server is simply unreachable; only a real
        // rejection should end the session.
        if (isNetworkError(error)) {
          if (await reconnectUsingServerAliases()) {
            await checkAuth();
            return;
          }
          const offlineUser = getOfflineUser();
          setAuthState(offlineUser ? { phase: "ready", user: offlineUser } : { phase: "login" });
          return;
        }
        setStoredToken(null);
        setAuthState({ phase: "login" });
      }
    } catch (error) {
      if (isNetworkError(error) && await reconnectUsingServerAliases()) {
        await checkAuth();
        return;
      }
      const offlineUser = getOfflineUser();
      setAuthState(offlineUser ? { phase: "ready", user: offlineUser } : { phase: "login" });
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setStoredToken(null);
      setAuthState({ phase: "login" });
    });
    void checkAuth();
    return () => setUnauthorizedHandler(null);
  }, [checkAuth]);

  const handleCurrentUserChanged = useCallback((user: AuthUser) => {
    cacheOfflineUser(user);
    setAuthState({ phase: "ready", user });
  }, []);

  if (authState.phase === "loading") {
    if (isNativeApp()) return <NativeLaunchPlaceholder />;
    return (
      <main className="auth-shell startup-shell">
        <div className="startup-loader" role="status" aria-live="polite" aria-label="Opening OperaLibre">
          <div className="startup-mark" aria-hidden="true">
            <span className="startup-book startup-book-left"><i /></span>
            <span className="startup-book startup-book-center"><i /></span>
            <span className="startup-book startup-book-right"><i /></span>
            <span className="startup-sweep" />
          </div>
          <div className="startup-title" aria-hidden="true">
            <span>Opera</span><em>Libre</em>
          </div>
          <span className="startup-caption">Opening the library</span>
          <span className="startup-progress" aria-hidden="true"><i /></span>
        </div>
      </main>
    );
  }

  if (authState.phase === "server") {
    return (
      <ServerSetup
        onConnected={() => {
          setAuthState({ phase: "loading" });
          void checkAuth();
        }}
        onDemo={() => {
          enterDemoMode();
          setAuthState({ phase: "ready", user: DEMO_USER });
        }}
        onLocal={isNativeApp() ? () => {
          enterLocalMode();
          setAuthState({ phase: "ready", user: DEVICE_USER });
        } : undefined}
        onCancel={authState.returnToLocal ? () => {
          enterLocalMode();
          setAuthState({ phase: "ready", user: DEVICE_USER });
        } : undefined}
      />
    );
  }

  if (authState.phase === "setup" || authState.phase === "login") {
    return (
      <AuthGate
        mode={authState.phase}
        setupTokenRequired={authState.phase === "setup" ? authState.setupTokenRequired : false}
        setupLocalOnly={authState.phase === "setup" ? authState.setupLocalOnly : false}
        onAuthenticated={(response) => {
          setStoredToken(response.token);
          setStoredMediaToken(response.mediaToken ?? response.token);
          cacheOfflineUser(response.user);
          setAuthState({ phase: "ready", user: response.user });
        }}
        onChangeServer={() => {
          setStoredToken(null);
          clearServerUrl();
          setAuthState({ phase: "server" });
        }}
      />
    );
  }

  return (
    <MainApp
      currentUser={authState.user}
      onCurrentUserChanged={handleCurrentUserChanged}
      onConnectServer={() => {
        exitLocalMode();
        setAuthState({ phase: "server", returnToLocal: true });
      }}
      onLogout={async () => {
        if (isLocalMode()) {
          exitLocalMode();
          setAuthState({ phase: "server" });
          return;
        }
        const leavingDemo = isDemoMode();
        try {
          await apiLogout();
        } catch {
          // ignore
        }
        setStoredToken(null);
        if (leavingDemo) {
          exitDemoMode();
          setAuthState({ phase: "server" });
        } else {
          setAuthState({ phase: "login" });
        }
      }}
    />
  );
}

/**
 * Desktop browsers narrow the file dialog from this list. iOS is left
 * unfiltered instead: it resolves `accept` to UTIs and types `.m4b` as
 * `com.apple.protected-mpeg-4-audio-b`, which answers to no audio MIME type at
 * all, so filtering there greys out the audiobooks the picker exists to find.
 * Either way the chosen names are checked before anything is uploaded.
 */
const UPLOAD_FILE_ACCEPT = [
  ...SUPPORTED_AUDIO_EXTENSIONS.map((extension) => `.${extension}`),
  "audio/mp4",
  "audio/x-m4a",
  "audio/x-m4b",
  "audio/*"
].join(",");

function MainApp({
  currentUser,
  onCurrentUserChanged,
  onLogout,
  onConnectServer
}: {
  currentUser: AuthUser;
  onCurrentUserChanged: (user: AuthUser) => void;
  onLogout: () => void | Promise<void>;
  onConnectServer: () => void;
}) {
  const isOperaLibre = getServerType() === "operalibre";
  const demoMode = isDemoMode();
  const localMode = isLocalMode();
  const native = isNativeApp();
  // Shared reading is an OperaLibre-server feature: Jellyfin keeps its own user
  // data, and demo/local libraries have no other listeners to compare against.
  const sharedProgressAvailable = isOperaLibre && !demoMode && !localMode;
  const rotationLockAvailable = isRotationLockAvailable();
  const [nativeTab, setNativeTab] = useState<NativeTab>("shelf");
  const [rotationLockEnabled, setRotationLockEnabled] = useState(() => readStoredRotationLock() !== null);
  const [rotationLockBusy, setRotationLockBusy] = useState(false);
  const [rotationLockError, setRotationLockError] = useState<string | null>(null);
  const [serverAliases, setServerAliases] = useState<ServerAlias[]>(getServerAliases);
  const [aliasName, setAliasName] = useState("");
  const [aliasUrl, setAliasUrl] = useState("");
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [switchingAliasId, setSwitchingAliasId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOperaLibre || demoMode || localMode) {
      return;
    }
    let cancelled = false;
    const refreshCurrentUser = () => {
      void getMe()
        .then((user) => {
          if (!cancelled) onCurrentUserChanged(user);
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(refreshCurrentUser, 30_000);
    window.addEventListener("focus", refreshCurrentUser);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshCurrentUser);
    };
  }, [demoMode, isOperaLibre, localMode, onCurrentUserChanged]);

  // The shared "who finished what" feed. Polled on the same cadence as the
  // account refresh above: a finish is news for hours, so a tighter loop would
  // buy nothing and cost a request every few seconds.
  const [finishFeed, setFinishFeed] = useState<FinishFeed>(EMPTY_FINISH_FEED);
  const [finishFeedOpen, setFinishFeedOpen] = useState(false);
  // The previous poll, so a banner fires only for what actually just arrived.
  // Null until the first poll lands, which is what keeps a session opening on
  // a backlog from announcing all of it at once.
  const previousFinishFeedRef = useRef<FinishFeed | null>(null);
  const finishFeedAvailable =
    isOperaLibre && !demoMode && !localMode && isNotifiedOfFinishes(currentUser);

  useEffect(() => {
    if (!finishFeedAvailable) {
      // Turning the setting off empties the bell rather than freezing the last
      // feed behind it, and resets the baseline so re-enabling does not fire a
      // burst of banners for everything that happened meanwhile.
      setFinishFeed(EMPTY_FINISH_FEED);
      setFinishFeedOpen(false);
      previousFinishFeedRef.current = null;
      return;
    }
    let cancelled = false;
    const poll = () => {
      void getFinishFeed()
        .then(async (next) => {
          if (cancelled) return;
          const arrivals = arrivedSince(previousFinishFeedRef.current, next);
          previousFinishFeedRef.current = next;
          setFinishFeed(next);
          const banner = finishBannerText(arrivals);
          // Permission is asked for here, the first time there is actually
          // something to show, rather than at launch with no context.
          if (banner && (await ensureFinishBannerPermission())) {
            await postFinishBanner(banner);
          }
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 30_000);
    window.addEventListener("focus", poll);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", poll);
    };
  }, [finishFeedAvailable]);

  function toggleFinishFeed() {
    const opening = !finishFeedOpen;
    setFinishFeedOpen(opening);
    if (!opening) return;
    haptic("light");
    // Opening the panel is the listener reading it, so the badge clears from
    // the top entry down. A finish that lands while it is open stays unseen
    // until the next open, which is why this marks by id rather than "all".
    const latest = finishFeed.latestId;
    if (!latest || finishFeed.unseenCount === 0) return;
    void markFinishFeedSeen(latest)
      .then((next) => {
        previousFinishFeedRef.current = next;
        setFinishFeed(next);
      })
      .catch(() => undefined);
  }

  function saveAlias(event: React.FormEvent) {
    event.preventDefault();
    setAliasError(null);
    try {
      addServerAlias(aliasName, aliasUrl);
      setServerAliases(getServerAliases());
      setAliasName("");
      setAliasUrl("");
    } catch (error) {
      setAliasError(error instanceof Error ? error.message : "Could not save that alias.");
    }
  }

  async function switchToAlias(alias: ServerAlias) {
    setAliasError(null);
    setSwitchingAliasId(alias.id);
    try {
      await pingServer(getServerType(), alias.url);
      activateServerAlias(alias);
      window.location.reload();
    } catch (error) {
      setAliasError(error instanceof Error ? error.message : "Could not reach that address.");
      setSwitchingAliasId(null);
    }
  }

  async function toggleRotationLock() {
    setRotationLockBusy(true);
    setRotationLockError(null);
    try {
      if (rotationLockEnabled) {
        await disableRotationLock();
        setRotationLockEnabled(false);
      } else {
        await enableRotationLock();
        setRotationLockEnabled(true);
      }
      haptic("light");
    } catch (error) {
      setRotationLockError(error instanceof Error ? error.message : "Could not change the rotation lock.");
    } finally {
      setRotationLockBusy(false);
    }
  }
  const [nativePlayerView, setNativePlayerView] = useState<"now" | "details" | "chapters">("now");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const miniPlayerRef = useRef<HTMLElement | null>(null);
  const playerPaneRef = useRef<HTMLElement | null>(null);
  const bookDetailsSwipeStartRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const saveStartedAt = useRef(0);
  const playWhenTrackLoads = useRef(false);
  const progressSaveInFlight = useRef(false);
  const progressSaveAbortController = useRef<AbortController | null>(null);
  const queuedProgressSaves = useRef<Map<string, QueuedProgressSave>>(new Map());
  const progressMutationVersion = useRef(0);
  // Unlike playbackTouchedRef, this advances only for an actual listener
  // action. Shelf Resume starts playback optimistically while reconciliation
  // is still running, and that automatic start must not make a fresher server
  // reply look stale.
  const playbackActionVersionRef = useRef(0);
  const restoredProgressBookId = useRef<string | null>(null);
  // Whether the listener moved playback (play, seek, track change) since the
  // current book was restored. Until then no progress is persisted anywhere:
  // re-stamping the restored — or failed-to-restore — position with a fresh
  // timestamp is exactly how an idle device erases real progress recorded on
  // another one.
  const playbackTouchedRef = useRef(false);
  // Deliberate seeks are numbered per book and acknowledged only after the
  // corresponding server checkpoint succeeds. This keeps an offline seek
  // intentional without permanently disabling reset protection afterward.
  const intentionalSeekGenerationRef = useRef<Map<string, number>>(new Map());
  const acknowledgedSeekGenerationRef = useRef<Map<string, number>>(new Map());
  const explicitSessionStartBookIdRef = useRef<string | null>(null);
  // A shelf Resume is a request to play the *restored* position. Autoplay is
  // therefore armed by the restore effect rather than by the click, so it can
  // never start the placeholder first track while the real one resolves.
  const resumeAutoplayBookIdRef = useRef<string | null>(null);
  const resumeAutoplayPendingRef = useRef(false);
  const resumeReconciliationBookIdRef = useRef<string | null>(null);
  const initialLibraryHydrated = useRef(false);
  const startupNavigationResolved = useRef(false);
  // Authentication can be restored synchronously, but the native destination
  // and playback position depend on cached state. Keep the launch surface
  // visible until both are coherent so neither the default Shelf nor the
  // first track at 0:00 flashes on the way to a restored session.
  const [startupViewReady, setStartupViewReady] = useState(!native);
  const startupViewReadyRef = useRef(!native);
  const startupProgressAppliedRef = useRef(false);
  const startupRevealTimerRef = useRef<number | null>(null);
  const scheduleStartupReveal = useCallback(() => {
    if (!native || startupViewReadyRef.current) return;
    if (startupRevealTimerRef.current !== null) {
      window.clearTimeout(startupRevealTimerRef.current);
    }
    // Progress can arrive from the library summary, IndexedDB, AVPlayer, and
    // the server within a few frames. Reveal only after that burst goes quiet.
    startupRevealTimerRef.current = window.setTimeout(() => {
      startupRevealTimerRef.current = null;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        startupViewReadyRef.current = true;
        setStartupViewReady(true);
      }));
    }, NATIVE_STARTUP_SETTLE_MS);
  }, [native]);
  useEffect(() => () => {
    if (startupRevealTimerRef.current !== null) {
      window.clearTimeout(startupRevealTimerRef.current);
    }
  }, []);
  const [books, setBooks] = useState<Book[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(() =>
    readStoredBookId(currentUser.id, "selectedBookId")
  );
  const [playbackBookId, setPlaybackBookId] = useState<string | null>(() =>
    readStoredBookId(currentUser.id, "playbackBookId")
  );
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [pendingSeek, setPendingSeekState] = useState<PendingSeek | null>(null);
  // Mirrored in a ref so persistProgress (called from pagehide/visibility
  // listeners holding stale closures) always sees the live value.
  const pendingSeekRef = useRef<PendingSeek | null>(null);
  const setPendingSeek = (value: PendingSeek | null) => {
    pendingSeekRef.current = value;
    setPendingSeekState(value);
  };
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const nativePlaybackPlayingRef = useRef(false);
  const [speed, setSpeed] = useState(readStoredSpeed);
  const [volume, setVolume] = useState(0.9);
  // Per-book gain, keyed by book id. The server holds the copy that follows the
  // listener between devices; this is the local mirror that survives an offline
  // launch and covers backends that have no place to store it.
  const [bookGains, setBookGains] = useState<Record<string, number>>(() =>
    readStoredBookGains(currentUser.id)
  );
  // What this device last wrote for a book, until the server echoes it back.
  // A library payload can be older than the adjustment that raced it — a
  // getBooks() already in flight, or a cached shelf served during a network
  // blip — and the merge below would otherwise undo the listener's change.
  const localGainWritesRef = useRef<Map<string, number>>(new Map());
  // Serializes and coalesces the writes behind the gain slider, which reports
  // every step of a drag, and owns the release of the guard above.
  const gainSyncRef = useRef<ReturnType<typeof createBookGainSync> | null>(null);
  if (!gainSyncRef.current) {
    gainSyncRef.current = createBookGainSync(setBookVolume, localGainWritesRef.current);
  }
  // Read by the native player at load time, which happens before the effect
  // that pushes the gain across.
  const playbackGainRef = useRef(BOOK_GAIN_DEFAULT);
  const gainChainRef = useRef<PlaybackGainChain | null>(null);
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const sleepDeadlineRef = useRef<number | null>(null);
  const [nativePlayerSheet, setNativePlayerSheet] = useState<NativePlayerSheet>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Serving the cached library because the server is unreachable; books
  // without a local download can't actually play in this state.
  const [isOffline, setIsOffline] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>(() => readStoredSortMode("local"));
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [librarySource, setLibrarySource] = useState<LibrarySource>("local");
  const [searchQuery, setSearchQuery] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [readalongOpen, setReadalongOpen] = useState(false);
  const [alignmentStatus, setAlignmentStatus] = useState<AlignmentStatus | null>(null);
  const [syncMaps, setSyncMaps] = useState<Record<string, SyncMap | null>>({});
  const [syncJob, setSyncJob] = useState<JobStatus | null>(null);
  const [syncJobError, setSyncJobError] = useState<string | null>(null);
  const [libationStatus, setLibationStatus] = useState<LibationStatus | null>(null);
  const [libationBooks, setLibationBooks] = useState<LibationBook[]>([]);
  const [libationDownloadRequests, setLibationDownloadRequests] = useState<LibationDownloadRequest[]>([]);
  const libationDownloadRequestsRef = useRef<LibationDownloadRequest[]>([]);
  const libationRequestsLoadedRef = useRef(false);
  const [libationLoading, setLibationLoading] = useState(false);
  const [libationBooksLoaded, setLibationBooksLoaded] = useState(false);
  const [libationError, setLibationError] = useState<string | null>(null);
  const [libationRequests, setLibationRequests] = useState<Set<string>>(new Set());
  const [libationAllPending, setLibationAllPending] = useState(false);
  const [libationJobs, setLibationJobs] = useState<JobStatus[]>([]);
  const libationJobsRef = useRef<JobStatus[]>([]);
  const libationJobsGenerationRef = useRef(0);
  const [libationFinalizingAsins, setLibationFinalizingAsins] = useState<Set<string>>(new Set());
  const [libationFinalizationFailures, setLibationFinalizationFailures] = useState<Set<string>>(new Set());
  const libationFinalizationStartedRef = useRef<Map<string, number>>(new Map());
  const [libationRefreshPending, setLibationRefreshPending] = useState(false);
  const [audibleAccountFilter, setAudibleAccountFilter] = useState("all");
  const [libationAccountFormOpen, setLibationAccountFormOpen] = useState(false);
  const [libationAccountLabel, setLibationAccountLabel] = useState("");
  const [libationAccountId, setLibationAccountId] = useState("");
  const [libationAccountLocale, setLibationAccountLocale] = useState("us");
  const [libationReconnectProfileId, setLibationReconnectProfileId] = useState<string | null>(null);
  const [libationLoginFlow, setLibationLoginFlow] = useState<LibationLoginStarted | null>(null);
  const [libationLoginResponseUrl, setLibationLoginResponseUrl] = useState("");
  const [libationLoginBusy, setLibationLoginBusy] = useState(false);
  const [libationAccountBusyId, setLibationAccountBusyId] = useState<string | null>(null);
  const libationMessage = formatLibationMessage(libationStatus);
  const brokenLibationAccounts = libationStatus?.accounts.filter((account) => !account.authenticated) ?? [];
  const pendingLibationJobs = libationJobs.filter(isPendingJob);
  const displayedLibationJobs = pendingLibationJobs.length > 0 ? pendingLibationJobs : libationJobs.slice(0, 1);
  const refreshLibationJob = pendingLibationJobs.find((job) => job.kind === "libation-sync");
  const downloadAllLibationJob = pendingLibationJobs.find((job) => job.kind === "libation-liberate-all");
  const isRefreshingAudible = libationRefreshPending || !!refreshLibationJob;
  const canBrowseLibation = isOperaLibre && (currentUser.isAdmin || (native && !!libationStatus?.enabled));
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadBookName, setUploadBookName] = useState("");
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [metadataEditOpen, setMetadataEditOpen] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [showChapterJumpTop, setShowChapterJumpTop] = useState(false);
  const [metadataForm, setMetadataForm] = useState<MetadataEditorState | null>(null);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  // null while the disk lookup for the current track is in flight; url null
  // means the track is not downloaded and should stream.
  const [offlineSource, setOfflineSource] = useState<{ trackId: string; url: string | null } | null>(null);
  const [mediaArtworkUrl, setMediaArtworkUrl] = useState<string | null>(null);
  const chaptersListRef = useRef<HTMLDivElement | null>(null);
  const trackListSectionRef = useRef<HTMLElement | null>(null);
  const wantsAutoplayRef = useRef(false);
  const [nativeAudioFailed, setNativeAudioFailed] = useState(false);
  const nativeAudio = usesNativeAudioPlayer() && !nativeAudioFailed;
  const nativeAudioQueueRef = useRef<NativeAudioQueueTrack[]>([]);
  const libraryRequestGenerationRef = useRef(0);
  const downloadAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const [downloadedBookIds, setDownloadedBookIds] = useState<Set<string>>(new Set());
  const [downloadStatus, setDownloadStatus] = useState<DeviceNotice | null>(null);
  const [completionPendingBookId, setCompletionPendingBookId] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<DeviceNotice | null>(null);
  const [unplayedConfirmationBookId, setUnplayedConfirmationBookId] = useState<string | null>(null);
  // Native jobs are persisted and serialized by iOS; this map only mirrors
  // their current queue/progress for the UI.
  const [activeDownloads, setActiveDownloads] = useState<Record<string, DeviceDownloadActivity>>({});
  const activeDownloadIdsRef = useRef<Set<string>>(new Set());
  const [deviceImport, setDeviceImport] = useState<{ completed: number; total: number } | null>(null);

  // Restores whatever sort was last chosen for this shelf rather than collapsing to
  // "title": each source keeps its own persisted sort (see readStoredSortMode).
  useEffect(() => {
    setSortMode(readStoredSortMode(librarySource));
  }, [librarySource]);

  function selectSortMode(mode: SortMode) {
    setSortMode(mode);
    window.localStorage.setItem(sortModeStorageKey(librarySource), mode);
  }

  const visibleBooks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = query
      ? books.filter((book) =>
          [book.title, book.author, book.narrator, book.metadata.series, ...book.genres]
            .filter(Boolean)
            .some((field) => field!.toLowerCase().includes(query))
        )
      : books;

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortMode) {
        case "author":
          return (a.author ?? "").localeCompare(b.author ?? "") || a.title.localeCompare(b.title);
        case "series":
          return compareShelfLabels(a.metadata.series, b.metadata.series)
            || compareShelfLabels(a.metadata.seriesPosition, b.metadata.seriesPosition)
            || a.title.localeCompare(b.title);
        case "genre":
          return compareShelfLabels(a.genres[0], b.genres[0]) || a.title.localeCompare(b.title);
        case "progress":
          return compareReadingStatus(a, b) || a.title.localeCompare(b.title);
        case "duration":
          return (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0);
        case "title":
        default:
          return a.title.localeCompare(b.title);
      }
    });
    return sorted;
  }, [books, searchQuery, sortMode]);

  const audibleAccountLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const account of libationStatus?.accounts ?? []) {
      if (account.name?.trim()) labels.set(account.id, account.name.trim());
    }
    for (const book of libationBooks) {
      if (!labels.has(book.profileId)) labels.set(book.profileId, book.profileName);
    }
    return labels;
  }, [libationBooks, libationStatus?.accounts]);

  const visibleLibationBooks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const accountBooks = audibleAccountFilter === "all"
      ? libationBooks
      : libationBooks.filter((book) => book.profileId === audibleAccountFilter);
    const filtered = query
      ? accountBooks.filter((book) =>
          [book.title, book.subtitle, book.authors, book.narrators]
            .filter(Boolean)
            .some((field) => field!.toLowerCase().includes(query))
        )
      : accountBooks;

    return [...filtered].sort((a, b) => {
      if (sortMode === "account") {
        const aLabel = audibleAccountLabels.get(a.profileId) ?? a.profileName;
        const bLabel = audibleAccountLabels.get(b.profileId) ?? b.profileName;
        return aLabel.localeCompare(bLabel) || a.title.localeCompare(b.title);
      }
      if (sortMode === "author") {
        return (a.authors ?? "").localeCompare(b.authors ?? "") || a.title.localeCompare(b.title);
      }
      if (sortMode === "duration") {
        return (b.lengthMinutes ?? 0) - (a.lengthMinutes ?? 0);
      }
      return a.title.localeCompare(b.title);
    });
  }, [audibleAccountFilter, audibleAccountLabels, libationBooks, searchQuery, sortMode]);
  const audibleProfiles = useMemo(() => {
    const profiles = new Map<string, string>();
    for (const book of libationBooks) {
      profiles.set(book.profileId, audibleAccountLabels.get(book.profileId) ?? book.profileName);
    }
    return [...profiles].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [audibleAccountLabels, libationBooks]);

  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedBookId) ?? books[0] ?? null,
    [books, selectedBookId]
  );
  const selectedDescription = selectedBook ? displayBookDescription(selectedBook) : null;
  const selectedSharedReaders = (selectedBook?.sharedProgress ?? []).filter(
    (reader) => reader.status !== "notStarted"
  );
  const descriptionCanExpand = (selectedDescription?.length ?? 0) > 260;
  const selectedDownload = selectedBook ? activeDownloads[selectedBook.id] : undefined;
  const deviceDownloadQueue = useMemo(
    () => Object.values(activeDownloads).sort((a, b) => a.queuedAt - b.queuedAt),
    [activeDownloads]
  );

  const playbackBook = useMemo(
    () => books.find((book) => book.id === playbackBookId) ?? null,
    [books, playbackBookId]
  );
  const playbackDescription = playbackBook ? displayBookDescription(playbackBook) : null;
  const nowPlayingBook = playbackBook;
  const unplayedConfirmationBook = unplayedConfirmationBookId
    ? books.find((book) => book.id === unplayedConfirmationBookId) ?? null
    : null;

  const currentTrack = useMemo(() => {
    if (!playbackBook) {
      return null;
    }
    return (
      playbackBook.tracks.find((track) => track.id === currentTrackId) ??
      playbackBook.tracks[0] ??
      null
    );
  }, [currentTrackId, playbackBook]);

  const activeTrackIndex = currentTrackIndex(playbackBook, currentTrack);
  // Stable identity keys: every progress save rebuilds `books` (and with it
  // the playbackBook/currentTrack objects), so effects that manage the audio
  // source or restore progress must key on ids — re-running them on object
  // identity would tear down the <audio> src mid-playback every few seconds.
  const playbackBookKey = playbackBook?.id ?? null;
  const currentTrackKey = currentTrack?.id ?? null;
  const bookIdsKey = useMemo(() => books.map((book) => book.id).join("|"), [books]);
  const administrableBooks = useMemo(
    () => books.filter((book) => book.source !== "device"),
    [books]
  );
  const playbackBookDownloaded = !!playbackBook && downloadedBookIds.has(playbackBook.id);
  const offlineSourceUrl =
    offlineSource && offlineSource.trackId === currentTrack?.id ? offlineSource.url : null;
  // On native, keep the audio source empty until the disk lookup answers so a
  // downloaded track plays from its file instead of first hitting the network
  // (which fails offline and can consume the pending resume seek).
  const offlineSourcePending = native && !!currentTrack && offlineSource?.trackId !== currentTrack.id;
  const streamUrl =
    !currentTrack || offlineSourcePending ? "" : offlineSourceUrl ?? mediaUrl(currentTrack.streamUrl);
  const sliderMax = duration || currentTrack?.durationSeconds || 0;
  const bookDuration = playbackBook?.durationSeconds ?? (playbackBook ? durationFromTracks(playbackBook) : 0);
  const bookPosition =
    playbackBook && currentTrack
      ? trackOffsetSeconds(playbackBook, activeTrackIndex) + position
      : 0;
  const boundedBookPosition = bookDuration > 0
    ? Math.min(bookDuration, Math.max(0, bookPosition))
    : 0;
  // Keep every visible playback clock on the same whole-second boundary.
  // The media element reports fractional time at browser-dependent rates;
  // formatting each derived time independently made elapsed and remaining
  // labels appear to tick out of sync whenever offsets or durations had a
  // fractional second.
  const displayTrackPosition = Math.floor(Math.max(0, position));
  const displayBookPosition =
    playbackBook && currentTrack
      ? trackOffsetSeconds(playbackBook, activeTrackIndex) + displayTrackPosition
      : 0;
  const displayBookRemainingSeconds = bookDuration > 0
    ? Math.max(0, bookDuration - displayBookPosition)
    : null;
  const bookCompletionPercent = bookDuration > 0
    ? Math.min(100, Math.floor((boundedBookPosition / bookDuration) * 100))
    : null;
  const chapterSegments = useMemo(() => {
    if (!playbackBook || !bookDuration || playbackBook.chapters.length === 0) {
      return [];
    }
    return buildChapterSegments(playbackBook.chapters, bookDuration);
  }, [bookDuration, playbackBook]);
  const selectedChapterSegments = useMemo(
    () =>
      selectedBook
        ? buildChapterSegments(
            selectedBook.chapters,
            selectedBook.durationSeconds ?? durationFromTracks(selectedBook)
          )
        : [],
    [selectedBook]
  );
  const activeChapter = chapterAtBookPosition(chapterSegments, bookPosition);
  const chapterElapsed = activeChapter
    ? Math.max(0, bookPosition - activeChapter.startSeconds)
    : position;
  const displayChapterElapsed = activeChapter
    ? Math.max(0, displayBookPosition - activeChapter.startSeconds)
    : displayTrackPosition;
  const chapterDuration = activeChapter
    ? Math.max(1, activeChapter.endSeconds - activeChapter.startSeconds)
    : Math.max(1, sliderMax);
  const activeChapterIndex = activeChapter
    ? chapterSegments.findIndex((chapter) => chapter.id === activeChapter.id)
    : -1;
  const currentTrackChapterKey = currentTrack
    ? JSON.stringify(
        chapterSegments
          .filter((chapter) => chapter.trackId === currentTrack.id)
          .map((chapter) => [
            chapter.id,
            chapter.title,
            chapter.startSeconds,
            chapter.endSeconds
          ])
      )
    : "";
  const hasPreviousChapter = activeChapterIndex > 0 || chapterElapsed > 5;
  const hasNextChapter = activeChapterIndex >= 0 && activeChapterIndex < chapterSegments.length - 1;
  const upcomingChapters = activeChapterIndex >= 0
    ? chapterSegments.slice(activeChapterIndex + 1, activeChapterIndex + 4)
    : chapterSegments.slice(0, 3);
  const isViewingPlayingBook = !!selectedBook && !!playbackBook && selectedBook.id === playbackBook.id;
  const playbackGain = playbackBook ? bookGains[playbackBook.id] ?? BOOK_GAIN_DEFAULT : BOOK_GAIN_DEFAULT;
  const selectedGain = selectedBook ? bookGains[selectedBook.id] ?? BOOK_GAIN_DEFAULT : BOOK_GAIN_DEFAULT;
  // Above unity the boost needs an engine that can supply it: AVPlayer's mixer
  // on iOS, or a Web Audio chain everywhere else — and that chain can only tap
  // a stream this page is allowed to read. That is a property of the book's own
  // source rather than of the server: a downloaded or device-imported book
  // plays from the app's own origin and is boostable even when the remote
  // stream it came from would not be.
  function bookCanBoost(book: Book | null) {
    if (nativeAudio) return true;
    if (!book) return false;
    if (book.source === "device" || downloadedBookIds.has(book.id)) return true;
    const [firstTrack] = book.tracks;
    return !!firstTrack && streamCanBeBoosted(mediaUrl(firstTrack.streamUrl));
  }

  const selectedCanBoost = bookCanBoost(selectedBook);
  const playbackCanBoost = bookCanBoost(playbackBook);
  const selectedReadalongUrl = selectedBook?.readingFile
    ? readalongUrl(selectedBook.readingFile.url)
    : null;
  const selectedSyncMap = selectedBook ? syncMaps[selectedBook.id] ?? null : null;
  const selectedSyncFragments =
    isViewingPlayingBook && selectedSyncMap && selectedSyncMap.fragments.length > 0
      ? selectedSyncMap.fragments
      : null;
  const canGenerateSync =
    currentUser.isAdmin &&
    !!alignmentStatus?.enabled &&
    selectedBook?.readingFile?.extension === "epub";

  async function startSyncGeneration(book: Book) {
    setSyncJobError(null);
    try {
      const created = await generateSyncMap(book.id);
      setSyncJob({
        id: created.jobId,
        kind: "sync-generate",
        targetId: book.id,
        status: "running",
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

  const loadBooks = useCallback(async () => {
    const requestGeneration = ++libraryRequestGenerationRef.current;
    const isCurrentRequest = () => requestGeneration === libraryRequestGenerationRef.current;
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
      setPlaybackBookId((existing) => {
        const preferred = existing ?? readStoredBookId(currentUser.id, "playbackBookId");
        const next = resolveActivePlaybackBookId(nextBooks, preferred);
        const preferredIsPresent = !!preferred && nextBooks.some((book) => book.id === preferred);
        // A device-only first paint may not contain the stored server book.
        // Wait for the cached/live shelf before deciding that session vanished.
        if (!next && preferred && !preferredIsPresent && !definitive) return existing;
        if (!startupNavigationResolved.current && (next || preferredIsPresent || definitive)) {
          startupNavigationResolved.current = true;
          if (native) {
            setNativeTab(next ? "reading" : "shelf");
            // A restored Reading tab still needs its saved track and position.
            // Revealing it here paints the first track at 0:00 before the
            // progress effect below resolves the real checkpoint.
            if (!next) {
              startupViewReadyRef.current = true;
              setStartupViewReady(true);
            }
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
    } catch {
      const cachedServer = hydratedServerBooks.length
        ? hydratedServerBooks
        : withoutCachedBookGains(await getCachedLibrary(currentUser.id));
      if (!isCurrentRequest()) return;
      const cached = mergeDeviceAndServerBooks(cachedServer, deviceBooks);
      setIsOffline(true);
      applyLoadedBooks(cached, true);
      if (cached.length) {
        setError("Offline mode — showing downloaded books and cached library.");
      } else {
        setError("The audiobook server is not reachable.");
      }
    } finally {
      if (isCurrentRequest()) setIsLoading(false);
    }
  }, [currentUser.id, isOperaLibre, localMode, native]);

  useEffect(() => {
    if (!libationBooks.length) return;
    setBooks((current) => {
      const enriched = enrichBooksFromLibation(current, libationBooks);
      if (enriched !== current && isNativeApp()) {
        void cacheLibrary(
          currentUser.id,
          enriched.filter((book) => book.source !== "device")
        );
      }
      return enriched;
    });
  }, [currentUser.id, libationBooks]);

  useEffect(() => {
    if (!isNativeApp() || !books.length) return;
    void Promise.all(books.map(async (book) => [book.id, await isBookDownloaded(book)] as const))
      .then((states) => setDownloadedBookIds(new Set(states.filter(([, ready]) => ready).map(([id]) => id))));
    // Keyed on ids: re-statting every downloaded file each time a progress
    // save rebuilds `books` kept the iOS filesystem busy for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookIdsKey]);

  // Reattach the UI to persisted native jobs after a relaunch. Enqueueing is
  // idempotent, so this also supplies file metadata needed to recover jobs
  // created by older builds without duplicating their URLSession tasks.
  useEffect(() => {
    if (!isNativeApp() || !books.length) return;
    let cancelled = false;
    void Promise.all(books.map(async (book) => {
      const status = await getBookBackgroundDownloadStatus(book).catch(() => null);
      return { book, status };
    })).then((entries) => {
      if (cancelled) return;
      for (const { book, status } of entries) {
        if (status?.state === "queued" || status?.state === "running") {
          void downloadForOffline(book);
        }
      }
    });
    return () => { cancelled = true; };
    // Stable ids prevent progress saves from repeatedly reattaching the queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookIdsKey]);

  useEffect(() => {
    let active = true;
    let resolvedUrl: string | null = null;
    setOfflineSource(null);
    if (isNativeApp() && playbackBook && currentTrack) {
      const trackId = currentTrack.id;
      void getOfflineTrackUrl(playbackBook, currentTrack)
        .catch(() => null)
        .then((url) => {
          resolvedUrl = url;
          if (active) setOfflineSource({ trackId, url });
          else releaseOfflineMediaUrl(url);
        });
    }
    return () => {
      active = false;
      releaseOfflineMediaUrl(resolvedUrl);
    };
    // Keyed on ids: resetting offlineSource on identity churn blanked the
    // <audio> src mid-playback (native), stopping the book seconds after play.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackKey, playbackBookKey]);

  useEffect(() => {
    let active = true;
    nativeAudioQueueRef.current = [];
    if (!nativeAudio || !playbackBook || !currentTrack) {
      return;
    }
    const preferLocalFiles =
      playbackBook.source === "device"
      || !!playbackBook.deviceBookId
      || playbackBookDownloaded;
    void Promise.all(
      playbackBook.tracks.slice(activeTrackIndex).map(async (track, queueIndex) => {
        const localUrl = preferLocalFiles
          ? await getOfflineTrackUrl(playbackBook, track).catch(() => null)
          : null;
        const trackOffset = trackOffsetSeconds(playbackBook, activeTrackIndex + queueIndex);
        return {
          url: localUrl ?? mediaUrl(track.streamUrl),
          trackId: track.id,
          bookOffsetSeconds: trackOffset,
          title: track.title,
          artist: playbackBook.author ?? "Audiobook",
          album: playbackBook.title,
          chapters: chapterSegments
            .filter((chapter) => chapter.trackId === track.id)
            .map((chapter) => ({
              title: chapter.title,
              startSeconds: chapter.startSeconds - trackOffset,
              durationSeconds: chapter.durationSeconds
            }))
        } satisfies NativeAudioQueueTrack;
      })
    ).then((queue) => {
      if (!active) return;
      nativeAudioQueueRef.current = queue;
      audioRef.current?.dispatchEvent(new Event("operalibre-native-queue-change"));
    });
    return () => {
      active = false;
    };
    // Stable ids intentionally keep queue construction off progress-object
    // churn while still rebuilding it for a real track transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTrackIndex,
    currentTrackKey,
    nativeAudio,
    playbackBookKey,
    playbackBookDownloaded
  ]);

  // Autoplay requested while the audio source was still resolving (native disk
  // lookup): start playback as soon as the source lands.
  useEffect(() => {
    if (!streamUrl || !wantsAutoplayRef.current) {
      return;
    }
    wantsAutoplayRef.current = false;
    window.setTimeout(() => startPlayback(audioRef.current), 0);
  }, [streamUrl]);

  useEffect(() => {
    void loadBooks();
  }, [loadBooks]);

  useEffect(() => {
    writeStoredBookId(currentUser.id, "selectedBookId", selectedBookId);
  }, [currentUser.id, selectedBookId]);

  useEffect(() => {
    setDescriptionExpanded(false);
  }, [selectedBookId]);

  useEffect(() => {
    writeStoredBookId(currentUser.id, "playbackBookId", playbackBookId);
  }, [currentUser.id, playbackBookId]);

  useEffect(() => {
    if (!selectedBook?.readingFile) {
      setReadalongOpen(false);
    }
  }, [selectedBook?.readingFile]);

  useEffect(() => {
    if (!currentUser.isAdmin) {
      return;
    }
    void getAlignmentStatus()
      .then(setAlignmentStatus)
      .catch(() => setAlignmentStatus(null));
  }, [currentUser.isAdmin]);

  const syncMapBookId = readalongOpen && selectedBook?.syncFile ? selectedBook.id : null;
  useEffect(() => {
    if (!syncMapBookId || syncMaps[syncMapBookId] !== undefined) {
      return;
    }
    let cancelled = false;
    void getSyncMap(syncMapBookId)
      .then((map) => {
        if (!cancelled) {
          setSyncMaps((existing) => ({ ...existing, [syncMapBookId]: map }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSyncMaps((existing) => ({ ...existing, [syncMapBookId]: null }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [syncMapBookId, syncMaps]);

  useEffect(() => {
    if (!syncJob || syncJob.status !== "running") {
      return;
    }
    const timer = window.setInterval(() => {
      void getJob(syncJob.id)
        .then((job) => {
          setSyncJob(job);
          if (job.status === "completed") {
            setSyncMaps({});
            void loadBooks();
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [loadBooks, syncJob]);

  const loadLibationStatus = useCallback(async () => {
    if (!isOperaLibre || (!currentUser.isAdmin && !native)) {
      setLibationStatus(null);
      return;
    }
    try {
      if (currentUser.isAdmin) {
        setLibationStatus(await getLibationStatus());
      } else {
        const access = await getLibationAccess();
        setLibationStatus({
          enabled: access.enabled,
          cliPath: null,
          libationFilesDir: null,
          libraryRoot: "",
          accounts: [],
          authenticated: access.enabled,
          message: access.enabled ? null : "Libation is not configured on this server.",
          autoRefreshHours: access.autoRefreshHours,
          manualRefreshesPerHour: access.manualRefreshesPerHour
        });
      }
    } catch {
      setLibationStatus(null);
    }
  }, [currentUser.isAdmin, isOperaLibre, native]);

  const loadLibationBooks = useCallback(async (clearError = true) => {
    setLibationLoading(true);
    if (clearError) {
      setLibationError(null);
    }
    try {
      const nextBooks = await getLibationBooks();
      setLibationBooks(nextBooks);
      const confirmedAsins = new Set(nextBooks.filter((book) => !!book.localBookId).map((book) => book.catalogId));
      setLibationFinalizingAsins((current) => {
        const next = new Set([...current].filter((asin) => !confirmedAsins.has(asin)));
        return next.size === current.size ? current : next;
      });
      setLibationBooksLoaded(true);
      await loadLibationStatus();
    } catch {
      setLibationError("Libation books could not be loaded.");
      setLibationBooksLoaded(true);
    } finally {
      setLibationLoading(false);
    }
  }, [loadLibationStatus]);

  useEffect(() => {
    if (currentUser.isAdmin || native) {
      void loadLibationStatus();
    }
  }, [currentUser.isAdmin, loadLibationStatus, native]);

  useEffect(() => {
    if (!currentUser.isAdmin || !isOperaLibre) {
      return;
    }
    const timer = window.setInterval(() => void loadLibationStatus(), 60_000);
    return () => window.clearInterval(timer);
  }, [currentUser.isAdmin, isOperaLibre, loadLibationStatus]);

  useEffect(() => {
    if (!currentUser.isAdmin) {
      return;
    }
    let cancelled = false;
    const generation = libationJobsGenerationRef.current;
    void listJobs()
      .then((jobs) => {
        if (cancelled || generation !== libationJobsGenerationRef.current) {
          return;
        }
        const next = reconcileLibationJobs(jobs, libationJobsRef.current);
        libationJobsRef.current = next;
        setLibationJobs(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [currentUser.isAdmin]);

  useEffect(() => {
    if (librarySource === "audible" && libationStatus?.enabled && !libationBooksLoaded && !libationLoading) {
      void loadLibationBooks();
    }
  }, [libationBooksLoaded, libationLoading, libationStatus?.enabled, librarySource, loadLibationBooks]);

  useEffect(() => {
    if (
      librarySource !== "audible" ||
      currentUser.libationAccess !== "approval"
    ) {
      return;
    }
    let cancelled = false;
    const refreshRequests = () => {
      void listLibationRequests()
        .then((requests) => {
          if (cancelled) return;
          const ownRequests = requests.filter((request) => request.userId === currentUser.id);
          const prior = libationDownloadRequestsRef.current;
          const newlyCompletedAsins = libationRequestsLoadedRef.current
            ? ownRequests
                .filter(
                  (request) =>
                    request.status === "completed" &&
                    prior.find((item) => item.id === request.id)?.status !== "completed"
                )
                .map((request) => request.catalogId ?? (request.profileId ? `${request.profileId}:${request.asin}` : libationBooks.find((book) => book.asin === request.asin)?.catalogId ?? `legacy:${request.asin}`))
            : [];
          libationDownloadRequestsRef.current = ownRequests;
          libationRequestsLoadedRef.current = true;
          setLibationDownloadRequests(ownRequests);
          const approvedAsins = ownRequests
            .filter((request) => request.status === "approved" && request.jobId)
            .map((request) => request.catalogId ?? (request.profileId ? `${request.profileId}:${request.asin}` : libationBooks.find((book) => book.asin === request.asin)?.catalogId ?? `legacy:${request.asin}`));
          const activeAsins = [...approvedAsins, ...newlyCompletedAsins];
          if (activeAsins.length > 0) {
            setLibationFinalizingAsins((current) => new Set([...current, ...activeAsins]));
          }
        })
        .catch(() => undefined);
    };
    refreshRequests();
    const timer = window.setInterval(refreshRequests, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currentUser.id, currentUser.libationAccess, libationBooks, librarySource]);

  useEffect(() => {
    if (!libationJobs.some(isPendingJob)) {
      return;
    }

    let cancelled = false;
    let requestInFlight = false;
    const timer = window.setInterval(() => {
      if (requestInFlight) {
        return;
      }
      requestInFlight = true;
      const generation = libationJobsGenerationRef.current;
      const previous = libationJobsRef.current;
      const jobsRequest = currentUser.isAdmin
        ? listJobs()
        : Promise.all(previous.filter(isPendingJob).map((job) => getJob(job.id))).then((updates) => {
            const updatesById = new Map(updates.map((job) => [job.id, job]));
            return previous.map((job) => updatesById.get(job.id) ?? job);
          });
      void jobsRequest
        .then((jobs) => {
          if (cancelled || generation !== libationJobsGenerationRef.current) {
            return;
          }
          const next = reconcileLibationJobs(jobs, previous);
          const nextById = new Map(next.map((job) => [job.id, job]));
          const finishedJobs = previous
            .map((job) => nextById.get(job.id))
            .filter((current): current is JobStatus => !!current)
            .filter((current) => {
              const prior = previous.find((job) => job.id === current.id);
              return !!prior && isPendingJob(prior) && !isPendingJob(current);
            });
          libationJobsRef.current = next;
          setLibationJobs(next);
          if (finishedJobs.length > 0) {
            const completedAsins = finishedJobs.flatMap((job) => {
              if (job.status !== "completed") {
                return [];
              }
              if (job.kind === "libation-liberate" && job.targetId) {
                return [job.targetId];
              }
              if (job.kind === "libation-liberate-all") {
                return libationBooks.filter((book) => !book.localBookId).map((book) => book.catalogId);
              }
              return [];
            });
            if (completedAsins.length > 0) {
              const now = Date.now();
              for (const asin of completedAsins) {
                libationFinalizationStartedRef.current.set(asin, now);
              }
              setLibationFinalizingAsins((current) => new Set([...current, ...completedAsins]));
            }
            void loadBooks();
            if (!next.some(isPendingJob)) {
              void loadLibationBooks(false);
            }
            const failedJob = finishedJobs.find((job) => job.status === "failed");
            if (failedJob) {
              setLibationError(jobSummary(failedJob));
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          requestInFlight = false;
        });
    }, 1200);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currentUser.isAdmin, libationJobs, loadBooks, loadLibationBooks]);

  useEffect(() => {
    if (libationJobs.some(isPendingJob)) {
      return;
    }
    const remainingAsins = new Set(
      [...libationFinalizingAsins].filter(
        (asin) =>
          !libationFinalizationFailures.has(asin) &&
          !libationBooks.some((book) => book.catalogId === asin && !!book.localBookId)
      )
    );
    if (remainingAsins.size === 0) {
      return;
    }
    for (const asin of remainingAsins) {
      if (!libationFinalizationStartedRef.current.has(asin)) {
        libationFinalizationStartedRef.current.set(asin, Date.now());
      }
    }

    let cancelled = false;
    let checking = false;
    let timer: number | null = null;
    const confirmDownloads = async () => {
      if (checking || remainingAsins.size === 0) {
        return;
      }
      checking = true;
      try {
        const nextBooks = await getLibationBooks();
        if (cancelled) {
          return;
        }
        setLibationBooks(nextBooks);
        setLibationBooksLoaded(true);

        const now = Date.now();
        const failedAsins: string[] = [];
        let confirmedDownload = false;
        for (const asin of remainingAsins) {
          const localBook = nextBooks.find((book) => book.catalogId === asin && !!book.localBookId);
          if (localBook) {
            confirmedDownload = true;
            remainingAsins.delete(asin);
            libationFinalizationStartedRef.current.delete(asin);
            setLibationFinalizingAsins((current) => {
              const next = new Set(current);
              next.delete(asin);
              return next;
            });
            continue;
          }
          const startedAt = libationFinalizationStartedRef.current.get(asin) ?? now;
          const timeout = currentUser.isAdmin
            ? LIBATION_CONFIRM_TIMEOUT_MS
            : LIBATION_READER_DOWNLOAD_TIMEOUT_MS;
          if (now - startedAt >= timeout) {
            failedAsins.push(asin);
            remainingAsins.delete(asin);
            libationFinalizationStartedRef.current.delete(asin);
          }
        }

        if (confirmedDownload) {
          window.setTimeout(() => void loadBooks(), 250);
        }

        if (failedAsins.length > 0) {
          setLibationFinalizingAsins((current) => {
            const next = new Set(current);
            for (const asin of failedAsins) {
              next.delete(asin);
            }
            return next;
          });
          setLibationFinalizationFailures((current) => new Set([...current, ...failedAsins]));
          const failedTitle = libationBooks.find((book) => book.asin === failedAsins[0])?.title;
          setLibationError(
            `${failedTitle ?? "The title"} never appeared in your library. Decryption or import may have failed.`
          );
        }
        if (remainingAsins.size === 0 && timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
      } catch {
        // Keep the title in Adding while the server is temporarily unreachable;
        // a connection failure is not evidence that decryption failed.
      } finally {
        checking = false;
      }
    };

    void confirmDownloads();
    timer = window.setInterval(() => void confirmDownloads(), 1500);
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearInterval(timer);
      }
    };
  }, [currentUser.isAdmin, libationFinalizationFailures, libationFinalizingAsins, libationJobs, loadBooks]);

  useEffect(() => {
    if (!playbackBook) {
      return;
    }

    let cancelled = false;
    restoredProgressBookId.current = null;
    if (!startupViewReadyRef.current) startupProgressAppliedRef.current = false;
    if (explicitSessionStartBookIdRef.current === playbackBook.id) {
      // A shelf play/restart chose this pending position deliberately. It is
      // the beginning of a new session, not a request to restore the previous
      // session (especially important for "Read it again" on a finished book).
      explicitSessionStartBookIdRef.current = null;
      restoredProgressBookId.current = playbackBook.id;
      return () => {
        cancelled = true;
      };
    }
    playbackTouchedRef.current = false;
    const armResumeAutoplay = resumeAutoplayBookIdRef.current === playbackBook.id;
    resumeAutoplayBookIdRef.current = null;
    const restoreVersion = progressMutationVersion.current;
    const restoreActionVersion = playbackActionVersionRef.current;
    if (armResumeAutoplay) resumeReconciliationBookIdRef.current = playbackBook.id;
    const applyProgress = (progress: Progress | null) => {
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
      // Show the restored time immediately; the media element seeks to it
      // once metadata loads.
      setPosition(location?.positionSeconds ?? 0);
      const restoredTrack = location
        ? playbackBook.tracks.find((track) => track.id === location.trackId)
        : playbackBook.tracks[0];
      setDuration(restoredTrack?.durationSeconds ?? 0);
      restoredProgressBookId.current = playbackBook.id;
      startupProgressAppliedRef.current = true;
      // The restored track and position are now known, so a queued shelf
      // Resume can safely play: both places that consume this flag apply the
      // pending seek before starting.
      if (armResumeAutoplay) {
        playWhenTrackLoads.current = true;
        resumeAutoplayPendingRef.current = true;
      }
      // These updates are batched. The short quiet window also absorbs a
      // fresher server reply or native metadata before the overlay leaves.
      scheduleStartupReveal();
    };

    void (async () => {
      const recoveredNative = nativeAudio
        ? await getNativeAudioRecovery(nativeAudioRecoveryScope(currentUser.id, playbackBook.id)).catch(() => null)
        : null;
      const recoveryTrack = recoveredNative
        ? playbackBook.tracks.find((track) => track.id === recoveredNative.trackId)
        : null;
      const nativeProgress: Progress | null = recoveredNative && recoveryTrack
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
      const checkpoint = readProgressCheckpoint(
        window.localStorage,
        getServerStorageKey(),
        currentUser.id,
        playbackBook.id
      );
      const cached = await getCachedProgress(currentUser.id, playbackBook.id).catch(() => null);
      if (playbackBook.source === "device") {
        const local = freshestProgress(device, checkpoint, cached, nativeProgress);
        if (local) updateBookProgress(playbackBook.id, local);
        applyProgress(local);
        return;
      }
      const deviceBook = deviceBookId ? getDeviceBooks().find((book) => book.id === deviceBookId) : null;
      const deviceTrackIndex = deviceBook?.tracks.findIndex((track) => track.id === device?.trackId) ?? -1;
      const mappedServerTrack = deviceTrackIndex >= 0 ? playbackBook.tracks[deviceTrackIndex] : null;
      const mappedDevice = device && mappedServerTrack
        ? { ...device, bookId: playbackBook.id, trackId: mappedServerTrack.id }
        : null;
      // Progress saved on the device or while disconnected can be newer than
      // the server. Resume from the freshest copy and converge the server.
      const freshestLocal = freshestProgress(mappedDevice, checkpoint, cached, nativeProgress);
      // The summary embedded in the library listing is also the server's
      // copy. It backstops a failed or empty progress fetch — without it, a
      // fresh install that hits one failed request opens the book at zero and
      // the next save wipes the real position on the server too.
      const listed = progressFromBookSummary(playbackBook.id, playbackBook.progress);
      // Resume from the best copy already on the device before asking the
      // server. Waiting on that request left the player at 0:00 for the whole
      // network timeout whenever the server was unreachable. A near-zero
      // local copy that outranks substantial listed progress by timestamp
      // alone is distrusted the same way the reconciliation below distrusts
      // it — showing 0:00 here is what tempts a listener to "fix" it.
      const optimistic = isSuspectProgressReset(freshestLocal, listed)
        ? listed
        : freshestProgress(freshestLocal, listed);
      applyProgress(optimistic);
      let server: Progress | null = null;
      let serverReachable = true;
      // One failed fetch must not strand this device on a stale or empty
      // copy — that is how a second device ends up at 0:00 and later pushes
      // it over real progress. Retry briefly before reconciling.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          server = await getProgress(playbackBook.id);
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
      const suspectLocalReset = isSuspectProgressReset(freshestLocal, lastKnownServer);
      const localIsNewer =
        !!freshestLocal &&
        !suspectLocalReset &&
        (!lastKnownServer || progressTimestamp(freshestLocal.updatedAt) > progressTimestamp(lastKnownServer.updatedAt));
      let target = localIsNewer ? freshestLocal : lastKnownServer ?? freshestLocal;
      let serverCorrectedLocal = false;
      if (localIsNewer) {
        updateBookProgress(playbackBook.id, freshestLocal);
        if (serverReachable) {
          const saved = await saveProgress(
            playbackBook.id,
            freshestLocal,
            { isPaused: true }
          ).catch(() => null);
          if (cancelled || playbackActionVersionRef.current !== restoreActionVersion) return;
          if (saved) {
            const currentCheckpoint = readProgressCheckpoint(
              window.localStorage,
              getServerStorageKey(),
              currentUser.id,
              playbackBook.id
            );
            if (progressAfterSave(currentCheckpoint, freshestLocal, saved) === saved) {
              serverCorrectedLocal = saved.trackId !== freshestLocal.trackId
                || Math.abs(saved.bookPositionSeconds - freshestLocal.bookPositionSeconds) > 0.01;
              storeCanonicalServerProgress(playbackBook, saved);
              target = saved;
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
        (target && progressTimestamp(target.updatedAt) > progressTimestamp(optimistic.updatedAt))
      ) {
        applyProgress(target);
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

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!nativeAudio || !audio || !playbackBook || !currentTrack) return;
    return attachNativeAudioPlayer(
      audio,
      (message) => setPlaybackError(message),
      () => setNativeAudioFailed(true),
      {
        scopeKey: nativeAudioRecoveryScope(currentUser.id, playbackBook.id),
        trackId: currentTrack.id,
        bookOffsetSeconds: trackOffsetSeconds(playbackBook, activeTrackIndex),
        queue: () => nativeAudioQueueRef.current,
        gain: () => playbackGainRef.current
      },
      (trackId, positionSeconds, _bookPositionSeconds, nativeIsPlaying) => {
        if (!playbackBook.tracks.some((track) => track.id === trackId)) return;
        // getNativeAudioRecovery already participated in startup
        // reconciliation. A paused trackChanged event emitted while AVPlayer
        // rebuilds its queue is not a listener action and must not overwrite
        // the restored checkpoint or make the player oscillate.
        if (!shouldAcceptNativeTrackChange(startupViewReadyRef.current, nativeIsPlaying)) return;
        markPlaybackTouched();
        nativePlaybackPlayingRef.current = nativeIsPlaying;
        playWhenTrackLoads.current = nativeIsPlaying;
        wantsAutoplayRef.current = nativeIsPlaying;
        setCurrentTrackId(trackId);
        setPendingSeek({ trackId, positionSeconds });
        setPosition(positionSeconds);
        setDuration(playbackBook.tracks.find((track) => track.id === trackId)?.durationSeconds ?? 0);
        scheduleStartupReveal();
      },
      () => {
        markPlaybackTouched(true);
        void persistProgress();
      }
    );
  }, [currentTrackKey, currentUser.id, nativeAudio, playbackBookKey]);

  // Progress often arrives after preload has already emitted loadedmetadata.
  // Apply that late checkpoint as soon as the target media element is ready.
  useEffect(() => {
    const audio = audioRef.current;
    if (
      pendingSeek === null ||
      pendingSeek.trackId !== currentTrackKey ||
      !audio ||
      audio.readyState < HTMLMediaElement.HAVE_METADATA ||
      !audioSourceMatches(audio, streamUrl)
    ) {
      return;
    }
    const restoredPosition = Math.max(
      0,
      Math.min(pendingSeek.positionSeconds, audio.duration || pendingSeek.positionSeconds)
    );
    setPlaybackPosition(audio, restoredPosition);
    setPosition(restoredPosition);
    setPendingSeek(null);
    // Mirrors onLoadedMetadata. A queued autoplay whose element had already
    // loaded this exact source gets no second metadata event, so without this
    // a shelf Resume onto the track that was already staged never starts.
    if (playWhenTrackLoads.current) {
      playWhenTrackLoads.current = false;
      startPlayback(audio, !resumeAutoplayPendingRef.current);
      resumeAutoplayPendingRef.current = false;
    }
  }, [currentTrackKey, pendingSeek, streamUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    applyPlaybackVolume(audio);
    if (gainChain().isAttachedTo(audio)) gainChain().setGain(playbackGain);
    if (nativeAudio) void setNativeAudioGain(playbackGain).catch(() => undefined);
  }, [volume, playbackGain, nativeAudio]);

  playbackGainRef.current = playbackGain;

  // The server's copy is what follows the listener between devices, so a boost
  // set on the phone is already applied the first time the book opens here.
  // Backends with nowhere to store it omit the field entirely and leave the
  // local mirror alone.
  useEffect(() => {
    setBookGains((existing) => {
      const merged = mergeServerBookGains(existing, books, localGainWritesRef.current);
      if (!merged) return existing;
      writeStoredBookGains(currentUser.id, merged);
      return merged;
    });
  }, [books]);

  useEffect(() => {
    let active = true;
    const book = playbackBook;
    if (!book || (!book.coverArtUrl && !book.localCoverPath)) {
      setMediaArtworkUrl(null);
      return;
    }
    const networkArtwork = book.coverArtUrl ? mediaUrl(book.coverArtUrl) : null;
    if (!native) {
      setMediaArtworkUrl(networkArtwork);
      return;
    }
    void getOfflineCoverUrl(book).then((localArtwork) => {
      if (active) setMediaArtworkUrl(localArtwork ?? networkArtwork);
    });
    return () => {
      active = false;
    };
  }, [native, playbackBookKey, playbackBook?.coverArtUrl, playbackBook?.localCoverPath]);

  useEffect(() => {
    if (!playbackBook || !currentTrack) {
      return;
    }

    const trackOffset = trackOffsetSeconds(playbackBook, activeTrackIndex);
    const nowPlaying = {
      title: activeChapter?.title ?? currentTrack.title,
      artist: playbackBook.author ?? "Audiobook",
      album: playbackBook.title,
      artworkUrl: mediaArtworkUrl ?? undefined,
      chapterStartSeconds: activeChapter
        ? activeChapter.startSeconds - trackOffset
        : undefined,
      chapterDurationSeconds: activeChapter?.durationSeconds,
      chapters: chapterSegments
        .filter((chapter) => chapter.trackId === currentTrack.id)
        .map((chapter) => ({
          title: chapter.title,
          // AVPlayer's clock is relative to the current audio file, while
          // chapter markers are relative to the whole book.
          startSeconds: chapter.startSeconds - trackOffset,
          durationSeconds: chapter.durationSeconds
        }))
    };
    if (nativeAudio) {
      void updateNativeAudioNowPlaying(nowPlaying).catch((error) => {
        setPlaybackError(error instanceof Error ? error.message : "Could not update iOS Now Playing.");
      });
      return;
    }
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: nowPlaying.title,
      artist: nowPlaying.artist,
      album: nowPlaying.album,
      artwork: mediaArtworkUrl
        ? [
            { src: mediaArtworkUrl, sizes: "512x512", type: playbackBook.coverArtContentType ?? "image/jpeg" }
          ]
        : undefined
    });
    navigator.mediaSession.setActionHandler("play", () => startPlayback(audioRef.current));
    navigator.mediaSession.setActionHandler("pause", () => pausePlayback(audioRef.current));
    navigator.mediaSession.setActionHandler("seekbackward", () => seekBy(-15));
    navigator.mediaSession.setActionHandler("seekforward", () => seekBy(30));
    navigator.mediaSession.setActionHandler("previoustrack", restartOrPreviousChapter);
    navigator.mediaSession.setActionHandler("nexttrack", nextChapter);
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime === undefined) return;
      if (activeChapter) {
        seekBookPosition(activeChapter.startSeconds + details.seekTime);
      } else {
        seekTo(details.seekTime);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeChapter?.id,
    currentTrackChapterKey,
    currentTrackKey,
    mediaArtworkUrl,
    nativeAudio,
    playbackBookKey
  ]);

  useEffect(() => {
    if (nativeAudio || !("mediaSession" in navigator) || !currentTrack) return;
    const duration = activeChapter ? chapterDuration : Math.max(1, sliderMax);
    const lockPosition = activeChapter ? chapterElapsed : position;
    if (!Number.isFinite(duration) || !Number.isFinite(lockPosition) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.max(0, Math.min(lockPosition, duration)),
        playbackRate: speed
      });
    } catch {
      // Some WebViews expose Media Session metadata without position state.
    }
  }, [activeChapter?.id, chapterDuration, chapterElapsed, currentTrackKey, nativeAudio, position, sliderMax, speed]);

  useEffect(() => {
    if (!chaptersOpen || !isViewingPlayingBook || !activeChapter) return;
    const frame = window.requestAnimationFrame(() => {
      chaptersListRef.current
        ?.querySelector<HTMLElement>(`[data-chapter-id="${activeChapter.id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeChapter?.id, chaptersOpen, isViewingPlayingBook]);

  useEffect(() => {
    if (!isPlaying || sleepRemaining <= 0) {
      if (sleepRemaining <= 0) sleepDeadlineRef.current = null;
      return;
    }

    sleepDeadlineRef.current ??= Date.now() + sleepRemaining * 1000;
    const timer = window.setInterval(() => {
      const deadline = sleepDeadlineRef.current;
      if (deadline === null) return;
      const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSleepRemaining(next);
      if (next === 0) {
        sleepDeadlineRef.current = null;
        pausePlayback(audioRef.current);
        setSleepMinutes(0);
      }
    }, 1000);

    return () => {
      window.clearInterval(timer);
      const deadline = sleepDeadlineRef.current;
      if (deadline !== null) {
        const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        setSleepRemaining(next);
        if (next === 0) setSleepMinutes(0);
        sleepDeadlineRef.current = null;
      }
    };
  }, [isPlaying, sleepRemaining > 0]);

  function configureSleepTimer(minutes: number) {
    haptic("light");
    sleepDeadlineRef.current = isPlaying && minutes > 0
      ? Date.now() + minutes * 60 * 1000
      : null;
    setSleepMinutes(minutes);
    setSleepRemaining(minutes * 60);
    setNativePlayerSheet(null);
  }

  useEffect(() => {
    const saveBeforeLeaving = () => {
      void persistProgress();
    };
    const saveWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        void persistProgress();
      }
    };

    window.addEventListener("pagehide", saveBeforeLeaving);
    document.addEventListener("visibilitychange", saveWhenHidden);

    return () => {
      window.removeEventListener("pagehide", saveBeforeLeaving);
      document.removeEventListener("visibilitychange", saveWhenHidden);
    };
  }, [playbackBook, currentTrack, activeTrackIndex]);

  function persistProgress() {
    if (
      !playbackBook ||
      restoredProgressBookId.current !== playbackBook.id ||
      !currentTrack ||
      !audioRef.current ||
      resumeReconciliationBookIdRef.current === playbackBook.id
    ) {
      return;
    }
    // Nothing moved playback since this book was restored: there is nothing
    // new to save, and writing the restored position back with a fresh
    // timestamp would let a device whose restore silently failed outrank —
    // and then erase — real progress recorded elsewhere. Opening a book and
    // closing it again must write nothing.
    if (!playbackTouchedRef.current) {
      return;
    }

    // While a seek is queued the media element does not reflect the real
    // position yet — a restore or track jump reads currentTime 0 until
    // metadata loads. Persist the seek target instead; persisting element
    // time here would overwrite the real position everywhere, including the
    // server's only copy.
    const pending = pendingSeekRef.current;
    if (pending && pending.trackId !== currentTrack.id) {
      return;
    }
    const trackPosition = pending
      ? Math.max(0, pending.positionSeconds)
      : Number.isFinite(audioRef.current.currentTime)
        ? Math.max(0, audioRef.current.currentTime)
        : Math.max(0, position);
    const localProgress: Progress = {
      bookId: playbackBook.id,
      trackId: currentTrack.id,
      positionSeconds: trackPosition,
      bookPositionSeconds: trackOffsetSeconds(playbackBook, activeTrackIndex) + trackPosition,
      durationSeconds: pending
        ? currentTrack.durationSeconds
        : Number.isFinite(audioRef.current.duration) ? audioRef.current.duration : currentTrack.durationSeconds,
      updatedAt: new Date().toISOString(),
      finishedOverride: playbackBook.progress?.finishedOverride ?? null
    };
    progressMutationVersion.current += 1;
    writeProgressCheckpoint(window.localStorage, getServerStorageKey(), currentUser.id, localProgress);
    void cacheProgress(currentUser.id, localProgress).catch(() => undefined);
    if (playbackBook.deviceBookId) {
      const deviceBook = getDeviceBooks().find((book) => book.id === playbackBook.deviceBookId);
      const deviceTrack = deviceBook?.tracks[activeTrackIndex];
      if (deviceTrack) saveDeviceProgress(playbackBook.deviceBookId, { ...localProgress, bookId: playbackBook.deviceBookId, trackId: deviceTrack.id });
    }
    updateBookProgress(playbackBook.id, localProgress);
    if (playbackBook.source === "device") {
      return;
    }

    const existingQueued = queuedProgressSaves.current.get(playbackBook.id);
    const intentionalSeekGeneration = Math.max(
      existingQueued?.intentionalSeekGeneration ?? 0,
      intentionalSeekGenerationRef.current.get(playbackBook.id) ?? 0
    );
    queuedProgressSaves.current.set(playbackBook.id, {
      bookId: playbackBook.id,
      progress: localProgress,
      isPaused: nativeAudio ? !nativePlaybackPlayingRef.current : audioRef.current.paused,
      intentionalSeekGeneration
    });
    void flushProgressSaveQueue();
  }

  async function flushProgressSaveQueue() {
    if (progressSaveInFlight.current) {
      return;
    }
    progressSaveInFlight.current = true;
    try {
      // A slow request must not cause a newer position to be discarded. Each
      // in-flight save is followed by the most recent checkpoint queued while
      // it was running.
      while (queuedProgressSaves.current.size > 0) {
        const entry = queuedProgressSaves.current.values().next().value as QueuedProgressSave;
        queuedProgressSaves.current.delete(entry.bookId);
        const abortController = new AbortController();
        progressSaveAbortController.current = abortController;
        try {
          const saved = await saveProgress(
            entry.bookId,
            {
              trackId: entry.progress.trackId,
              positionSeconds: entry.progress.positionSeconds,
              bookPositionSeconds: entry.progress.bookPositionSeconds,
              durationSeconds: entry.progress.durationSeconds,
              updatedAt: entry.progress.updatedAt
            },
            {
              isPaused: entry.isPaused,
              intentionalRegression:
                entry.intentionalSeekGeneration
                > (acknowledgedSeekGenerationRef.current.get(entry.bookId) ?? 0),
              intentionalSeek:
                entry.intentionalSeekGeneration
                > (acknowledgedSeekGenerationRef.current.get(entry.bookId) ?? 0),
              signal: abortController.signal
            }
          );
          acknowledgedSeekGenerationRef.current.set(
            entry.bookId,
            Math.max(
              acknowledgedSeekGenerationRef.current.get(entry.bookId) ?? 0,
              entry.intentionalSeekGeneration
            )
          );
          const local = readProgressCheckpoint(
            window.localStorage,
            getServerStorageKey(),
            currentUser.id,
            entry.bookId
          );
          const reconciled = progressAfterSave(local, entry.progress, saved);
          if (reconciled === saved) {
            // Heal future-skewed and rejected local checkpoints with the
            // server's canonical response. Without this, the same stale copy
            // wins every restart and is retried indefinitely.
            const book = books.find((candidate) => candidate.id === entry.bookId);
            if (book) storeCanonicalServerProgress(book, saved);
          }
        } catch {
          // The synchronous checkpoint and IndexedDB copy already contain the
          // position. A later playback tick or reconnect will retry the server.
        } finally {
          if (progressSaveAbortController.current === abortController) {
            progressSaveAbortController.current = null;
          }
        }
      }
    } finally {
      progressSaveInFlight.current = false;
      if (queuedProgressSaves.current.size > 0) {
        void flushProgressSaveQueue();
      }
    }
  }

  function updateBookProgress(bookId: string, saved: Progress) {
    setBooks((existing) =>
      existing.map((book) => {
        if (book.id !== bookId) {
          return book;
        }
        return {
          ...book,
          progress: summarizeBookProgress(book, saved)
        };
      })
    );
  }

  function storeCanonicalServerProgress(book: Book, saved: Progress) {
    writeProgressCheckpoint(
      window.localStorage,
      getServerStorageKey(),
      currentUser.id,
      saved
    );
    void cacheProgress(currentUser.id, saved).catch(() => undefined);
    if (book.deviceBookId) {
      const deviceBook = getDeviceBooks().find((candidate) => candidate.id === book.deviceBookId);
      const serverTrackIndex = book.tracks.findIndex((track) => track.id === saved.trackId);
      const deviceTrack = serverTrackIndex >= 0 ? deviceBook?.tracks[serverTrackIndex] : null;
      if (deviceBook && deviceTrack) {
        saveDeviceProgress(deviceBook.id, {
          ...saved,
          bookId: deviceBook.id,
          trackId: deviceTrack.id
        });
      }
    }
    updateBookProgress(book.id, saved);
  }

  function clearPlaybackSession() {
    // Completion owns the durable final position. Prevent pause/teardown
    // events from following it with a stale media-element clock.
    playbackTouchedRef.current = false;
    nativePlaybackPlayingRef.current = false;
    playWhenTrackLoads.current = false;
    wantsAutoplayRef.current = false;
    resumeAutoplayBookIdRef.current = null;
    resumeAutoplayPendingRef.current = false;
    resumeReconciliationBookIdRef.current = null;
    pausePlayback(audioRef.current);
    setPlaybackBookId(null);
    setCurrentTrackId(null);
    setPendingSeek(null);
    setPosition(0);
    setDuration(0);
    setIsPlaying(false);
    setNativePlayerSheet(null);
    setNativePlayerView("now");
    if (native) setNativeTab("shelf");
  }

  async function changeBookCompletion(
    book: Book,
    finished: boolean,
    finalProgress?: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">,
    resetToUnplayed = false
  ) {
    if (completionPendingBookId === book.id) return false;
    setCompletionPendingBookId(book.id);
    setCompletionError(null);
    try {
      if (resetToUnplayed) {
        // Stop this session from immediately writing its old media clock over
        // the deliberate reset. If a checkpoint is already in flight, let it
        // settle before the reset becomes the server's newest revision.
        playbackTouchedRef.current = false;
        queuedProgressSaves.current.delete(book.id);
        if (playbackBookId === book.id) pausePlayback(audioRef.current);
        progressSaveAbortController.current?.abort();
        while (progressSaveInFlight.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 25));
        }
        queuedProgressSaves.current.delete(book.id);
      }
      const completedProgress: Progress | null = finalProgress
        ? {
            bookId: book.id,
            ...finalProgress,
            updatedAt: new Date().toISOString(),
            finishedOverride: finished
          }
        : null;
      let summary: NonNullable<Book["progress"]>;
      if (book.source === "device") {
        const result = setDeviceBookCompletion(book, finished, finalProgress);
        summary = result.summary;
        writeProgressCheckpoint(
          window.localStorage,
          getServerStorageKey(),
          currentUser.id,
          result.progress
        );
        void cacheProgress(currentUser.id, result.progress).catch(() => undefined);
      } else {
        summary = await setBookCompletion(book, finished, finalProgress);
        if (book.deviceBookId) {
          const deviceBook = getDeviceBooks().find(
            (candidate) => candidate.id === book.deviceBookId
          );
          if (deviceBook) {
            const trackIndex = finalProgress
              ? book.tracks.findIndex((track) => track.id === finalProgress.trackId)
              : -1;
            const deviceTrack = trackIndex >= 0 ? deviceBook.tracks[trackIndex] : null;
            setDeviceBookCompletion(
              deviceBook,
              finished,
              finalProgress && deviceTrack
                ? { ...finalProgress, trackId: deviceTrack.id }
                : undefined
            );
          }
        }
      }
      if (completedProgress) {
        progressMutationVersion.current += 1;
        writeProgressCheckpoint(
          window.localStorage,
          getServerStorageKey(),
          currentUser.id,
          completedProgress
        );
        void cacheProgress(currentUser.id, completedProgress).catch(() => undefined);
      }

      setBooks((existing) => {
        const next = existing.map((candidate) =>
          candidate.id === book.id ? { ...candidate, progress: summary } : candidate
        );
        if (isNativeApp()) {
          void cacheLibrary(
            currentUser.id,
            next.filter((candidate) => candidate.source !== "device")
          ).catch(() => undefined);
        }
        return next;
      });
      if (playbackBookId === book.id && (finished || resetToUnplayed)) {
        clearPlaybackSession();
      }
      return true;
    } catch (completionFailure) {
      setCompletionError({
        bookId: book.id,
        message: completionFailure instanceof Error
          ? completionFailure.message
          : resetToUnplayed
            ? `Could not mark ${book.title} unplayed.`
            : `Could not mark ${book.title} ${finished ? "finished" : "unfinished"}.`
      });
      return false;
    } finally {
      setCompletionPendingBookId(null);
    }
  }

  function markBookUnplayed(book: Book) {
    const firstTrack = book.tracks[0];
    if (!firstTrack || completionPendingBookId === book.id) return;
    setCompletionError(null);
    setUnplayedConfirmationBookId(book.id);
  }

  async function confirmBookUnplayed(book: Book) {
    const firstTrack = book.tracks[0];
    if (!firstTrack || completionPendingBookId === book.id) return;
    haptic("light");
    const changed = await changeBookCompletion(
      book,
      false,
      {
        trackId: firstTrack.id,
        positionSeconds: 0,
        bookPositionSeconds: 0,
        durationSeconds: firstTrack.durationSeconds
      },
      true
    );
    if (changed) setUnplayedConfirmationBookId(null);
  }

  async function downloadForOffline(book: Book) {
    if (activeDownloadIdsRef.current.has(book.id)) return;
    activeDownloadIdsRef.current.add(book.id);
    const abortController = new AbortController();
    downloadAbortControllersRef.current.set(book.id, abortController);
    if (playbackBook?.id === book.id) {
      persistProgress();
    }
    setDownloadStatus(null);
    setActiveDownloads((existing) => ({
      ...existing,
      [book.id]: { bookId: book.id, title: book.title, fraction: null, state: "queued", queuedAt: Date.now() }
    }));
    try {
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
      }, abortController.signal);
      setDownloadedBookIds((existing) => new Set(existing).add(book.id));
      setDownloadStatus({ bookId: book.id, message: `${book.title} is available offline` });
    } catch (downloadError) {
      if (abortController.signal.aborted) return;
      setDownloadStatus({
        bookId: book.id,
        message: `${book.title}: ${errorMessage(downloadError, "Download failed.")}`
      });
    } finally {
      if (downloadAbortControllersRef.current.get(book.id) === abortController) {
        downloadAbortControllersRef.current.delete(book.id);
      }
      activeDownloadIdsRef.current.delete(book.id);
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
    abortController.abort();
    setDownloadStatus({ bookId: book.id, message: `${book.title} download cancelled` });
    try {
      await cancelBookOfflineDownload(book);
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
      if (!/cancel/i.test(message)) setDownloadStatus({ message });
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
    const resumePosition = removingActiveSource ? Math.max(0, audioRef.current!.currentTime) : 0;
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

  function onTimeUpdate() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    // AVPlayer can emit its initial 0:00 clock before the pending restored
    // seek reaches the media element. Keep the coherent checkpoint visible.
    const restoring = pendingSeekRef.current;
    if (restoring && restoring.trackId === currentTrackKey) {
      setPosition(restoring.positionSeconds);
      setDuration(Number.isFinite(audio.duration) ? audio.duration : duration);
      return;
    }
    setPosition(audio.currentTime);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);

    const now = Date.now();
    if (now - saveStartedAt.current >= PROGRESS_SAVE_INTERVAL_MS) {
      saveStartedAt.current = now;
      void persistProgress();
    }
  }

  // Marks that the listener moved playback in this session (and optionally
  // that the move was a deliberate seek). persistProgress writes nothing
  // until one of these has happened.
  //
  // A seek into a book that is not the one currently playing has to name that
  // book: playbackBook still points at the previous book (or nothing) until
  // the state update lands, and marking the wrong book leaves the jump
  // unflagged — the server would then bill the skipped hours as listening.
  function markPlaybackTouched(
    deliberateSeek = false,
    seekBookId?: string,
    interruptRestore = true
  ) {
    playbackTouchedRef.current = true;
    if (interruptRestore) {
      playbackActionVersionRef.current += 1;
      resumeAutoplayPendingRef.current = false;
      if (resumeReconciliationBookIdRef.current === playbackBook?.id) {
        resumeReconciliationBookIdRef.current = null;
      }
    }
    const bookId = seekBookId ?? playbackBook?.id;
    if (deliberateSeek && bookId) {
      intentionalSeekGenerationRef.current.set(
        bookId,
        (intentionalSeekGenerationRef.current.get(bookId) ?? 0) + 1
      );
    }
  }

  function gainChain() {
    return (gainChainRef.current ??= new PlaybackGainChain());
  }

  /**
   * Route the element through the boost chain, once, when this book actually
   * asks for more than its own level. Unboosted books never touch Web Audio at
   * all, which keeps the ordinary playback path exactly as it was.
   *
   * Called from user gestures wherever possible: an AudioContext first created
   * outside one starts suspended, and a suspended context makes a routed
   * element silent rather than loud.
   */
  function engageGainChain(audio: HTMLAudioElement | null | undefined, gain = playbackGain) {
    if (!audio || nativeAudio) return;
    if (!gainChain().isAttachedTo(audio)) {
      if (gain <= BOOK_GAIN_DEFAULT) return;
      if (!streamCanBeBoosted(audio.currentSrc || streamUrl)) return;
      if (!gainChain().attach(audio)) return;
    }
    gainChain().resume();
    gainChain().setGain(gain);
    audio.volume = volume;
  }

  /**
   * The device volume, and the book's gain when nothing else can carry it. The
   * element's own volume cannot exceed unity, so this path can only ever cut a
   * loud book down, never lift a quiet one.
   */
  function applyPlaybackVolume(audio: HTMLAudioElement) {
    audio.volume = nativeAudio || gainChain().isAttachedTo(audio)
      ? volume
      : Math.min(1, volume * playbackGain);
  }

  function startPlayback(
    audio: HTMLAudioElement | null | undefined,
    interruptRestore = true
  ) {
    if (!audio) return;
    markPlaybackTouched(false, undefined, interruptRestore);
    engageGainChain(audio);
    if (!nativeAudio) {
      safePlay(audio);
      return;
    }
    void playNativeAudio().catch((error) => {
      nativePlaybackPlayingRef.current = false;
      audio.muted = false;
      setNativeAudioFailed(true);
      setPlaybackError(errorMessage(error, "Native audio playback failed."));
      // Let React tear down the failed native attachment first; its cleanup
      // pauses the control element before web audio becomes authoritative.
      window.setTimeout(() => safePlay(audioRef.current), 0);
    });
  }

  function pausePlayback(audio: HTMLAudioElement | null | undefined) {
    if (!audio) return;
    if (!nativeAudio) {
      audio.pause();
      return;
    }
    nativePlaybackPlayingRef.current = false;
    setIsPlaying(false);
    void pauseNativeAudio().catch((error) => {
      audio.muted = false;
      audio.pause();
      setNativeAudioFailed(true);
      setPlaybackError(errorMessage(error, "Native audio playback could not be paused."));
    });
  }

  function setPlaybackPosition(audio: HTMLAudioElement, value: number) {
    const nextPosition = Math.max(0, Math.min(value, audio.duration || value));
    audio.currentTime = nextPosition;
    if (nativeAudio) {
      const shouldResume = nativePlaybackPlayingRef.current;
      void seekNativeAudio(nextPosition).catch((error) => {
        nativePlaybackPlayingRef.current = false;
        audio.muted = false;
        setNativeAudioFailed(true);
        setPlaybackError(errorMessage(error, "Native audio could not seek."));
        if (shouldResume) {
          // Native effect cleanup runs after this state change and may pause
          // the element, so resume only once that cleanup has completed.
          window.setTimeout(() => safePlay(audioRef.current), 0);
        }
      });
    }
    return nextPosition;
  }

  function onLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    setPlaybackError(null);
    audio.playbackRate = speed;
    // A boosted book is routed before it plays, so the lift is there from the
    // first word rather than arriving a beat after playback starts.
    engageGainChain(audio);
    applyPlaybackVolume(audio);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);

    if (
      pendingSeek !== null &&
      pendingSeek.trackId === currentTrackKey &&
      audioSourceMatches(audio, streamUrl)
    ) {
      const restoredPosition = Math.min(
        pendingSeek.positionSeconds,
        audio.duration || pendingSeek.positionSeconds
      );
      setPlaybackPosition(audio, restoredPosition);
      setPosition(restoredPosition);
      setPendingSeek(null);
    } else if (pendingSeek !== null) {
      // Ignore a late metadata event from the source being replaced. The
      // target track still owns this pending resume position.
      return;
    } else {
      setPosition(audio.currentTime);
    }
    if (playWhenTrackLoads.current) {
      playWhenTrackLoads.current = false;
      startPlayback(audio, !resumeAutoplayPendingRef.current);
      resumeAutoplayPendingRef.current = false;
    }
    if (startupProgressAppliedRef.current) scheduleStartupReveal();
  }

  function seekBy(delta: number) {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    haptic("light");
    markPlaybackTouched(true);
    const nextPosition = setPlaybackPosition(audio, audio.currentTime + delta);
    setPosition(nextPosition);
    void persistProgress();
  }

  function seekTo(value: number) {
    if (!audioRef.current) {
      return;
    }
    markPlaybackTouched(true);
    const nextPosition = setPlaybackPosition(audioRef.current, value);
    setPosition(nextPosition);
    void persistProgress();
  }

  function seekBookPositionInBook(book: Book, value: number, autoPlay = false) {
    markPlaybackTouched(true, book.id);
    if (playbackBook?.id !== book.id) explicitSessionStartBookIdRef.current = book.id;
    const targetBookDuration = book.durationSeconds ?? durationFromTracks(book);
    const clampedValue = Math.max(0, Math.min(value, targetBookDuration || value));
    let offset = 0;
    let targetTrack: Track | undefined = book.tracks[0];

    for (const track of book.tracks) {
      const trackDuration = track.durationSeconds ?? 0;
      const nextOffset = offset + Math.max(1, trackDuration);
      targetTrack = track;
      if (clampedValue < nextOffset) {
        break;
      }
      offset += trackDuration;
    }

    if (!targetTrack) {
      return;
    }

    const trackPosition = Math.max(0, clampedValue - offset);
    setPlaybackBookId(book.id);

    if (playbackBook?.id === book.id && targetTrack.id === currentTrack?.id && audioRef.current) {
      const nextPosition = setPlaybackPosition(audioRef.current, trackPosition);
      setPosition(nextPosition);
      void persistProgress();
      if (autoPlay) {
        startPlayback(audioRef.current);
      }
      return;
    }

    setCurrentTrackId(targetTrack.id);
    setPendingSeek({ trackId: targetTrack.id, positionSeconds: trackPosition });
    setPosition(trackPosition);
    playWhenTrackLoads.current = autoPlay;
    wantsAutoplayRef.current = autoPlay;
  }

  function seekBookPosition(value: number, autoPlay = false) {
    if (!playbackBook) {
      return;
    }

    seekBookPositionInBook(playbackBook, value, autoPlay);
  }

  // Start playback now if the <audio> element has a source, otherwise flag the
  // intent so the streamUrl effect starts it once the disk lookup resolves.
  function playWhenReady() {
    const audio = audioRef.current;
    if (audio?.getAttribute("src")) {
      startPlayback(audio);
      return;
    }
    wantsAutoplayRef.current = true;
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    haptic("medium");
    // No source yet (native disk lookup still resolving): calling play() on
    // an empty element silently fails — queue the intent instead, and the
    // streamUrl effect starts playback the moment the source lands.
    if (!audio.getAttribute("src")) {
      wantsAutoplayRef.current = true;
      return;
    }
    if (nativeAudio ? !nativePlaybackPlayingRef.current : audio.paused) {
      startPlayback(audio);
    } else {
      pausePlayback(audio);
    }
  }

  function selectBook(book: Book) {
    setSelectedBookId(book.id);
    setNativePlayerView(book.id === playbackBook?.id ? "now" : "details");
    if (native) {
      setChaptersOpen(book.id === playbackBook?.id && book.chapters.length > 0);
      setShowChapterJumpTop(false);
      setNativeTab("shelf");
      setNativePlayerView("details");
      playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function openBookDetails(bookId: string) {
    setSelectedBookId(bookId);
    setNativePlayerView("details");
    if (native) {
      const book = books.find((candidate) => candidate.id === bookId);
      setChaptersOpen(bookId === playbackBook?.id && !!book?.chapters.length);
      setShowChapterJumpTop(false);
      haptic("light");
      setNativeTab("shelf");
      setNativePlayerView("details");
      playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function returnToLibrary() {
    haptic("light");
    setNativePlayerView("now");
  }

  function beginBookDetailsBackSwipe(event: React.TouchEvent<HTMLElement>) {
    if (!native || nativeTab !== "shelf" || nativePlayerView !== "details") {
      return;
    }
    const touch = event.touches[0];
    bookDetailsSwipeStartRef.current = touch
      ? { clientX: touch.clientX, clientY: touch.clientY }
      : null;
  }

  function finishBookDetailsBackSwipe(event: React.TouchEvent<HTMLElement>) {
    const start = bookDetailsSwipeStartRef.current;
    bookDetailsSwipeStartRef.current = null;
    const touch = event.changedTouches[0];
    if (
      native
      && nativeTab === "shelf"
      && nativePlayerView === "details"
      && start
      && touch
      && isLeftEdgeBackSwipe(start, touch)
    ) {
      returnToLibrary();
    }
  }

  function openPlaybackView(view: "now" | "details" | "chapters") {
    if (playbackBook) {
      setSelectedBookId(playbackBook.id);
    }
    setNativeTab("reading");
    setNativePlayerView(view);
    if (view === "chapters") {
      setChaptersOpen(true);
    }
    playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }

  function selectTrack(track: Track, autoPlay = true) {
    void persistProgress();
    markPlaybackTouched(true, selectedBook?.id ?? playbackBook?.id);
    if (selectedBook && playbackBook?.id !== selectedBook.id) {
      explicitSessionStartBookIdRef.current = selectedBook.id;
    }
    setNativePlayerView("now");
    if (native) {
      setNativeTab("reading");
    }
    if (
      selectedBook?.id === playbackBook?.id &&
      track.id === currentTrack?.id &&
      audioRef.current
    ) {
      setPlaybackPosition(audioRef.current, 0);
      setPosition(0);
      if (autoPlay) {
        startPlayback(audioRef.current);
      }
      return;
    }
    if (selectedBook) {
      setPlaybackBookId(selectedBook.id);
    }
    setCurrentTrackId(track.id);
    setPendingSeek({ trackId: track.id, positionSeconds: 0 });
    setPosition(0);
    playWhenTrackLoads.current = autoPlay;
    wantsAutoplayRef.current = autoPlay;
  }

  /**
   * The shelf's primary action. Its label already promises the right thing —
   * "Resume · 6h 32m left" — and the handler has to agree. Starting the first
   * track marks a deliberate session start, which suppresses the restore
   * effect, so every in-progress book reopened at the opening credits. A
   * resume instead hands the book to that effect, which reconciles the native,
   * checkpoint, cached, listed and server copies before seeking.
   */
  function playSelectedBook(book: Book) {
    if (!shouldResumeSavedPosition(book.progress)) {
      // "Read it again" on a finished book, or one never opened: track one.
      if (book.tracks[0]) selectTrack(book.tracks[0]);
      return;
    }
    setNativePlayerView("now");
    if (native) {
      setNativeTab("reading");
    }
    if (playbackBook?.id === book.id) {
      // Already restored in this session — its live position is authoritative.
      playWhenReady();
      return;
    }
    void persistProgress();
    // Deliberately no explicit session start, no pending seek, and no autoplay
    // flag yet: the restore effect owns all three. Arming autoplay here would
    // start the first track — `currentTrack` falls back to track one while the
    // restored id is still resolving — which is the very thing being fixed.
    resumeAutoplayBookIdRef.current = book.id;
    setPlaybackBookId(book.id);
  }

  function jumpToChapter(chapter: Chapter) {
    if (!selectedBook) {
      return;
    }

    void persistProgress();
    seekBookPositionInBook(selectedBook, chapter.startSeconds, true);
    if (native) {
      setNativeTab("reading");
      setNativePlayerView("now");
      playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function jumpToChapterFromSheet(chapter: Chapter) {
    if (!playbackBook) {
      return;
    }
    haptic("light");
    void persistProgress();
    setSelectedBookId(playbackBook.id);
    seekBookPositionInBook(playbackBook, chapter.startSeconds, true);
    setNativePlayerSheet(null);
  }

  function restartOrPreviousChapter() {
    if (!playbackBook || !activeChapter) {
      seekBy(-15);
      return;
    }
    const index = chapterSegments.findIndex((chapter) => chapter.id === activeChapter.id);
    const target = chapterElapsed > 5 || index <= 0
      ? activeChapter
      : chapterSegments[index - 1];
    seekBookPositionInBook(playbackBook, target.startSeconds, true);
  }

  function nextChapter() {
    if (!playbackBook || !activeChapter) {
      seekBy(30);
      return;
    }
    const index = chapterSegments.findIndex((chapter) => chapter.id === activeChapter.id);
    const target = chapterSegments[index + 1];
    if (target) {
      seekBookPositionInBook(playbackBook, target.startSeconds, true);
    }
  }

  function playNextTrack() {
    if (!playbackBook || activeTrackIndex >= playbackBook.tracks.length - 1) {
      playWhenTrackLoads.current = false;
      setIsPlaying(false);
      if (playbackBook && currentTrack) {
        const mediaDuration = audioRef.current?.duration;
        const finalTrackPosition = Math.max(
          0,
          currentTrack.durationSeconds
            ?? (Number.isFinite(mediaDuration) ? mediaDuration! : position)
        );
        void changeBookCompletion(playbackBook, true, {
          trackId: currentTrack.id,
          positionSeconds: finalTrackPosition,
          bookPositionSeconds:
            trackOffsetSeconds(playbackBook, activeTrackIndex) + finalTrackPosition,
          durationSeconds: currentTrack.durationSeconds ?? (Number.isFinite(mediaDuration) ? mediaDuration! : null)
        });
      }
      return;
    }
    void persistProgress();
    playWhenTrackLoads.current = true;
    wantsAutoplayRef.current = true;
    setCurrentTrackId(playbackBook.tracks[activeTrackIndex + 1].id);
    const nextTrack = playbackBook.tracks[activeTrackIndex + 1];
    setPendingSeek({ trackId: nextTrack.id, positionSeconds: 0 });
    setPosition(0);
  }

  function scrollToPlayer() {
    if (native) {
      haptic("light");
      openPlaybackView("now");
      return;
    }
    if (playbackBook) {
      setSelectedBookId(playbackBook.id);
    }
    setNativePlayerView("now");
    playerPaneRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handlePlayerPaneScroll(event: React.UIEvent<HTMLElement>) {
    if (!native || nativeTab !== "shelf" || nativePlayerView !== "details" || !chaptersOpen || !isViewingPlayingBook) {
      if (showChapterJumpTop) setShowChapterJumpTop(false);
      return;
    }
    const sectionTop = trackListSectionRef.current?.offsetTop ?? Number.POSITIVE_INFINITY;
    const threshold = sectionTop + 140;
    const shouldShow = event.currentTarget.scrollTop > threshold;
    if (shouldShow !== showChapterJumpTop) setShowChapterJumpTop(shouldShow);
  }

  function jumpToPlayerTop() {
    haptic("light");
    playerPaneRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setShowChapterJumpTop(false);
  }

  function updateSpeed(value: number) {
    const normalized = normalizePlaybackSpeed(value);
    setSpeed(normalized);
    writeStoredSpeed(normalized);
  }

  function updateBookGain(book: Book, db: number) {
    const gain = bookGainFromDb(db);
    setBookGains((existing) => {
      const next = { ...existing };
      if (gain === BOOK_GAIN_DEFAULT) delete next[book.id];
      else next[book.id] = gain;
      writeStoredBookGains(currentUser.id, next);
      return next;
    });
    if (book.id === playbackBookId) {
      // This runs inside the slider's own gesture, which is the moment an
      // AudioContext is allowed to start. The new gain has to be passed in:
      // the state update behind it has not been applied to this closure yet,
      // so the very first boost would otherwise decline to build the chain.
      engageGainChain(audioRef.current, gain);
    }
    // Device books exist only on this phone, so there is no server row to sync.
    // Everything else keeps the local change even if the sync fails; the gain
    // is already audible and a retry lands with the next adjustment.
    if (book.source !== "device") {
      // Guards the book against a library payload older than this adjustment,
      // and holds it until the server echoes the value back. Clearing the guard
      // when the PUT settles would be too early: a getBooks() issued before the
      // write can still answer after it, carrying the old gain. A write that
      // never landed releases it instead — see createBookGainSync.
      gainSyncRef.current?.write(book.id, gain);
    }
  }

  function showYourLibrary() {
    setLibrarySource("local");
  }

  function openNativeTab(tab: NativeTab) {
    haptic("light");
    // Re-tapping the active Shelf tab is an escape hatch from the Audible
    // catalogue back to the listener's own library.
    if (tab === "shelf" && nativeTab === "shelf" && librarySource === "audible") {
      showYourLibrary();
    }
    setNativeTab(tab);
    if (tab === "reading" || tab === "shelf") setNativePlayerView("now");
  }

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
      setIsOffline(false);
      setSelectedBookId((existing) =>
        resolveBookId(visibleBooks, existing ?? readStoredBookId(currentUser.id, "selectedBookId"))
      );
      setPlaybackBookId((existing) =>
        resolveActivePlaybackBookId(
          visibleBooks,
          existing ?? readStoredBookId(currentUser.id, "playbackBookId")
        )
      );
      setError(null);
    } catch (refreshError) {
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
    setSelectedBookId((existing) => resolveBookId(visibleBooks, existing));
    setPlaybackBookId((existing) => {
      const next = resolveActivePlaybackBookId(visibleBooks, existing);
      if (existing && !next) {
        pausePlayback(audioRef.current);
        setCurrentTrackId(null);
        setPosition(0);
        if (native) setNativeTab("shelf");
      }
      return next;
    });
    if (libationBooksLoaded) void loadLibationBooks();
  }

  function chooseUploadFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.currentTarget.files ?? []);
    const files = chosen.filter((file) => isSupportedAudioFileName(file.name));
    const skipped = chosen.filter((file) => !isSupportedAudioFileName(file.name));
    setUploadFiles(files);
    setUploadError(
      skipped.length
        ? `Left out ${skipped.map((file) => file.name).join(", ")}: the library takes ${SUPPORTED_AUDIO_EXTENSIONS.join(", ")} files.`
        : null
    );
    if (!uploadBookName.trim() && files.length > 0) {
      setUploadBookName(files[0].name.replace(/\.[^.]+$/, ""));
    }
  }

  async function submitAudiobookUpload(event: React.FormEvent) {
    event.preventDefault();
    if (!uploadBookName.trim() || uploadFiles.length === 0) {
      setUploadError("Enter a book name and choose at least one audiobook file.");
      return;
    }

    setUploadBusy(true);
    setUploadError(null);
    const existingIds = new Set(books.map((book) => book.id));
    try {
      const nextBooks = await uploadAudiobook(uploadBookName.trim(), uploadFiles);
      const uploadedBook = nextBooks.find((book) => !existingIds.has(book.id));
      setBooks(nextBooks);
      setIsOffline(false);
      setError(null);
      if (uploadedBook) {
        setSelectedBookId(uploadedBook.id);
      }
      setLibrarySource("local");
      setUploadModalOpen(false);
      setUploadBookName("");
      setUploadFiles([]);
    } catch (error) {
      setUploadError(errorMessage(error, "The audiobook could not be uploaded."));
    } finally {
      setUploadBusy(false);
    }
  }

  function trackLibationJob(job: JobStatus) {
    // Any jobs response already in flight may have been captured before this
    // POST reached the server. Invalidate it so it cannot erase the optimistic
    // job and stop the poller.
    libationJobsGenerationRef.current += 1;
    const next = [job, ...libationJobsRef.current.filter((existing) => existing.id !== job.id)];
    libationJobsRef.current = next;
    setLibationJobs(next);
  }

  function openLibationAccountForm(account?: LibationAccount) {
    setLibationReconnectProfileId(account?.managed ? account.id : null);
    setLibationAccountLabel(account?.name || "");
    setLibationAccountId(account?.accountId || "");
    setLibationAccountLocale(account?.locale || "us");
    setLibationLoginFlow(null);
    setLibationLoginResponseUrl("");
    setLibationError(null);
    setLibationAccountFormOpen(true);
  }

  async function beginLibationAccountLogin(event: React.FormEvent) {
    event.preventDefault();
    if (!libationAccountLabel.trim() || !libationAccountId.trim()) {
      setLibationError("Enter an account label and Audible email.");
      return;
    }
    const loginWindow = isNativeApp() ? null : window.open("about:blank", "_blank");
    setLibationLoginBusy(true);
    setLibationError(null);
    try {
      const started = await startLibationAccountLogin({
        ...(libationReconnectProfileId ? { profileId: libationReconnectProfileId } : {}),
        label: libationAccountLabel.trim(),
        accountId: libationAccountId.trim(),
        locale: libationAccountLocale
      });
      setLibationLoginFlow(started);
      if (isNativeApp()) {
        try {
          await openNativeBrowser(started.loginUrl);
        } catch {
          setLibationError("The sign-in URL is ready below. Open it to continue with Audible.");
        }
      } else if (loginWindow) {
        loginWindow.opener = null;
        loginWindow.location.replace(started.loginUrl);
      } else {
        setLibationError("The sign-in URL is ready below. Open it to continue with Audible.");
      }
    } catch (error) {
      loginWindow?.close();
      setLibationError(errorMessage(error, "The Audible sign-in could not be started."));
    } finally {
      setLibationLoginBusy(false);
    }
  }

  async function finishLibationAccountLogin(event: React.FormEvent) {
    event.preventDefault();
    if (!libationLoginFlow || !libationLoginResponseUrl.trim()) {
      setLibationError("Paste the final URL from the Audible browser window.");
      return;
    }
    setLibationLoginBusy(true);
    setLibationError(null);
    try {
      const status = await completeLibationAccountLogin(
        libationLoginFlow.sessionId,
        libationLoginResponseUrl.trim()
      );
      setLibationStatus(status);
      setAudibleAccountFilter(libationLoginFlow.profileId);
      setLibationAccountFormOpen(false);
      setLibationLoginFlow(null);
      setLibationLoginResponseUrl("");
      setLibationBooksLoaded(false);
      await loadLibationBooks(false);
    } catch (error) {
      setLibationError(errorMessage(error, "Audible could not finish signing in."));
    } finally {
      setLibationLoginBusy(false);
    }
  }

  async function closeLibationAccountForm() {
    if (libationLoginFlow) {
      try {
        await cancelLibationAccountLogin(libationLoginFlow.sessionId);
      } catch {
        // The server also expires abandoned sign-in sessions automatically.
      }
    }
    setLibationAccountFormOpen(false);
    setLibationLoginFlow(null);
    setLibationLoginResponseUrl("");
  }

  async function removeLibationAccount(account: LibationAccount) {
    if (!account.managed || !window.confirm(`Remove ${account.name || account.accountId} from this server? Its Libation credentials and account-specific catalog will be deleted.`)) {
      return;
    }
    setLibationAccountBusyId(account.id);
    setLibationError(null);
    try {
      await deleteLibationAccount(account.id);
      if (audibleAccountFilter === account.id) {
        setAudibleAccountFilter("all");
      }
      await loadLibationStatus();
      await loadLibationBooks(false);
    } catch (error) {
      setLibationError(errorMessage(error, `Could not remove ${account.name || "the Audible account"}.`));
    } finally {
      setLibationAccountBusyId(null);
    }
  }

  async function startLibationSync() {
    setLibationError(null);
    setLibationRefreshPending(true);
    try {
      const created = await syncLibationLibrary();
      trackLibationJob({
        id: created.jobId,
        kind: "libation-sync",
        targetId: null,
        status: "queued",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        output: "Checking Audible for new purchases.",
        error: null
      });
    } catch (error) {
      setLibationError(errorMessage(error, "The Audible library refresh could not be started."));
    } finally {
      setLibationRefreshPending(false);
    }
  }

  async function startLiberation(book: LibationBook) {
    setLibationError(null);
    libationFinalizationStartedRef.current.delete(book.catalogId);
    setLibationFinalizingAsins((current) => {
      const next = new Set(current);
      next.delete(book.catalogId);
      return next;
    });
    setLibationFinalizationFailures((current) => {
      const next = new Set(current);
      next.delete(book.catalogId);
      return next;
    });
    setLibationRequests((current) => new Set(current).add(book.catalogId));
    try {
      let actingUser = currentUser;
      if (isOperaLibre && !demoMode && !localMode) {
        try {
          actingUser = await getMe();
          onCurrentUserChanged(actingUser);
        } catch {
          // Let the acquisition request surface a useful server or network
          // error if the account refresh is temporarily unavailable.
        }
      }
      if (actingUser.libationAccess === "approval") {
        const request = await requestLibationBook(book.asin, book.title, book.profileId);
        setLibationDownloadRequests((current) => {
          const next = [request, ...current.filter((item) => item.id !== request.id)];
          libationDownloadRequestsRef.current = next;
          libationRequestsLoadedRef.current = true;
          return next;
        });
        return;
      }
      const created = await liberateLibationBook(book.profileId, book.asin);
      if (actingUser.isAdmin) {
        trackLibationJob({
          id: created.jobId,
          kind: "libation-liberate",
          targetId: book.catalogId,
          status: "queued",
          startedAt: new Date().toISOString(),
          finishedAt: null,
          exitCode: null,
          output: `Starting liberation for ${book.title}.`,
          error: null
        });
      } else {
        libationFinalizationStartedRef.current.set(book.catalogId, Date.now());
        setLibationFinalizingAsins((current) => new Set([...current, book.catalogId]));
      }
    } catch (error) {
      setLibationError(errorMessage(error, `The download could not be started for ${book.title}.`));
    } finally {
      setLibationRequests((current) => {
        const next = new Set(current);
        next.delete(book.catalogId);
        return next;
      });
    }
  }

  async function startAllLiberation() {
    setLibationError(null);
    setLibationAllPending(true);
    try {
      const created = await liberateAllLibationBooks();
      trackLibationJob({
        id: created.jobId,
        kind: "libation-liberate-all",
        targetId: null,
        status: "queued",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        output: "Starting Audible library sync and download for all books.",
        error: null
      });
    } catch (error) {
      setLibationError(errorMessage(error, "Libation download-all could not be started."));
    } finally {
      setLibationAllPending(false);
    }
  }

  function openMetadataEditor(book: Book) {
    setMetadataForm(metadataEditorFromBook(book));
    setMetadataError(null);
    setMetadataEditOpen(true);
  }

  async function saveMetadata(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedBook || !metadataForm) {
      return;
    }

    const update = metadataUpdateFromEditor(metadataForm);
    if (!update.title) {
      setMetadataError("Title is required.");
      return;
    }

    setMetadataSaving(true);
    setMetadataError(null);
    try {
      const updatedBook = await updateBookMetadata(selectedBook.id, update);
      setBooks((existing) =>
        existing.map((book) => (book.id === updatedBook.id ? updatedBook : book))
      );
      setMetadataEditOpen(false);
      setMetadataForm(null);
    } catch (error) {
      setMetadataError(errorMessage(error, "Book info could not be saved."));
    } finally {
      setMetadataSaving(false);
    }
  }

  const showLedgerTab = native && isOperaLibre && !localMode;

  const refreshShelf = useCallback(async () => {
    if (librarySource === "audible") {
      await loadLibationBooks();
    } else {
      await loadBooks();
    }
  }, [librarySource, loadBooks, loadLibationBooks]);
  const shelfPull = usePullToRefresh(native, refreshShelf);
  const hasMiniPlayer = Boolean(playbackBook && currentTrack);

  useEffect(() => {
    const shell = shellRef.current;
    const player = miniPlayerRef.current;
    if (!native || !shell || !player) {
      shell?.style.removeProperty("--mini-player-height");
      return;
    }

    const updatePlayerHeight = () => {
      const height = Math.ceil(player.getBoundingClientRect().height);
      // Reading hides the mini-player. Retain the last non-zero measurement so
      // Shelf has the right clearance on the first frame after switching back.
      if (height > 0) shell.style.setProperty("--mini-player-height", `${height}px`);
    };
    updatePlayerHeight();
    const observer = new ResizeObserver(updatePlayerHeight);
    observer.observe(player);
    return () => {
      observer.disconnect();
      shell.style.removeProperty("--mini-player-height");
    };
  }, [hasMiniPlayer, native]);

  const userMenu = (
    <div className="user-menu" role="menu">
      <div className="user-menu-head">
        <strong>{currentUser.username}</strong>
        <span>
          {isOperaLibre
            ? localMode ? "On-device library" : demoMode ? "On-device demo" : currentUser.isOwner ? "Owner" : currentUser.isAdmin ? "Administrator" : "Reader"
            : currentUser.isAdmin ? "Jellyfin administrator" : "Jellyfin account"}
        </span>
      </div>
      {isOperaLibre && !localMode ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setUserMenuOpen(false);
            if (native) {
              openNativeTab("ledger");
            } else {
              setProfileOpen(true);
            }
          }}
        >
          <ScrollText size={14} /> Reader's ledger
        </button>
      ) : null}
      {isOperaLibre && currentUser.isAdmin ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setUserMenuOpen(false);
            if (native) {
              openNativeTab("admin");
            } else {
              setUsersModalOpen(true);
            }
          }}
        >
          <UserCog size={14} /> Administration
        </button>
      ) : null}
      {isOperaLibre && currentUser.isAdmin && brokenLibationAccounts.length > 0 ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setUserMenuOpen(false);
            setLibrarySource("audible");
            setLibraryOpen(true);
            if (native) openNativeTab("shelf");
          }}
        >
          <AlertCircle size={14} /> Audible accounts ({brokenLibationAccounts.length})
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          setUserMenuOpen(false);
          if (localMode) pausePlayback(audioRef.current);
          void onLogout();
        }}
      >
        <LogOut size={14} /> {localMode ? "Leave local mode" : "Sign out"}
      </button>
    </div>
  );

  return (
    <main
      ref={shellRef}
      className={
        native
          ? `shell native-shell tab-${nativeTab}${nativeTab === "shelf" && nativePlayerView === "details" ? " library-book-open" : ""}`
          : `shell web-shell player-view-${nativePlayerView}`
      }
    >
      {!startupViewReady ? <NativeLaunchPlaceholder /> : null}
      {native ? <div className="ios-status-veil" aria-hidden="true" /> : null}
      <audio
        key={currentTrackKey ?? "no-track"}
        ref={audioRef}
        src={streamUrl || undefined}
        muted={nativeAudio}
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onError={() => {
          const code = audioRef.current?.error?.code;
          const message = code === MediaError.MEDIA_ERR_DECODE
            ? "This audio file could not be decoded."
            : code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
              ? "This audio format is not supported on this device."
              : code === MediaError.MEDIA_ERR_NETWORK
                ? "Playback lost its connection to the audiobook server."
                : "This audio track could not be loaded.";
          setIsPlaying(false);
          setPlaybackError(message);
        }}
        onTimeUpdate={onTimeUpdate}
        onPlay={() => {
          // Playback can also start natively (lock screen, CarPlay) without
          // going through startPlayback; real listening must always count as
          // touched or its progress would never be persisted.
          markPlaybackTouched();
          engageGainChain(audioRef.current);
          if (nativeAudio) nativePlaybackPlayingRef.current = true;
          setPlaybackError(null);
          setIsPlaying(true);
          if (
            currentTrack &&
            audioRef.current &&
            playbackBook &&
            playbackBook.source !== "device" &&
            restoredProgressBookId.current === playbackBook.id
          ) {
            void reportPlaybackStarted(currentTrack.id, audioRef.current.currentTime);
          }
        }}
        onPause={() => {
          if (nativeAudio) nativePlaybackPlayingRef.current = false;
          setIsPlaying(false);
          void persistProgress();
        }}
        onEnded={playNextTrack}
      />

      <button
        type="button"
        className={`library-scrim ${libraryOpen ? "show" : ""}`}
        aria-label="Close library"
        aria-hidden={!libraryOpen}
        tabIndex={-1}
        onClick={() => setLibraryOpen(false)}
      />

      <aside className={`library-pane ${libraryOpen ? "open" : ""}`} {...shelfPull.handlers}>
        {native ? (
          <div
            className={`pull-indicator ${shelfPull.refreshing ? "refreshing" : ""}`}
            style={
              shelfPull.refreshing
                ? undefined
                : {
                    opacity: Math.min(1, shelfPull.pull / PULL_REFRESH_THRESHOLD),
                    transform: `translateX(-50%) rotate(${Math.round(shelfPull.pull * 2.8)}deg)`
                  }
            }
            aria-hidden="true"
          >
            <RefreshCcw size={17} strokeWidth={2} />
          </div>
        ) : null}
        <div className="pane-title">
          <div>
            <span className="eyebrow"><Library size={13} /> The Collection</span>
            <h1>Audio <span className="amp">&amp;</span> Books</h1>
          </div>
          <div className="pane-actions">
            {native ? (
              <button
                className="icon-button"
                aria-label="Add audiobook from device"
                disabled={deviceImport !== null}
                onClick={() => void importFromDevice()}
              >
                {deviceImport ? <LoaderCircle size={16} className="spin-icon" /> : <FolderOpen size={16} />}
              </button>
            ) : null}
            {isOperaLibre && currentUser.isAdmin ? (
              <button
                className="icon-button"
                aria-label="Upload audiobook"
                onClick={() => {
                  setUploadError(null);
                  setUploadModalOpen(true);
                }}
              >
                <Upload size={16} />
              </button>
            ) : null}
            {finishFeedAvailable ? (
              <div className="finish-feed-wrap">
                <button
                  className="icon-button finish-feed-button"
                  aria-label={
                    finishFeed.unseenCount > 0
                      ? `Shared reading, ${finishFeed.unseenCount} new`
                      : "Shared reading"
                  }
                  aria-expanded={finishFeedOpen}
                  onClick={toggleFinishFeed}
                >
                  <Bell size={16} />
                  {finishFeed.unseenCount > 0 ? (
                    <span className="finish-feed-badge" aria-hidden="true">
                      {finishFeed.unseenCount > 9 ? "9+" : finishFeed.unseenCount}
                    </span>
                  ) : null}
                </button>
                {finishFeedOpen ? (
                  <div className="finish-feed-panel" role="dialog" aria-label="Shared reading">
                    <header>
                      <strong>Shared reading</strong>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Close shared reading"
                        onClick={() => setFinishFeedOpen(false)}
                      >
                        <X size={14} />
                      </button>
                    </header>
                    {finishFeed.entries.length === 0 ? (
                      <p className="finish-feed-empty">
                        Nobody has finished a book yet. When someone does, it shows up here.
                      </p>
                    ) : (
                      <ul>
                        {finishFeed.entries.map((entry) => (
                          <li key={entry.id} className={entry.unseen ? "unseen" : ""}>
                            <button
                              type="button"
                              onClick={() => {
                                const book = books.find((candidate) => candidate.id === entry.bookId);
                                if (book) {
                                  selectBook(book);
                                  setLibraryOpen(false);
                                }
                                setFinishFeedOpen(false);
                              }}
                            >
                              <span className="finish-feed-text">{finishAnnouncement(entry)}</span>
                              <span className="finish-feed-when">
                                {finishedAgoLabel(entry.finishedAt)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
            <button
              className="icon-button"
              aria-label={isOperaLibre && currentUser.isAdmin ? "Rescan library" : "Refresh library"}
              onClick={() => void refreshLibrary()}
            >
              <RefreshCcw size={16} />
            </button>
            <div className="user-menu-wrap">
              <button
                className="icon-button"
                aria-label="Account menu"
                aria-expanded={userMenuOpen}
                onClick={() => setUserMenuOpen((open) => !open)}
              >
                <span className="user-avatar">{currentUser.username.slice(0, 1).toUpperCase()}</span>
              </button>
              {userMenuOpen
                ? native
                  ? createPortal(
                      <div className="user-menu-layer">
                        <button
                          type="button"
                          className="user-menu-scrim"
                          aria-label="Close menu"
                          onClick={() => setUserMenuOpen(false)}
                        />
                        {userMenu}
                      </div>,
                      document.body
                    )
                  : userMenu
                : null}
            </div>
            <button
              className="icon-button library-close"
              aria-label="Close library"
              onClick={() => setLibraryOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="library-toolbar">
          <label className="library-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              placeholder={librarySource === "local" ? "Search title, author…" : "Search Audible titles…"}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              aria-label="Search library"
            />
          </label>

          <div className="library-controls">
            <label className="library-sort">
              <span className="sr-only">Sort by</span>
              <select
                value={sortMode}
                onChange={(event) => selectSortMode(event.currentTarget.value as SortMode)}
                aria-label="Sort library by"
              >
                {SORT_OPTIONS.filter((option) => isSortModeSupported(librarySource, option.value)).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="view-toggle" role="group" aria-label="View mode">
              <button
                className={viewMode === "list" ? "selected" : ""}
                onClick={() => setViewMode("list")}
                aria-label="List view"
                aria-pressed={viewMode === "list"}
              >
                <List size={14} />
              </button>
              <button
                className={viewMode === "grid" ? "selected" : ""}
                onClick={() => setViewMode("grid")}
                aria-label="Grid view"
                aria-pressed={viewMode === "grid"}
              >
                <LayoutGrid size={14} />
              </button>
            </div>
          </div>

          {canBrowseLibation ? (
            <div className="source-toggle" role="group" aria-label="Shelf collection">
              <button
                type="button"
                className={librarySource === "local" ? "selected" : ""}
                onClick={showYourLibrary}
                aria-pressed={librarySource === "local"}
                aria-label="Your library: books on the server and this device"
              >
                <Library size={13} />
                <span className="source-toggle-copy">
                  <strong>Your Library</strong>
                  <small>Server + device</small>
                </span>
              </button>
              <button
                type="button"
                className={librarySource === "audible" ? "selected" : ""}
                onClick={() => setLibrarySource("audible")}
                aria-pressed={librarySource === "audible"}
                aria-label="Audible account purchases"
              >
                <Cloud size={13} />
                <span className="source-toggle-copy">
                  <strong>Audible</strong>
                  <small>{brokenLibationAccounts.length > 0 ? `${brokenLibationAccounts.length} need attention` : "Account purchases"}</small>
                </span>
                {currentUser.isAdmin && brokenLibationAccounts.length > 0 ? (
                  <span className="source-health-badge" aria-label={`${brokenLibationAccounts.length} Audible accounts need attention`}>
                    {brokenLibationAccounts.length}
                  </span>
                ) : null}
              </button>
            </div>
          ) : null}
        </div>

        {currentUser.isAdmin && librarySource === "audible" ? (
          <section className="libation-panel">
            <div className="libation-status">
              {libationStatus?.enabled ? <Cloud size={15} /> : <ServerOff size={15} />}
              <span>
                {libationStatus?.enabled
                  ? libationStatus.authenticated
                    ? "Libation ready"
                    : "Libation needs sign-in"
                  : "Libation not configured"}
              </span>
            </div>

            {libationMessage ? <p>{libationMessage}</p> : null}

            <div className="libation-account-toolbar">
              <label>
                <span>Browsing</span>
                <select value={audibleAccountFilter} onChange={(event) => setAudibleAccountFilter(event.currentTarget.value)}>
                  <option value="all">All accounts</option>
                  {libationStatus?.accounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.name || account.accountId}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="quiet-button" onClick={() => openLibationAccountForm()} disabled={!libationStatus?.enabled}>
                <Plus size={13} /> Add account
              </button>
            </div>

            {libationStatus?.accounts.length ? (
              <div className="account-list">
                {libationStatus.accounts.map((account) => (
                  <article key={account.id} className={account.authenticated ? "ok" : "warn"}>
                    <span className="account-health-icon">
                      {account.authenticated ? <KeyRound size={13} /> : <AlertCircle size={13} />}
                    </span>
                    <span className="account-list-copy">
                      <strong>{account.name || account.accountId}</strong>
                      <small>
                        {account.locale.toUpperCase()}
                        {account.authenticated ? " · Connected" : account.connectionState === "error" ? " · Connection error" : " · Sign-in required"}
                      </small>
                      {!account.authenticated && account.lastError ? <em>{account.lastError}</em> : null}
                    </span>
                    {account.managed ? (
                      <span className="account-list-actions">
                        <button type="button" onClick={() => openLibationAccountForm(account)} disabled={libationAccountBusyId !== null}>
                          <KeyRound size={12} /> {account.authenticated ? "Reconnect" : "Sign in"}
                        </button>
                        {currentUser.isOwner ? (
                          <button type="button" className="danger" aria-label={`Remove ${account.name || account.accountId}`} onClick={() => void removeLibationAccount(account)} disabled={libationAccountBusyId !== null}>
                            {libationAccountBusyId === account.id ? <LoaderCircle size={12} className="spin-icon" /> : <Trash2 size={12} />}
                          </button>
                        ) : null}
                      </span>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : null}

            {libationAccountFormOpen ? (
              <div className="libation-login-card">
                <div className="libation-login-head">
                  <div>
                    <strong>{libationReconnectProfileId ? "Reconnect Audible account" : "Add Audible account"}</strong>
                    <small>Amazon handles your password and verification in the browser.</small>
                  </div>
                  <button type="button" aria-label="Close Audible sign-in" onClick={() => void closeLibationAccountForm()}><X size={14} /></button>
                </div>
                {!libationLoginFlow ? (
                  <form onSubmit={(event) => void beginLibationAccountLogin(event)}>
                    <label><span>Account label</span><input value={libationAccountLabel} maxLength={80} placeholder="Family account" onChange={(event) => setLibationAccountLabel(event.currentTarget.value)} /></label>
                    <label><span>Audible email</span><input type="email" value={libationAccountId} maxLength={320} autoCapitalize="none" autoCorrect="off" placeholder="reader@example.com" onChange={(event) => setLibationAccountId(event.currentTarget.value)} /></label>
                    <label><span>Marketplace</span><select value={libationAccountLocale} onChange={(event) => setLibationAccountLocale(event.currentTarget.value)}>{["us", "uk", "ca", "de", "fr", "au", "jp", "in", "es"].map((locale) => <option key={locale} value={locale}>{locale.toUpperCase()}</option>)}</select></label>
                    <button type="submit" disabled={libationLoginBusy}>{libationLoginBusy ? <LoaderCircle size={13} className="spin-icon" /> : <KeyRound size={13} />} Start secure sign-in</button>
                  </form>
                ) : (
                  <form onSubmit={(event) => void finishLibationAccountLogin(event)}>
                    <p>Finish signing in with Audible, copy the complete final URL from the browser address bar, then paste it here.</p>
                    <a className="libation-login-link" href={libationLoginFlow.loginUrl} target="_blank" rel="noreferrer"><Cloud size={13} /> Open Audible sign-in</a>
                    <label><span>Final browser URL</span><textarea value={libationLoginResponseUrl} rows={3} autoCapitalize="none" autoCorrect="off" placeholder="https://www.amazon.com/ap/maplanding?..." onChange={(event) => setLibationLoginResponseUrl(event.currentTarget.value)} /></label>
                    <button type="submit" disabled={libationLoginBusy || !libationLoginResponseUrl.trim()}>{libationLoginBusy ? <LoaderCircle size={13} className="spin-icon" /> : <CircleCheck size={13} />} Complete sign-in</button>
                  </form>
                )}
              </div>
            ) : null}

            <div className="libation-actions">
              <button
                type="button"
                onClick={() => void startLibationSync()}
                aria-busy={isRefreshingAudible}
                disabled={!libationStatus?.enabled || libationLoading || libationRefreshPending || !!refreshLibationJob}
              >
                {refreshLibationJob?.status === "queued" ? (
                  <List size={13} />
                ) : isRefreshingAudible ? (
                  <LoaderCircle size={13} className="spin-icon" />
                ) : (
                  <RefreshCcw size={13} />
                )}
                <span>{refreshLibationJob?.status === "queued" ? "Refresh queued" : isRefreshingAudible ? "Syncing" : "Refresh Audible"}</span>
              </button>
              {currentUser.libationAccess === "direct" ? <button
                type="button"
                onClick={() => void startAllLiberation()}
                aria-busy={libationAllPending || !!downloadAllLibationJob}
                disabled={!libationStatus?.enabled || libationLoading || libationAllPending || !!downloadAllLibationJob}
              >
                {downloadAllLibationJob?.status === "queued" ? <List size={13} /> : libationAllPending || downloadAllLibationJob ? <LoaderCircle size={13} className="spin-icon" /> : <Download size={13} />}
                <span>{downloadAllLibationJob?.status === "queued" ? "All queued" : libationAllPending ? "Starting all" : downloadAllLibationJob ? "Downloading all" : "Download all"}</span>
              </button> : null}
            </div>

            <p className="libation-help">
              Refresh checks Audible for new purchases. Administrator refreshes are unrestricted
              {libationStatus?.autoRefreshHours
                ? `, and the server also checks automatically every ${libationStatus.autoRefreshHours} hours.`
                : "."}
            </p>

            {displayedLibationJobs.map((job) => {
              const targetTitle = job.targetId
                ? libationBooks.find((book) => book.catalogId === job.targetId)?.title
                : null;
              return (
              <div key={job.id} className={`job-card ${job.status}`}>
                <div className="job-card-head">
                  <span className="job-state">
                    {job.status === "queued" ? (
                      <List size={13} />
                    ) : job.status === "running" ? (
                      <LoaderCircle size={13} className="spin-icon" />
                    ) : job.status === "failed" ? (
                      <AlertCircle size={13} />
                    ) : (
                      <CloudDownload size={13} />
                    )}
                    {jobStateLabel(job)}
                  </span>
                  <strong>{targetTitle ?? jobTitle(job)}</strong>
                </div>
                <p>{jobSummary(job)}</p>
                <dl className="job-meta">
                  <div>
                    <dt>Elapsed</dt>
                    <dd>{formatElapsed(job.startedAt, job.finishedAt) ?? "Starting"}</dd>
                  </div>
                  {job.exitCode !== null ? (
                    <div>
                      <dt>Exit</dt>
                      <dd>{job.exitCode}</dd>
                    </div>
                  ) : null}
                </dl>
                {!isPendingJob(job) || job.error ? (
                  <pre className="job-output">{jobDetailLines(job).join("\n")}</pre>
                ) : null}
              </div>
              );
            })}
          </section>
        ) : null}

        {!currentUser.isAdmin && librarySource === "audible" ? (
          <section className="libation-panel reader-libation-panel">
            <div className="libation-status"><Cloud size={15} /><span>Audible library</span></div>
            {audibleProfiles.length > 1 ? (
              <label className="reader-account-filter">
                <span>Browsing</span>
                <select value={audibleAccountFilter} onChange={(event) => setAudibleAccountFilter(event.currentTarget.value)}>
                  <option value="all">All accounts</option>
                  {audibleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
              </label>
            ) : null}
            <div className="libation-actions">
              <button
                type="button"
                onClick={() => void startLibationSync()}
                aria-busy={isRefreshingAudible}
                disabled={!libationStatus?.enabled || libationLoading || isRefreshingAudible}
              >
                {isRefreshingAudible
                  ? <LoaderCircle size={13} className="spin-icon" />
                  : <RefreshCcw size={13} />}
                <span>{isRefreshingAudible ? "Syncing" : "Refresh Audible"}</span>
              </button>
            </div>
            <p>
              {currentUser.libationAccess === "direct"
                ? "Your administrator allows you to add titles directly to the shared library."
                : "Choose Request on a title. An administrator must approve it before Libation downloads it."}
              {" "}
              {libationStatus?.manualRefreshesPerHour
                ? `You can check for new purchases up to ${libationStatus.manualRefreshesPerHour} times per hour.`
                : "You can check for new purchases at any time."}
            </p>
          </section>
        ) : null}

        {librarySource === "local" ? (
          <>
            {isLoading ? <div className="empty-state">Loading library…</div> : null}
            {error ? <div className="empty-state error">{error}</div> : null}
            {!isLoading && !error && books.length === 0 ? (
              <div className="empty-state device-empty-state">
                <span>{localMode ? "Your on-device shelf is empty." : "No audiobooks found in the configured library folder."}</span>
                {native ? (
                  <button type="button" className="download-btn" onClick={() => void importFromDevice()}>
                    <FolderOpen size={14} /> Choose audiobook files
                  </button>
                ) : null}
              </div>
            ) : null}
            {!isLoading && !error && books.length > 0 && visibleBooks.length === 0 ? (
              <div className="empty-state">Nothing matches “{searchQuery}”.</div>
            ) : null}

            <div className={`book-list ${viewMode === "grid" ? "is-grid" : "is-list"}`}>
              {visibleBooks.map((book, index) => {
                const progressPercent = book.progress?.percentComplete ?? 0;
                const availableOnDevice =
                  demoMode
                  || localMode
                  || book.source === "device"
                  || !!book.deviceBookId
                  || downloadedBookIds.has(book.id);
                const availableOnServer = !demoMode && !localMode && book.source !== "device";
                const availabilityLabel = availableOnDevice
                  ? availableOnServer
                    ? "Available on the server and this device"
                    : "Available on this device"
                  : "Available from the server";
                const unavailableOffline = isOffline && !availableOnDevice;
                const shared = summarizeSharedProgress(book.sharedProgress);
                const sortGroup = bookSortGroupLabel(book, sortMode);
                const previousSortGroup = index > 0
                  ? bookSortGroupLabel(visibleBooks[index - 1], sortMode)
                  : null;
                return (
                  <Fragment key={book.id}>
                    {sortGroup && compareShelfLabels(sortGroup, previousSortGroup) !== 0 ? (
                      <div className="book-sort-group" role="heading" aria-level={2}>
                        <span>{bookSortGroupCaption(sortMode)}</span>
                        <strong>{sortGroup}</strong>
                      </div>
                    ) : null}
                    <button
                      className={`book-row ${book.id === selectedBook?.id ? "active" : ""} ${unavailableOffline ? "offline-unavailable" : ""}`}
                      onClick={() => {
                        selectBook(book);
                        setLibraryOpen(false);
                      }}
                    >
                      {native || viewMode === "grid" || book.coverArtUrl ? (
                        <CoverArt book={book} size="small" />
                      ) : (
                        <span className="index">{String(index + 1).padStart(2, "0")}</span>
                      )}
                      <span
                        className={`book-availability ${availableOnDevice ? "has-device-copy" : "server-only"} ${
                          availableOnServer && availableOnDevice ? "server-and-device" : ""
                        }`}
                        role="img"
                        aria-label={availabilityLabel}
                        title={availabilityLabel}
                      >
                        {availableOnServer ? <Cloud className="server-availability-icon" size={13} strokeWidth={1.8} /> : null}
                        {availableOnDevice ? <Smartphone className="device-availability-icon" size={13} strokeWidth={1.8} /> : null}
                      </span>
                      <span className="book-text">
                        <strong>{book.title}</strong>
                        <span>{bookSubtitle(book) || `${book.trackCount} track${book.trackCount === 1 ? "" : "s"}`}</span>
                        {sortMode === "series" && book.metadata.seriesPosition ? (
                          <span className="book-sort-context">Book {book.metadata.seriesPosition} in series</span>
                        ) : null}
                        {formatDurationLabel(book.durationSeconds ?? durationFromTracks(book)) ? (
                          <span className="book-runtime-tag">
                            <Timer size={11} strokeWidth={1.5} />
                            {formatDurationLabel(book.durationSeconds ?? durationFromTracks(book))}
                          </span>
                        ) : null}
                        <span className={`book-progress ${book.progress?.status ?? "notStarted"}`}>
                          <em>{bookProgressLabel(book)}</em>
                          {book.progress?.status === "inProgress" && book.progress.percentComplete !== null ? (
                            <i style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }} />
                          ) : null}
                        </span>
                        {shared ? (
                          <span
                            className={`book-shared-readers ${shared.finished > 0 ? "has-finishers" : ""}`}
                            title={shared.detail}
                            aria-label={shared.detail}
                          >
                            <Users size={11} strokeWidth={1.6} aria-hidden="true" />
                            {shared.label}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </Fragment>
                );
              })}
            </div>
          </>
        ) : (
          <>
            {libationLoading || (libationStatus?.enabled && !libationBooksLoaded) ? (
              <div className="empty-state">Loading Audible library…</div>
            ) : null}
            {libationError ? <div className="empty-state error">{libationError}</div> : null}
            {!libationLoading && !libationError && libationBooksLoaded && libationStatus?.enabled && visibleLibationBooks.length === 0 ? (
              <div className="empty-state">No Libation books loaded yet.</div>
            ) : null}

            <div className="audible-list">
              {visibleLibationBooks.map((book) => {
                const isLocal = !!book.localBookId;
                const downloadRequest = libationDownloadRequests.find(
                  (request) => (request.catalogId ? request.catalogId === book.catalogId : request.profileId ? `${request.profileId}:${request.asin}` === book.catalogId : request.asin === book.asin) && request.status !== "rejected"
                );
                const isAwaitingApproval = downloadRequest?.status === "pending";
                const isApprovedRequest = downloadRequest?.status === "approved" && !!downloadRequest.jobId;
                const pendingDownloadJob =
                  pendingLibationJobs.find(
                    (job) => job.kind === "libation-liberate" && job.targetId === book.catalogId
                  ) ?? downloadAllLibationJob;
                const latestBookJob = libationJobs.find(
                  (job) => job.kind === "libation-liberate" && job.targetId === book.catalogId
                );
                const isStarting = libationAllPending || libationRequests.has(book.catalogId);
                const isQueued = pendingDownloadJob?.status === "queued";
                const isDownloading = pendingDownloadJob?.status === "running";
                const finalizationFailed = libationFinalizationFailures.has(book.catalogId);
                const isFinalizing = isLibationAdding({
                  isLocal,
                  confirmationPending: libationFinalizingAsins.has(book.catalogId),
                  confirmationFailed: finalizationFailed
                });
                const didFail = latestBookJob?.status === "failed" || finalizationFailed;
                const metaParts = [
                  book.authors,
                  formatMinutes(book.lengthMinutes),
                  isLocal ? "In library" : book.bookStatus
                ].filter(Boolean);
                return (
                  <div key={book.catalogId} className={`audible-row ${isLocal ? "is-local" : ""}`}>
                    <LibationCoverArt book={book} />
                    <div className="audible-copy">
                      <strong>{book.title}</strong>
                      <span>{metaParts.join(" · ")}</span>
                      <small className="audible-account-badge"><KeyRound size={10} /> {audibleAccountLabels.get(book.profileId) ?? book.profileName}</small>
                    </div>
                    {isLocal ? (
                      <button
                        type="button"
                        className="local-marker"
                        aria-label={`Open ${book.title} from your library`}
                        onClick={() => {
                          if (!book.localBookId) {
                            return;
                          }
                          openBookDetails(book.localBookId);
                          setLibrarySource("local");
                          setLibraryOpen(false);
                        }}
                      >
                        <CircleCheck size={14} />
                        <span>In library</span>
                      </button>
                    ) : isAwaitingApproval ? (
                      <span className="audible-download-status queued" role="status" aria-label={`Requested ${book.title}`}>
                        <List size={14} />
                        <span>Requested</span>
                      </span>
                    ) : isStarting || isQueued || isDownloading || isFinalizing || (isApprovedRequest && !finalizationFailed) ? (
                      <span
                        className={`audible-download-status ${
                          isQueued ? "queued" : isDownloading ? "downloading" : isFinalizing || isApprovedRequest ? "finalizing" : "starting"
                        }`}
                        role="status"
                        aria-label={`${
                          isQueued ? "Queued" : isDownloading ? "Downloading" : isFinalizing || isApprovedRequest ? "Adding to library" : "Starting download"
                        } ${book.title}`}
                      >
                        {isQueued ? <List size={14} /> : <LoaderCircle size={14} className="spin-icon" />}
                        <span>{isQueued ? "Queued" : isDownloading ? "Downloading" : isFinalizing || isApprovedRequest ? "Adding" : "Starting"}</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={`audible-download-action ${didFail ? "retry" : ""}`}
                        aria-label={`${didFail ? "Retry" : currentUser.libationAccess === "approval" ? "Request" : "Download"} ${book.title}`}
                        onClick={() => void startLiberation(book)}
                      >
                        <CloudDownload size={14} />
                        <span>{didFail ? "Retry" : currentUser.libationAccess === "approval" ? "Request" : "Download"}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </aside>

      <section
        className={`player-pane native-player-view-${nativePlayerView} ${
          isViewingPlayingBook && currentTrack ? "has-native-player" : ""
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
              <section className="native-now-playing" aria-label="Now playing">
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

                <div className="native-now-timeline">
                  <ScrubSlider
                    ariaLabel={activeChapter ? `Playback position in ${activeChapter.title}` : "Playback position"}
                    max={activeChapter ? chapterDuration : Math.max(1, sliderMax)}
                    value={activeChapter ? Math.min(chapterElapsed, chapterDuration) : Math.min(position, Math.max(1, sliderMax))}
                    onCommit={(value) => {
                      if (activeChapter) {
                        seekBookPosition(activeChapter.startSeconds + value);
                      } else {
                        seekTo(value);
                      }
                    }}
                  />
                  <div className="native-now-time-row">
                    <span>{activeChapter ? formatTime(displayChapterElapsed) : formatTime(displayTrackPosition)}</span>
                    <span>
                      {activeChapter
                        ? `−${formatTime(Math.max(0, chapterDuration - displayChapterElapsed))}`
                        : `−${formatTime(Math.max(0, sliderMax - displayTrackPosition))}`}
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
                    className="native-now-play"
                    aria-label={isPlaying ? "Pause" : "Play"}
                    onClick={togglePlayback}
                  >
                    {isPlaying ? <Pause size={39} fill="currentColor" /> : <Play size={39} fill="currentColor" />}
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
                    onClick={() => setNativePlayerSheet("speed")}
                  >
                    <Gauge size={16} /> {speed}×
                  </button>
                  <button type="button" onClick={() => setNativePlayerSheet("sleep")}>
                    <Timer size={16} /> {sleepRemaining > 0 ? `${Math.ceil(sleepRemaining / 60)}m left` : "Sleep timer"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (playbackBook) setSelectedBookId(playbackBook.id);
                      haptic("light");
                      setNativePlayerSheet("details");
                    }}
                  >
                    <Bookmark size={16} /> Details
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (playbackBook) setSelectedBookId(playbackBook.id);
                      setNativePlayerSheet("chapters");
                    }}
                  >
                    <ListMusic size={16} /> Chapters
                  </button>
                </div>

                {!native ? (
                  <div className="web-now-extras">
                    <section className="web-now-panel web-now-about" aria-labelledby="web-now-about-title">
                      <header className="web-now-panel-head">
                        <div>
                          <span className="web-now-panel-kicker"><ScrollText size={13} /> Edition</span>
                          <h3 id="web-now-about-title">About this book</h3>
                        </div>
                        <button type="button" onClick={() => setNativePlayerSheet("details")}>View details</button>
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
                        <button type="button" onClick={() => setNativePlayerSheet("chapters")}>All chapters</button>
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
                  openPlaybackView("now");
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
                    {isOperaLibre && currentUser.isAdmin && selectedBook.source !== "device" ? (
                      <button
                        className="download-btn"
                        type="button"
                        onClick={() => openMetadataEditor(selectedBook)}
                        aria-label={`Edit info for ${selectedBook.title}`}
                      >
                        <Pencil size={13} />
                        <span>Edit Info</span>
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
                    {selectedBook.readingFile ? (
                      <button
                        className={`download-btn ${readalongOpen ? "active" : ""}`}
                        type="button"
                        onClick={() => setReadalongOpen((open) => !open)}
                        aria-pressed={readalongOpen}
                        aria-label={`${readalongOpen ? "Close" : "Open"} readalong for ${selectedBook.title}`}
                      >
                        <ScrollText size={13} />
                        <span>Read Along</span>
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
                    ) : isNativeApp() ? (
                      <button
                        className={`download-btn ${downloadedBookIds.has(selectedBook.id) ? "active" : ""} ${
                          selectedDownload ? "downloading" : ""
                        }`}
                        type="button"
                        onClick={() =>
                          void (selectedDownload
                            ? cancelOfflineDownload(selectedBook)
                            : downloadedBookIds.has(selectedBook.id)
                              ? removeOfflineDownload(selectedBook)
                              : downloadForOffline(selectedBook))
                        }
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
                    ) : isOperaLibre ? (
                      <a
                        className="download-btn"
                        href={bookDownloadUrl(selectedBook.id)}
                        download
                        aria-label={`Download ${selectedBook.title} as zip`}
                      >
                        <Download size={13} />
                        <span>Download</span>
                      </a>
                    ) : null}
                    {isNativeApp() && downloadStatus?.bookId === selectedBook.id ? (
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
                <h2>
                  {selectedBook.title.split(" ").map((word, i, arr) => {
                    const isLast = i === arr.length - 1;
                    return (
                      <span key={i}>
                        {isLast ? <em>{word}</em> : word}
                        {isLast ? "" : " "}
                      </span>
                    );
                  })}
                </h2>
                <p className="book-credits">
                  {selectedBook.author ? <span>{selectedBook.author}</span> : null}
                  {selectedBook.narrator ? <span>Narrated by {selectedBook.narrator}</span> : null}
                  {!selectedBook.author && !selectedBook.narrator ? <span>{selectedBook.trackCount} tracks</span> : null}
                </p>
                {formatDurationLabel(selectedBook.durationSeconds ?? durationFromTracks(selectedBook)) ? (
                  <div className="book-runtime" aria-label="Total runtime">
                    <span className="book-runtime-label">Runtime</span>
                    <span className="book-runtime-value">
                      {formatDurationLabel(selectedBook.durationSeconds ?? durationFromTracks(selectedBook))}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="metadata-strip">
              {selectedBook.metadata.series ? (
                <span>{selectedBook.metadata.series}{selectedBook.metadata.seriesPosition ? ` · #${selectedBook.metadata.seriesPosition}` : ""}</span>
              ) : null}
              {selectedBook.publishedDate ? <span>{selectedBook.publishedDate}</span> : null}
              {selectedBook.metadata.publisher ? <span>{selectedBook.metadata.publisher}</span> : null}
              {selectedBook.genres.slice(0, native ? 2 : 3).map((genre) => <span key={genre}>{genre}</span>)}
            </div>

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
                    onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                  >
                    {descriptionExpanded ? "Less" : "More"}
                  </button>
                ) : null}
              </div>
            ) : null}

            {readalongOpen && selectedBook.readingFile && selectedReadalongUrl ? (
              <section className="readalong-panel" aria-label={`${selectedBook.title} readalong`}>
                <div className="readalong-header">
                  <div>
                    <span className="section-label"><ScrollText size={13} /> Readalong</span>
                    <strong>{selectedBook.readingFile.fileName}</strong>
                  </div>
                  <div className="readalong-actions">
                    {canGenerateSync ? (
                      <button
                        type="button"
                        className="download-btn"
                        disabled={syncJob?.status === "running"}
                        onClick={() => void startSyncGeneration(selectedBook)}
                        title={
                          selectedBook.syncFile
                            ? "Regenerate the narration sync map"
                            : "Generate a narration sync map for sentence highlighting"
                        }
                      >
                        {syncJob?.status === "running" ? (
                          <LoaderCircle size={13} className="spin-icon" />
                        ) : (
                          <Sparkles size={13} />
                        )}
                        <span>{selectedBook.syncFile ? "Re-sync" : "Sync"}</span>
                      </button>
                    ) : null}
                    <a className="download-btn" href={selectedReadalongUrl} target="_blank" rel="noreferrer">
                      <Download size={13} />
                      <span>Open</span>
                    </a>
                  </div>
                </div>
                {syncJob && syncJob.status === "running" ? (
                  <div className="readalong-genstatus">
                    Generating narration sync… this can take a while for long books.
                  </div>
                ) : syncJob && syncJob.status === "failed" ? (
                  <div className="readalong-genstatus error">
                    {syncJob.error ?? "Readalong sync generation failed."}
                  </div>
                ) : null}
                {syncJobError ? <div className="readalong-genstatus error">{syncJobError}</div> : null}
                {selectedBook.readingFile.extension === "epub" ? (
                  <EpubReadalong
                    title={selectedBook.title}
                    url={selectedReadalongUrl}
                    syncTarget={
                      !selectedSyncFragments && isViewingPlayingBook && activeChapter
                        ? activeChapter
                        : null
                    }
                    syncFragments={selectedSyncFragments}
                    positionSeconds={isViewingPlayingBook ? bookPosition : 0}
                    onSeekTo={(seconds) => {
                      seekBookPositionInBook(selectedBook, seconds, true);
                      if (native) {
                        setNativeTab("reading");
                        setNativePlayerView("now");
                        playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
                      }
                    }}
                  />
                ) : canPreviewReadalong(selectedBook) ? (
                  <iframe
                    className="readalong-frame"
                    src={selectedReadalongUrl}
                    title={`${selectedBook.title} readalong`}
                    sandbox=""
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="readalong-fallback">
                    <ScrollText size={36} strokeWidth={1.4} />
                    <p>
                      {selectedBook.readingFile.extension.toUpperCase()} files are available to open, but this browser
                      cannot preview them inline yet.
                    </p>
                  </div>
                )}
                {activeChapter ? (
                  <div className="readalong-sync">
                    <span>{activeChapter.title}</span>
                    <span>{formatTime(displayBookPosition)}</span>
                  </div>
                ) : null}
              </section>
            ) : null}

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
                  <button className="round-button primary" aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlayback}>
                    {isPlaying ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
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
                      <ScrubSlider
                        ariaLabel={`Playback position in ${activeChapter.title}`}
                        max={chapterDuration}
                        value={Math.min(chapterElapsed, chapterDuration)}
                        onCommit={(value) => seekBookPosition(activeChapter.startSeconds + value)}
                      />
                    </>
                  ) : (
                    <ScrubSlider
                      ariaLabel="Playback position"
                      max={Math.max(1, sliderMax)}
                      value={Math.min(position, Math.max(1, sliderMax))}
                      onCommit={seekTo}
                    />
                  )}
                  <div className="time-row">
                    <span className="elapsed">
                      {activeChapter ? formatTime(displayChapterElapsed) : formatTime(displayTrackPosition)}
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
                    onClick={() => playSelectedBook(selectedBook)}
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
                      onClick={() => playSelectedBook(selectedBook)}
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

            <div className={`controls-grid controls-grid-${isViewingPlayingBook ? (native ? 3 : 4) : 1}`}>
              {isViewingPlayingBook ? (
                <>
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
                      value={sleepMinutes}
                      onChange={(event) => configureSleepTimer(Number(event.currentTarget.value))}
                    >
                      <option value={0}>—</option>
                      {SLEEP_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {`${option} minutes`}
                        </option>
                      ))}
                    </select>
                    {sleepRemaining > 0 ? <span className="sleep-copy">{formatTime(sleepRemaining)} remaining</span> : null}
                  </section>
                </>
              ) : null}

              {/* Unlike the device volume this one belongs to the book, so it
                  is offered on the book's own page whether or not it is the
                  thing currently playing. */}
              <section className="control-section">
                <label className="section-label" htmlFor="book-volume">
                  <Volume2 size={13} /> Book Volume
                </label>
                <BookVolumeControl
                  compact
                  inputId="book-volume"
                  value={selectedGain}
                  canBoost={selectedCanBoost}
                  onChange={(db) => updateBookGain(selectedBook, db)}
                />
              </section>
            </div>

            {selectedChapterSegments.length > 0 ? (
              <section className="track-list-section" ref={trackListSectionRef}>
                <button
                  type="button"
                  className="track-list-header track-list-toggle"
                  aria-expanded={chaptersOpen}
                  onClick={() => setChaptersOpen((open) => {
                    if (open) setShowChapterJumpTop(false);
                    return !open;
                  })}
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
                <p>Start the server with OPERALIBRE_LIBRARY pointed at your files.</p>
              </>
            )}
          </div>
        )}
      </section>

      {playbackBook && currentTrack ? (
        <aside ref={miniPlayerRef} className="mini-player" aria-label="Mini player">
          <button className="mini-cover-button" type="button" onClick={scrollToPlayer} aria-label="Open current book">
            <CoverArt book={playbackBook} size="small" />
          </button>

          <button className="mini-meta" type="button" onClick={scrollToPlayer}>
            <strong>{playbackBook.title}</strong>
            <span>{activeChapter?.title ?? currentTrack.title}</span>
          </button>

          <div className="mini-progress">
            <ScrubSlider
              ariaLabel="Mini player progress"
              max={activeChapter ? chapterDuration : Math.max(1, sliderMax)}
              value={activeChapter ? Math.min(chapterElapsed, chapterDuration) : Math.min(position, Math.max(1, sliderMax))}
              onCommit={(nextValue) => {
                if (activeChapter) {
                  seekBookPosition(activeChapter.startSeconds + nextValue);
                } else {
                  seekTo(nextValue);
                }
              }}
            />
            <span>
              {activeChapter
                ? `${formatTime(displayChapterElapsed)} / ${formatTime(chapterDuration)}`
                : `${formatTime(displayTrackPosition)} / ${formatTime(sliderMax)}`}
            </span>
          </div>

          <div className="mini-actions">
            {activeChapter ? (
              <button
                type="button"
                className="mini-chapter"
                aria-label={chapterElapsed > 5 ? "Restart chapter" : "Previous chapter"}
                onClick={restartOrPreviousChapter}
                disabled={chapterElapsed <= 5 && !hasPreviousChapter}
              >
                <SkipBack size={17} />
              </button>
            ) : null}
            <button type="button" className="mini-seek" aria-label="Rewind 15 seconds" onClick={() => seekBy(-15)}>
              <RotateCcw size={16} />
              <small>15</small>
            </button>
            <button type="button" className="mini-play" aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlayback}>
              {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
            <button type="button" className="mini-seek" aria-label="Forward 30 seconds" onClick={() => seekBy(30)}>
              <RotateCw size={16} />
              <small>30</small>
            </button>
            {activeChapter ? (
              <button
                type="button"
                className="mini-chapter"
                aria-label="Next chapter"
                onClick={nextChapter}
                disabled={!hasNextChapter}
              >
                <SkipForward size={17} />
              </button>
            ) : null}
          </div>
        </aside>
      ) : null}

      {unplayedConfirmationBook ? (
        <div className="modal-scrim unplayed-confirm-scrim" role="presentation">
          <section
            className="modal-card unplayed-confirm-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="unplayed-confirm-title"
            aria-describedby="unplayed-confirm-description"
            aria-busy={completionPendingBookId === unplayedConfirmationBook.id}
            onKeyDown={(event) => {
              if (event.key === "Escape" && completionPendingBookId !== unplayedConfirmationBook.id) {
                setUnplayedConfirmationBookId(null);
                setCompletionError(null);
              }
            }}
          >
            <div className="modal-head">
              <div>
                <span className="eyebrow"><RotateCcw size={13} /> Listening progress</span>
                <h2 id="unplayed-confirm-title">Mark as unplayed?</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Cancel marking book unplayed"
                disabled={completionPendingBookId === unplayedConfirmationBook.id}
                onClick={() => {
                  setUnplayedConfirmationBookId(null);
                  setCompletionError(null);
                }}
              >
                <X size={18} />
              </button>
            </div>
            <p id="unplayed-confirm-description" className="unplayed-confirm-copy">
              <strong>{unplayedConfirmationBook.title}</strong> will return to the beginning. This
              stops playback and removes it from Now Playing.
            </p>
            <div className="unplayed-confirm-summary" aria-label="Changes made by marking the book unplayed">
              <span>Listening position</span><strong>Beginning</strong>
              <span>Now Playing</span><strong>Cleared</strong>
              <span>Library status</span><strong>Not started</strong>
            </div>
            {completionError?.bookId === unplayedConfirmationBook.id ? (
              <p className="auth-error" role="alert">{completionError.message}</p>
            ) : null}
            <div className="unplayed-confirm-actions">
              <button
                type="button"
                className="unplayed-confirm-cancel"
                autoFocus
                disabled={completionPendingBookId === unplayedConfirmationBook.id}
                onClick={() => {
                  setUnplayedConfirmationBookId(null);
                  setCompletionError(null);
                }}
              >
                Keep listening
              </button>
              <button
                type="button"
                className="unplayed-confirm-submit"
                disabled={completionPendingBookId === unplayedConfirmationBook.id}
                onClick={() => void confirmBookUnplayed(unplayedConfirmationBook)}
              >
                {completionPendingBookId === unplayedConfirmationBook.id ? (
                  <><LoaderCircle size={15} className="spin-icon" /> Resetting…</>
                ) : (
                  <><RotateCcw size={15} /> Mark unplayed</>
                )}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {nativePlayerSheet === "details" && playbackBook ? (
        <div className="sleep-sheet-layer" role="presentation">
          <button
            type="button"
            className="sleep-sheet-scrim"
            aria-label="Close book details"
            onClick={() => setNativePlayerSheet(null)}
          />
          <section className="details-sheet" role="dialog" aria-modal="true" aria-labelledby="details-sheet-title">
            <div className="details-sheet-grabber" aria-hidden="true" />
            <header className="details-sheet-header">
              <span className="eyebrow"><Bookmark size={13} /> Listening edition</span>
              <button type="button" className="icon-button" aria-label="Close" onClick={() => setNativePlayerSheet(null)}>
                <X size={18} />
              </button>
            </header>

            <div className="details-sheet-hero">
              <CoverArt book={playbackBook} size="small" />
              <div>
                <span>{activeChapter ? `Chapter ${activeChapter.chapterNumber}` : "Now playing"}</span>
                <h2 id="details-sheet-title">{playbackBook.title}</h2>
                <p>{bookSubtitle(playbackBook) || `${playbackBook.trackCount} audio tracks`}</p>
              </div>
            </div>

            {bookCompletionPercent !== null ? (
              <div className="details-sheet-progress">
                <div>
                  <span>Listening progress</span>
                  <strong>{bookCompletionPercent}%</strong>
                </div>
                <div className="details-sheet-progressbar" role="img" aria-label={`${bookCompletionPercent}% complete`}>
                  <i style={{ width: `${bookCompletionPercent}%` }} />
                </div>
                <small>
                  {displayBookRemainingSeconds !== null && displayBookRemainingSeconds <= 0
                    ? "Complete"
                    : displayBookRemainingSeconds !== null
                    ? `${formatDurationLabel(displayBookRemainingSeconds) ?? formatTime(displayBookRemainingSeconds)} remaining`
                    : "Progress unavailable"}
                </small>
              </div>
            ) : null}

            <div className="details-sheet-facts">
              <div>
                <span>Runtime</span>
                <strong>{formatDurationLabel(playbackBook.durationSeconds ?? durationFromTracks(playbackBook)) ?? "—"}</strong>
              </div>
              <div>
                <span>Published</span>
                <strong>{playbackBook.publishedDate ?? "—"}</strong>
              </div>
              <div>
                <span>Tracks</span>
                <strong>{playbackBook.trackCount}</strong>
              </div>
            </div>

            {playbackBook.metadata.publisher || playbackBook.genres.length > 0 ? (
              <div className="details-sheet-tags" aria-label="Book metadata">
                {playbackBook.metadata.publisher ? <span>{playbackBook.metadata.publisher}</span> : null}
                {playbackBook.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
              </div>
            ) : null}

            {playbackDescription ? <p className="details-sheet-description">{playbackDescription}</p> : null}

            <div className="details-sheet-actions">
              {playbackBook.progress && playbackBook.progress.status !== "notStarted" ? (
                <button
                  type="button"
                  className="details-sheet-reset"
                  disabled={completionPendingBookId === playbackBook.id}
                  onClick={() => markBookUnplayed(playbackBook)}
                >
                  {completionPendingBookId === playbackBook.id
                    ? <LoaderCircle size={15} className="spin-icon" />
                    : <RotateCcw size={15} />}
                  Mark unplayed
                </button>
              ) : null}
              <button
                type="button"
                className="details-sheet-completion"
                disabled={completionPendingBookId === playbackBook.id}
                aria-pressed={playbackBook.progress?.status === "finished"}
                onClick={() => {
                  haptic("light");
                  void changeBookCompletion(
                    playbackBook,
                    playbackBook.progress?.status !== "finished"
                  );
                }}
              >
                {completionPendingBookId === playbackBook.id
                  ? <LoaderCircle size={15} className="spin-icon" />
                  : <CircleCheck size={15} />}
                {playbackBook.progress?.status === "finished" ? "Mark unfinished" : "Mark finished"}
              </button>
              <button
                type="button"
                className="details-sheet-full"
                onClick={() => {
                  setNativePlayerSheet(null);
                  openPlaybackView("details");
                }}
              >
                Full book page <ChevronRight size={16} />
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {nativePlayerSheet === "speed" ? (
        <div className="sleep-sheet-layer" role="presentation">
          <button
            type="button"
            className="sleep-sheet-scrim"
            aria-label="Close playback settings"
            onClick={() => setNativePlayerSheet(null)}
          />
          <section className="sleep-sheet" role="dialog" aria-modal="true" aria-labelledby="speed-sheet-title">
            <div className="sleep-sheet-grabber" aria-hidden="true" />
            <header>
              <div>
                <span className="eyebrow"><Gauge size={13} /> Cadence</span>
                <h2 id="speed-sheet-title">Playback</h2>
              </div>
              <button type="button" className="icon-button" aria-label="Close" onClick={() => setNativePlayerSheet(null)}>
                <X size={18} />
              </button>
            </header>
            <p className="sleep-sheet-hint">Fine-tune the pace in 0.05× steps or jump to a familiar preset.</p>
            <PlaybackSpeedControl value={speed} onChange={updateSpeed} rotary />
            {/* Noticing a book is too quiet happens mid-chapter, so the fix
                lives with the other thing a listener reaches for while the
                book is playing rather than on the book's own page. */}
            {playbackBook ? (
              <div className="speed-sheet-volume">
                {/* The sheet labels its sections with gold eyebrows, not the
                    grey card labels used on the book page. */}
                <label className="eyebrow" htmlFor="speed-sheet-book-volume">
                  <Volume2 size={13} /> Book Volume
                </label>
                <p className="sleep-sheet-hint">
                  Lifts this book alone, for a title mastered quieter than the rest of the shelf.
                </p>
                <BookVolumeControl
                  inputId="speed-sheet-book-volume"
                  value={playbackGain}
                  canBoost={playbackCanBoost}
                  onChange={(db) => updateBookGain(playbackBook, db)}
                />
              </div>
            ) : null}
            <button
              type="button"
              className="speed-sheet-done"
              onClick={() => {
                haptic("light");
                setNativePlayerSheet(null);
              }}
            >
              Done
            </button>
          </section>
        </div>
      ) : null}

      {nativePlayerSheet === "chapters" && playbackBook ? (
        <div className="sleep-sheet-layer" role="presentation">
          <button
            type="button"
            className="sleep-sheet-scrim"
            aria-label="Close chapters"
            onClick={() => setNativePlayerSheet(null)}
          />
          <section className="sleep-sheet chapter-sheet" role="dialog" aria-modal="true" aria-labelledby="chapter-sheet-title">
            <div className="sleep-sheet-grabber" aria-hidden="true" />
            <header>
              <div>
                <span className="eyebrow"><ListMusic size={13} /> Contents</span>
                <h2 id="chapter-sheet-title">Chapters</h2>
              </div>
              <button type="button" className="icon-button" aria-label="Close" onClick={() => setNativePlayerSheet(null)}>
                <X size={18} />
              </button>
            </header>
            <p className="sleep-sheet-hint">{playbackBook.title} · {playbackBook.chapters.length} markers</p>
            <div className="sleep-options chapter-sheet-options">
              {chapterSegments.map((chapter, index) => (
                <button
                  type="button"
                  key={chapter.id}
                  className={activeChapter?.id === chapter.id ? "selected" : ""}
                  onClick={() => jumpToChapterFromSheet(chapter)}
                >
                  <span className="chapter-sheet-label">
                    <small>{String(index + 1).padStart(2, "0")}</small>
                    <strong>{chapter.title}</strong>
                  </span>
                  {activeChapter?.id === chapter.id ? <em>Playing</em> : <span className="chapter-sheet-time">{formatTime(chapter.durationSeconds)}</span>}
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {nativePlayerSheet === "sleep" ? (
        <div className="sleep-sheet-layer" role="presentation">
          <button
            type="button"
            className="sleep-sheet-scrim"
            aria-label="Close sleep timer"
            onClick={() => setNativePlayerSheet(null)}
          />
          <section className="sleep-sheet" role="dialog" aria-modal="true" aria-labelledby="sleep-sheet-title">
            <div className="sleep-sheet-grabber" aria-hidden="true" />
            <header>
              <div>
                <span className="eyebrow"><Timer size={13} /> Nightfall</span>
                <h2 id="sleep-sheet-title">Sleep Timer</h2>
              </div>
              <button type="button" className="icon-button" aria-label="Close" onClick={() => setNativePlayerSheet(null)}>
                <X size={18} />
              </button>
            </header>
            <p className="sleep-sheet-hint">The timer only runs while your book is playing.</p>
            <div className="sleep-options">
              {SLEEP_OPTIONS.map((minutes) => (
                <button
                  type="button"
                  key={minutes}
                  className={sleepMinutes === minutes && sleepRemaining > 0 ? "selected" : ""}
                  onClick={() => configureSleepTimer(minutes)}
                >
                  <span>{minutes === 60 ? "1 hour" : `${minutes} minutes`}</span>
                  {sleepMinutes === minutes && sleepRemaining > 0 ? (
                    <em>{formatTime(sleepRemaining)} left</em>
                  ) : (
                    <ChevronRight size={17} />
                  )}
                </button>
              ))}
              <button
                type="button"
                className={`sleep-off ${sleepRemaining === 0 ? "selected" : ""}`}
                onClick={() => configureSleepTimer(0)}
              >
                <span>Off</span>
                {sleepRemaining === 0 ? <em>Selected</em> : <X size={17} />}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {metadataEditOpen && metadataForm ? (
        <div className="modal-scrim" role="presentation">
          <form className="modal-card metadata-editor-card" onSubmit={saveMetadata}>
            <div className="modal-head">
              <h2><Pencil size={18} /> Edit Book Info</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close metadata editor"
                onClick={() => {
                  setMetadataEditOpen(false);
                  setMetadataForm(null);
                  setMetadataError(null);
                }}
                disabled={metadataSaving}
              >
                <X size={16} />
              </button>
            </div>

            <div className="metadata-edit-form">
              <label className="wide">
                <span>Title</span>
                <input
                  type="text"
                  value={metadataForm.title}
                  onChange={(event) =>
                    setMetadataForm({ ...metadataForm, title: event.currentTarget.value })
                  }
                  required
                />
              </label>
              <label>
                <span>Author</span>
                <input
                  type="text"
                  value={metadataForm.author}
                  onChange={(event) =>
                    setMetadataForm({ ...metadataForm, author: event.currentTarget.value })
                  }
                />
              </label>
              <label>
                <span>Narrator</span>
                <input
                  type="text"
                  value={metadataForm.narrator}
                  onChange={(event) =>
                    setMetadataForm({ ...metadataForm, narrator: event.currentTarget.value })
                  }
                />
              </label>
              <label>
                <span>Publisher</span>
                <input
                  type="text"
                  value={metadataForm.publisher}
                  onChange={(event) =>
                    setMetadataForm({ ...metadataForm, publisher: event.currentTarget.value })
                  }
                />
              </label>
              <label>
                <span>Series</span>
                <input
                  type="text"
                  value={metadataForm.series}
                  onChange={(event) =>
                    setMetadataForm({ ...metadataForm, series: event.currentTarget.value })
                  }
                />
              </label>
              <label>
                <span>Series number</span>
                <input
                  type="text"
                  value={metadataForm.seriesPosition}
                  onChange={(event) =>
                    setMetadataForm({ ...metadataForm, seriesPosition: event.currentTarget.value })
                  }
                  placeholder="1"
                />
              </label>
              <label>
                <span>Published date</span>
                <input
                  type="text"
                  value={metadataForm.publishedDate}
                  onChange={(event) =>
                    setMetadataForm({ ...metadataForm, publishedDate: event.currentTarget.value })
                  }
                  placeholder="YYYY-MM-DD or year"
                />
              </label>
              <label className="wide">
                <span>Genres</span>
                <input
                  type="text"
                  value={metadataForm.genres}
                  onChange={(event) =>
                    setMetadataForm({ ...metadataForm, genres: event.currentTarget.value })
                  }
                  placeholder="Fantasy, Adventure"
                />
              </label>
              <label className="wide">
                <span>Audible ASIN</span>
                <input
                  type="text"
                  value={metadataForm.asin}
                  onChange={(event) =>
                    setMetadataForm({ ...metadataForm, asin: event.currentTarget.value })
                  }
                  placeholder="B012345678"
                />
              </label>
              <label className="wide">
                <span>Description</span>
                <textarea
                  value={metadataForm.description}
                  onChange={(event) =>
                    setMetadataForm({ ...metadataForm, description: event.currentTarget.value })
                  }
                  rows={7}
                />
              </label>
            </div>

            {metadataError ? <p className="metadata-edit-error">{metadataError}</p> : null}

            <div className="metadata-edit-actions">
              <button
                type="button"
                onClick={() => selectedBook && setMetadataForm(metadataEditorFromBook(selectedBook))}
                disabled={metadataSaving || !selectedBook}
              >
                Reset
              </button>
              <button type="submit" disabled={metadataSaving}>
                {metadataSaving ? "Saving..." : "Save Info"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {isOperaLibre && profileOpen ? (
        <ProfilePage
          user={currentUser}
          onClose={() => setProfileOpen(false)}
          onOpenBook={(bookId) => {
            openBookDetails(bookId);
            setProfileOpen(false);
            setLibraryOpen(false);
          }}
          onUserChanged={onCurrentUserChanged}
          onSharingChanged={() => void loadBooks()}
          sharingAvailable={sharedProgressAvailable && !native}
        />
      ) : null}

      {isOperaLibre && currentUser.isAdmin && !native && usersModalOpen ? (
        <AdminPanel
          currentUser={currentUser}
          books={administrableBooks}
          onClose={() => setUsersModalOpen(false)}
          onUpload={() => {
            setUsersModalOpen(false);
            setUploadModalOpen(true);
          }}
          onRescan={refreshLibrary}
          onBooksChanged={applyAdminLibraryChange}
          onOpenBook={(bookId) => {
            openBookDetails(bookId);
            setUsersModalOpen(false);
          }}
        />
      ) : null}

      {isOperaLibre && currentUser.isAdmin && uploadModalOpen ? (
        <div className="modal-scrim" role="presentation">
          <form
            className="modal-card upload-audiobook-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="upload-audiobook-title"
            onSubmit={submitAudiobookUpload}
          >
            <div className="modal-head">
              <div>
                <span className="eyebrow"><Upload size={13} /> Add to the collection</span>
                <h2 id="upload-audiobook-title">Upload audiobook</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close upload"
                disabled={uploadBusy}
                onClick={() => setUploadModalOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <p className="upload-audiobook-hint">
              Choose one file for an M4B or all audio tracks for a multi-file book. Files are kept
              together in a new library folder.
            </p>
            <label className="upload-audiobook-field">
              <span>Book name</span>
              <input
                value={uploadBookName}
                onChange={(event) => setUploadBookName(event.currentTarget.value)}
                placeholder="The name of the library folder"
                maxLength={200}
                required
                disabled={uploadBusy}
              />
            </label>
            <label className="upload-file-picker">
              <Upload size={22} />
              <strong>
                {uploadFiles.length
                  ? `${uploadFiles.length} file${uploadFiles.length === 1 ? "" : "s"} selected`
                  : "Choose audio files"}
              </strong>
              <span>AAC, AIFF, FLAC, M4A, M4B, MP3, MP4, OGG, Opus, or WAV</span>
              <input
                type="file"
                accept={native ? undefined : UPLOAD_FILE_ACCEPT}
                multiple
                required
                disabled={uploadBusy}
                onChange={chooseUploadFiles}
              />
            </label>
            {uploadFiles.length ? (
              <ul className="upload-file-list">
                {uploadFiles.map((file) => <li key={`${file.name}-${file.size}`}>{file.name}</li>)}
              </ul>
            ) : null}
            {uploadError ? <p className="metadata-edit-error">{uploadError}</p> : null}
            <div className="metadata-edit-actions">
              <button type="button" disabled={uploadBusy} onClick={() => setUploadModalOpen(false)}>Cancel</button>
              <button type="submit" disabled={uploadBusy || uploadFiles.length === 0}>
                {uploadBusy ? <LoaderCircle size={15} className="spin-icon" /> : <Upload size={15} />}
                {uploadBusy ? "Uploading…" : "Upload to library"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {showLedgerTab && nativeTab === "ledger" ? (
        <ProfilePage
          user={currentUser}
          onClose={() => openNativeTab("reading")}
          onOpenBook={(bookId) => {
            openBookDetails(bookId);
          }}
          onUserChanged={onCurrentUserChanged}
          onSharingChanged={() => void loadBooks()}
          sharingAvailable={sharedProgressAvailable && !native}
        />
      ) : null}

      {native && nativeTab === "settings" ? (
        <section className="settings-shell" aria-label="Settings">
          <header className="settings-head">
            <span className="eyebrow"><Settings size={13} /> The Study</span>
            <h1>Settings</h1>
          </header>

          <section className="settings-card">
            <span className="section-label"><Gauge size={13} /> Playback</span>
            <div className="settings-field">
              <span className="settings-label">Cadence</span>
              <PlaybackSpeedControl value={speed} onChange={updateSpeed} rotary />
              <p className="settings-hint">Applies to every book and is remembered on this device.</p>
            </div>
          </section>

          {rotationLockAvailable ? <section className="settings-card">
            <span className="section-label"><Smartphone size={13} /> Display</span>
            <div className="settings-toggle-row">
              <span>
                <strong>Rotation lock</strong>
                <small>Keeps OperaLibre in its current orientation, even when device rotation is on.</small>
              </span>
              <button
                type="button"
                className="settings-switch"
                role="switch"
                aria-checked={rotationLockEnabled}
                aria-label="Rotation lock"
                disabled={rotationLockBusy}
                onClick={() => void toggleRotationLock()}
              >
                <span aria-hidden="true" />
              </button>
            </div>
            {rotationLockError ? <p className="settings-hint settings-error">{rotationLockError}</p> : null}
          </section> : null}

          {sharedProgressAvailable ? (
            <ProgressSharingCard
              user={currentUser}
              onUserChanged={onCurrentUserChanged}
              onSharingChanged={() => void loadBooks()}
            />
          ) : null}

          <section className="settings-card">
            <span className="section-label"><FolderOpen size={13} /> On this device</span>
            <button type="button" className="download-btn" disabled={deviceImport !== null} onClick={() => void importFromDevice()}>
              {deviceImport ? <LoaderCircle size={13} className="spin-icon" /> : <Plus size={13} />}
              <span>{deviceImport ? `Importing ${deviceImport.completed}/${deviceImport.total || "…"}` : "Add audiobook files"}</span>
            </button>
            {getDeviceBooks().length ? (
              <div className="settings-downloads">
                {getDeviceBooks().map((book) => (
                  <div key={book.id} className="settings-download-row">
                    <strong>{book.title}</strong>
                    <button type="button" className="download-btn" onClick={() => void deleteDeviceBook(book)}>
                      <Trash2 size={13} /><span>Remove</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : <p className="settings-hint">Files you pick are copied into OperaLibre so playback remains available offline.</p>}
            {downloadStatus ? <p className="settings-hint">{downloadStatus.message}</p> : null}
          </section>

          {!localMode ? <section className="settings-card">
            <span className="section-label"><Download size={13} /> Server downloads</span>
            {demoMode ? (
              <p className="settings-hint">Demo books and their procedural audio are included on this device.</p>
            ) : (
              <>
                {deviceDownloadQueue.length > 0 ? (
                  <div className="settings-downloads" aria-label="Download queue">
                    {deviceDownloadQueue.map((activity, index) => {
                      const title = activity.title || "Audiobook";
                      return (
                        <div key={activity.bookId} className="settings-download-row">
                          <strong>{title}</strong>
                          <span className="download-status">
                            {activity.state === "queued"
                              ? `Queued${index > 0 ? ` · ${index + 1}` : ""}`
                              : activity.fraction === null
                                ? "Starting…"
                                : `${Math.round(activity.fraction * 100)}%`}
                          </span>
                          <button
                            type="button"
                            className="download-btn"
                            onClick={() => void cancelOfflineDownload({ id: activity.bookId, title })}
                            aria-label={`Cancel download of ${title}`}
                          >
                            <X size={13} />
                            <span>Cancel</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {books.some((book) => downloadedBookIds.has(book.id) && !book.deviceBookId) ? (
                  <div className="settings-downloads">
                    {books
                      .filter((book) => downloadedBookIds.has(book.id) && !book.deviceBookId)
                      .map((book) => (
                        <div key={book.id} className="settings-download-row">
                          <strong>{book.title}</strong>
                          <button
                            type="button"
                            className="download-btn"
                            onClick={() => void removeOfflineDownload(book)}
                            aria-label={`Remove downloaded copy of ${book.title}`}
                          >
                            <Trash2 size={13} />
                            <span>Remove</span>
                          </button>
                        </div>
                      ))}
                  </div>
                ) : deviceDownloadQueue.length === 0 ? (
                  <p className="settings-hint">No books are downloaded for offline listening yet.</p>
                ) : null}
              </>
            )}
          </section> : null}

          <section className="settings-card">
            <span className="section-label"><Network size={13} /> Connection</span>
            <div className="settings-kv">
              <span>Server</span>
              <span className="settings-value">
                {localMode ? "Not connected · on-device only" : demoMode ? "On-device demo · no network connection" : `${isOperaLibre ? "OperaLibre" : "Jellyfin"} · ${getServerUrl()}`}
              </span>
            </div>
            <div className="settings-kv">
              <span>Signed in as</span>
              <span className="settings-value">
                {currentUser.username} · {localMode ? "No account required" : demoMode ? "Demo reader" : currentUser.isOwner ? "Owner" : currentUser.isAdmin ? "Administrator" : "Reader"}
              </span>
            </div>
            {!demoMode && !localMode ? <div className="server-aliases">
              <span className="settings-label">Address aliases</span>
              <p className="settings-hint">
                Save other routes to this server, such as LAN, Tailscale, or a forwarded address.
              </p>
              {[
                { id: "primary", name: "Original address", url: getServerIdentityUrl() },
                ...serverAliases
              ].map((alias) => {
                const active = alias.url === getServerUrl();
                return (
                  <div className="server-alias-row" key={alias.id}>
                    <span>
                      <strong>{alias.name}</strong>
                      <small>{alias.url}</small>
                    </span>
                    <div>
                      <button
                        type="button"
                        className="download-btn"
                        disabled={active || switchingAliasId !== null}
                        onClick={() => void switchToAlias(alias)}
                      >
                        {active ? "Active" : switchingAliasId === alias.id ? "Testing…" : "Use"}
                      </button>
                      {alias.id !== "primary" ? (
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Remove ${alias.name} alias`}
                          onClick={() => {
                            removeServerAlias(alias.id);
                            setServerAliases(getServerAliases());
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              <form className="server-alias-form" onSubmit={saveAlias}>
                <input
                  value={aliasName}
                  onChange={(event) => setAliasName(event.currentTarget.value)}
                  placeholder="Name (Tailscale)"
                  aria-label="Alias name"
                  required
                />
                <input
                  value={aliasUrl}
                  onChange={(event) => setAliasUrl(event.currentTarget.value)}
                  placeholder="http://100.x.x.x:4000"
                  aria-label="Alias server address"
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  required
                />
                <button type="submit" className="download-btn"><Plus size={13} /> Add</button>
              </form>
              {aliasError ? <p className="auth-error">{aliasError}</p> : null}
            </div> : null}
            <div className="settings-actions">
              {localMode ? (
                <button type="button" className="download-btn connection-primary" onClick={() => {
                  pausePlayback(audioRef.current);
                  onConnectServer();
                }}>
                  <Network size={13} />
                  <span>Connect a server</span>
                </button>
              ) : null}
              {isOperaLibre && currentUser.isAdmin ? (
                <>
                  <button type="button" className="download-btn" onClick={() => setUploadModalOpen(true)}>
                    <Upload size={13} />
                    <span>Upload audiobook</span>
                  </button>
                  <button type="button" className="download-btn" onClick={() => openNativeTab("admin")}>
                    <UserCog size={13} />
                    <span>Administration</span>
                  </button>
                </>
              ) : null}
              <button type="button" className="download-btn" onClick={() => {
                pausePlayback(audioRef.current);
                void onLogout();
              }}>
                <LogOut size={13} />
                <span>{localMode ? "Leave local mode" : "Sign out"}</span>
              </button>
            </div>
          </section>
        </section>
      ) : null}

      {native && isOperaLibre && currentUser.isAdmin && nativeTab === "admin" ? (
        <AdminPanel
          currentUser={currentUser}
          books={administrableBooks}
          onUpload={() => setUploadModalOpen(true)}
          onRescan={refreshLibrary}
          onBooksChanged={applyAdminLibraryChange}
          onOpenBook={(bookId) => {
            openBookDetails(bookId);
            openNativeTab("shelf");
          }}
        />
      ) : null}

      {native ? (
        <nav className="spine-tabs" aria-label="Primary">
          <button
            type="button"
            className={`spine-tab ${nativeTab === "shelf" ? "active" : ""}`}
            aria-current={nativeTab === "shelf" ? "page" : undefined}
            onClick={() => openNativeTab("shelf")}
          >
            <Library size={20} strokeWidth={1.6} />
            <span>Shelf</span>
            {currentUser.isAdmin && brokenLibationAccounts.length > 0 ? <em className="nav-alert-badge">{brokenLibationAccounts.length}</em> : null}
          </button>
          <button
            type="button"
            className={`spine-tab ${nativeTab === "reading" ? "active" : ""}`}
            aria-current={nativeTab === "reading" ? "page" : undefined}
            onClick={() => openNativeTab("reading")}
          >
            <Headphones size={20} strokeWidth={1.6} />
            <span>Reading</span>
          </button>
          {showLedgerTab ? (
            <button
              type="button"
              className={`spine-tab ${nativeTab === "ledger" ? "active" : ""}`}
              aria-current={nativeTab === "ledger" ? "page" : undefined}
              onClick={() => openNativeTab("ledger")}
            >
              <ScrollText size={20} strokeWidth={1.6} />
              <span>Ledger</span>
            </button>
          ) : null}
          {isOperaLibre && currentUser.isAdmin ? (
            <button
              type="button"
              className={`spine-tab ${nativeTab === "admin" ? "active" : ""}`}
              aria-current={nativeTab === "admin" ? "page" : undefined}
              onClick={() => openNativeTab("admin")}
            >
              <ShieldCheck size={20} strokeWidth={1.6} />
              <span>Admin</span>
            </button>
          ) : null}
          <button
            type="button"
            className={`spine-tab ${nativeTab === "settings" ? "active" : ""}`}
            aria-current={nativeTab === "settings" ? "page" : undefined}
            onClick={() => openNativeTab("settings")}
          >
            <Settings size={20} strokeWidth={1.6} />
            <span>Settings</span>
          </button>
        </nav>
      ) : null}
    </main>
  );
}
