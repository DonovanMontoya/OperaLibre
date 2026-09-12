import { createPlaybackTransitions, playbackReportPosition } from "./playbackReporting";
import { serverCapabilities } from "./serverCapabilities";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { Dialog } from "@capacitor/dialog";
import { narrationTextOffset } from "./readerPagination";
import { createAlignmentStatusUpdater, readAlignmentPreference, writeAlignmentPreference } from "./alignmentPreference";
import {
  ALargeSmall,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bell,
  BookOpen,
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Cloud,
  Crosshair,
  CloudDownload,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Gamepad2,
  Gauge,
  Headphones,
  Images,
  KeyRound,
  LoaderCircle,
  LayoutGrid,
  Library,
  List,
  ListMusic,
  LocateFixed,
  LogOut,
  Maximize2,
  Minus,
  Moon,
  Network,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  RotateCw,
  Rows3,
  Search,
  ServerOff,
  Smartphone,
  Settings,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Trash2,
  Undo2,
  Upload,
  ScrollText,
  UserCog,
  Users,
  Volume2,
  X
} from "lucide-react";
import type { Book as EpubBook, Contents, EpubCFI, Location, NavItem, Rendition } from "epubjs";
import {
  READ_ALONG_MODE_LABELS,
  companionKindLabel,
  describeCompanion,
  findActiveFragmentIndex,
  findTocHrefForChapterTitle,
  groupCompanions,
  hasExtras,
  hrefsMatch,
  normalizeSyncNeedle,
  readAlongMode,
  anchorAfterRelocation,
  anchorOnPage,
  readerStorageKey,
  shouldOpenPlayingChapter,
  syncMapPrecision,
  type SyncPrecision
} from "./readalong";
import {
  READER_THEME_CHOICES,
  applyReaderThemeColors,
  currentAppPrefersDark,
  readReaderThemeChoice,
  resolveReaderTheme,
  watchAppPrefersDark,
  writeReaderThemeChoice,
  type ReaderTheme,
  type ReaderThemeChoice
} from "./readerTheme";
import { readerDebugLog, shortCfi } from "./readerDebug";
import { createScreenAwakeController } from "./screenAwake";
import { canCatchUp, resolveListeningCfi } from "./readerCatchUp";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { syncMapCacheReducer } from "./syncMapCache";
import { createPortal } from "react-dom";
import {
  adoptableServerProgress,
  endedShortOfTrack,
  freshestProgress,
  isSuspectProgressReset,
  PROGRESS_RESET_GUARD_SECONDS,
  progressAfterSave,
  progressFromBookSummary,
  progressTimestamp,
  readProgressCheckpoint,
  resolveActivePlaybackBookId,
  resolveBookId,
  resolveProgressLocation,
  shouldFlagIntentionalRegression,
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
  formatSleepTimerMinutes,
  mergeCustomSleepTimer,
  normalizeSleepTimerMinutes,
  readCustomSleepTimers,
  SLEEP_TIMER_MAX_MINUTES,
  SLEEP_TIMER_MIN_MINUTES,
  sleepTimerChoices,
  writeCustomSleepTimers
} from "./sleepTimer";
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
  readUnsyncedBookGains,
  unsyncedBookGainStorageKey,
  writeBookGains,
  writeUnsyncedBookGains
} from "./bookVolume";
import { compactProgressLabel, compareReadingStatus, readingStatus, readingStatusLabel } from "./bookProgress";
import {
  SHELF_VIEW_MODE_OPTIONS,
  readStoredShelfViewMode,
  writeStoredShelfViewMode
} from "./shelfView";
import type { ShelfViewMode } from "./shelfView";
import {
  bookMatchesFacet,
  bookMatchesShelfDownload,
  bookMatchesShelfSearch,
  bookMatchesShelfStatus,
  countActiveShelfFilters,
  countShelfFacet,
  EMPTY_SHELF_FILTERS,
  SHELF_FACET_PREVIEW_COUNT,
  SHELF_STATUS_OPTIONS,
  shelfDownloadScanKey,
  tagForShelfSort,
  toggleShelfFacet,
  updateShelfFacetCounts
} from "./shelfFilters";
import type {
  ShelfFacetGroupKey,
  ShelfFacetOption,
  ShelfFilters,
  ShelfStatusFilter
} from "./shelfFilters";
import { PlaybackGainChain, streamCanBeBoosted } from "./playbackGain";
import { isLibationAdding } from "./libationState";
import { displayBookDescription, enrichBooksFromLibation, tagsForBook } from "./bookMetadata";
import { buildChapterSegments, chapterAtBookPosition } from "./chapters";
import {
  bookDownloadUrl,
  activateServerAlias,
  addServerAlias,
  clearServerUrl,
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
  getFreshProgress,
  getProgress,
  getServerStorageKey,
  getServerAliases,
  getServerIdentityUrl,
  getServerUrl,
  getServerType,
  getStoredMediaToken,
  getStoredToken,
  hasUserConfiguredServer,
  SERVER_SETUP_GUIDE_URL,
  isNetworkError,
  isServerNotReadyError,
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
  addSyncAnchor,
  clearSyncAnchors,
  reconnectUsingServerAliases,
  requestLibationBook,
  playbackReportingSession,
  removeServerAlias,
  rescanLibrary,
  refreshLibroAccount,
  saveProgress,
  setBookCompletion,
  setBookVolume,
  setStoredMediaToken,
  setStoredToken,
  setUnauthorizedHandler,
  syncLibationLibrary,
  uploadAudiobook,
  uploadEbook,
  updateBookMetadata
} from "./api";
import type { ServerAlias } from "./api";
import { hasPreciseSync, syncConfirmationMessage } from "./syncGeneration";
import {
  cacheLibrary,
  cacheOfflineUser,
  cacheProgress,
  cancelBookOfflineDownload,
  downloadBookForOffline,
  forgetOfflineUser,
  getBookBackgroundDownloadStatus,
  getCachedLibrary,
  getCachedProgress,
  getOfflineCoverUrl,
  getOfflineCompanionUrl,
  getOfflineSyncMap,
  getOfflineTrackUrl,
  getOfflineUser,
  isBookDownloaded,
  loadCompanionBytes,
  releaseOfflineMediaUrl,
  removeBookDownload
} from "./offline";
import { isSupportedAudioFileName, SUPPORTED_AUDIO_EXTENSIONS } from "./mediaFiles";
import { haptic, selectionHaptic, syncStatusBarStyle } from "./native";
import { applyAppearanceMode, readStoredAppearanceMode, writeAppearanceMode } from "./appearance";
import type { AppearanceMode } from "./appearance";
import { isLeftEdgeBackSwipe } from "./nativeNavigation";
import { nativeTabItems, nativeTabSelection, type NativeTab } from "./nativeTabs";
import { useNativeTabs } from "./useNativeTabs";
import {
  disableRotationLock,
  enableRotationLock,
  isRotationLockAvailable,
  readStoredRotationLock
} from "./rotationLock";
import {
  attachNativeAudioPlayer,
  getNativeAudioRecovery,
  getNativeAudioSleepTimer,
  pauseNativeAudio,
  playNativeAudio,
  releaseNativeAudioSession,
  seekNativeAudio,
  setNativeAudioGain,
  setNativeAudioSleepTimer,
  updateNativeAudioNowPlaying,
  usesNativeAudioPlayer,
  type NativeAudioQueueTrack
} from "./nativeAudio";
import { NativeForegroundSyncGate } from "./nativeAudioState";
import { createForegroundProgressSync } from "./foregroundProgressSync";
import {
  acknowledgeCarSessions,
  addCarPlayListener,
  beginCarLibrarySession,
  clearCarLibrary,
  carPlaybackOwnsEngine,
  getCarPlayState,
  releaseCarPlaybackOwnership,
  setCarPlaybackOwner,
  supportsCarPlay,
  syncCarLibrary
} from "./carPlay";
import {
  buildCarLibrarySnapshot,
  carSessionIsWorthSaving,
  type CarPlaybackSession
} from "./carLibrary.ts";
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
import { LibroCatalog } from "./LibroCatalog";
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
import { GamesPage } from "./GameRoom";
import { readGamesEnabled, writeGamesEnabled } from "./gamePreferences";
import {
  FOLLOW_AGGRESSIVENESS_LABELS,
  FOLLOW_AGGRESSIVENESS_LEAD_SECONDS,
  readReadalongEnabled,
  writeReadalongEnabled,
  readFollowSyncEnabled,
  writeFollowSyncEnabled,
  readFollowAggressiveness,
  writeFollowAggressiveness,
  type FollowAggressiveness
} from "./readalongPreferences";
import { readerStatusLabel, summarizeSharedProgress } from "./sharedProgress";
import type {
  AlignmentStatus,
  AuthUser,
  Book,
  BookMetadataUpdate,
  Chapter,
  CompanionFile,
  FinishFeed,
  JobStatus,
  LibationBook,
  LibationDownloadRequest,
  LibationStatus,
  SyncFragment,
  SyncMap,
  Progress,
  Track
} from "./types";

const APP_STATE_STORAGE_PREFIX = "operalibre.appState";
const LIBATION_CONFIRM_TIMEOUT_MS = 12_000;
const LIBATION_READER_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;
const PROGRESS_SAVE_INTERVAL_MS = 2_000;

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
  // Whether the seek behind that generation also went backwards far enough to
  // need the server's near-zero reset guard lifted (see
  // shouldFlagIntentionalRegression). Decided when the save is queued, from
  // the seek's own target rather than from whatever the clock reads later.
  intentionalRegression: boolean;
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

function readStoredCustomSleepTimers() {
  try {
    return readCustomSleepTimers(window.localStorage);
  } catch {
    return [];
  }
}

function writeStoredCustomSleepTimers(timers: readonly number[]) {
  try {
    writeCustomSleepTimers(window.localStorage, timers);
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

/** The gain writes the server never received, kept across restarts for retry. */
function unsyncedBookGainStore(userId: string) {
  return {
    read() {
      try {
        return readUnsyncedBookGains(window.localStorage, unsyncedBookGainStorageKey(getServerStorageKey(), userId));
      } catch {
        return {};
      }
    },
    write(entries: Record<string, number>) {
      try {
        writeUnsyncedBookGains(window.localStorage, unsyncedBookGainStorageKey(getServerStorageKey(), userId), entries);
      } catch {
        // ignore storage failures
      }
    }
  };
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
  const sliderDragging = useRef(false);

  // The same tactile grammar as the speed wheel beside it: a drag ticks once
  // per decibel step, a discrete nudge (stepper button, arrow key) bumps.
  function change(next: number, source: "drag" | "step") {
    const bounded = Math.min(maximum, Math.max(BOOK_GAIN_DB_MIN, next));
    if (bounded === position) return;
    if (source === "drag") selectionHaptic("change");
    else haptic("light");
    onChange(bounded);
  }

  const slider = (
    <input
      id={inputId}
      type="range"
      min={BOOK_GAIN_DB_MIN}
      max={maximum}
      step={BOOK_GAIN_DB_STEP}
      value={position}
      aria-valuetext={formatBookGainDb(position)}
      onPointerDown={() => {
        sliderDragging.current = true;
        selectionHaptic("start");
      }}
      onPointerUp={() => {
        sliderDragging.current = false;
        selectionHaptic("end");
      }}
      onPointerCancel={() => {
        sliderDragging.current = false;
        selectionHaptic("end");
      }}
      onChange={(event) => change(Number(event.currentTarget.value), sliderDragging.current ? "drag" : "step")}
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
      <div className="book-volume-slider-row">
        <button
          type="button"
          aria-label={`Decrease amplification by ${BOOK_GAIN_DB_STEP} decibel`}
          disabled={position <= BOOK_GAIN_DB_MIN}
          onClick={() => change(position - BOOK_GAIN_DB_STEP, "step")}
        >
          <Minus size={17} />
        </button>
        {slider}
        <button
          type="button"
          aria-label={`Increase amplification by ${BOOK_GAIN_DB_STEP} decibel`}
          disabled={position >= maximum}
          onClick={() => change(position + BOOK_GAIN_DB_STEP, "step")}
        >
          <Plus size={17} />
        </button>
      </div>
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
              onClick={() => {
                if (preset !== position) haptic("light");
                onChange(preset);
              }}
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

// The API client's own timeout is generous (30 s); a startup-critical read
// that is allowed to fall back to a local copy should not wait that long.
// Before "Begin this reading" trusts a stale listing summary, the server gets
// this long to say whether the book is actually well under way elsewhere.
const START_OVER_PROGRESS_CHECK_MS = 2_500;
// The restore effect's own /progress reads; local copies cover the wait.
const RESTORE_PROGRESS_TIMEOUT_MS = 8_000;

type SortMode = "title" | "author" | "series" | "tag" | "genre" | "progress" | "duration" | "account";
type LibrarySource = "local" | "audible" | "libro";
type MetadataEditorState = {
  title: string;
  author: string;
  narrator: string;
  publisher: string;
  series: string;
  seriesPosition: string;
  tags: { name: string; position: string }[];
  publishedDate: string;
  genres: string;
  asin: string;
  description: string;
};

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "title", label: "Title" },
  { value: "author", label: "Author" },
  { value: "series", label: "Series" },
  { value: "tag", label: "Tag" },
  { value: "genre", label: "Genre" },
  { value: "progress", label: "Progress" },
  { value: "account", label: "Account" },
  { value: "duration", label: "Length" }
];

const SORT_MODE_STORAGE_KEY = "operalibre.sortMode";
const LIBRARY_SOURCES: LibrarySource[] = ["local", "audible", "libro"];

// "account" only makes sense for the Audible shelf; "series"/"genre"/"progress" only
// for the local library — an Audible row is a purchase that has not been downloaded yet,
// so it carries no progress to sort on. Sort mode is persisted per source so switching
// shelves — including across restarts, since librarySource itself always starts back at
// "local" — restores what was last chosen there instead of permanently collapsing to
// "title".
const AUDIBLE_ONLY_SORT_MODES: SortMode[] = ["account"];
const LOCAL_ONLY_SORT_MODES: SortMode[] = ["series", "tag", "genre", "progress"];

function isSortModeSupported(source: LibrarySource, mode: SortMode) {
  if (source === "libro") return ["title", "author", "duration"].includes(mode);
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
  // Storage unavailable reads as null — the shelf opens on the default sort.
  const stored = readStoredValue(sortModeStorageKey(source));
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

function bookSortGroupLabel(book: Book, sortMode: SortMode, selectedTags: string[]) {
  if (sortMode === "series") return book.metadata.series?.trim() || "Standalone";
  if (sortMode === "tag") return tagForShelfSort(book, selectedTags)?.name.trim() || "Untagged";
  if (sortMode === "genre") return book.genres[0]?.trim() || "Uncategorized";
  if (sortMode === "progress") return readingStatusLabel(readingStatus(book));
  return null;
}

// The caption above each run of rows, naming what the run is grouped by. Only the
// modes bookSortGroupLabel groups ever reach this.
function bookSortGroupCaption(sortMode: SortMode) {
  if (sortMode === "series") return "Series";
  if (sortMode === "tag") return "Tag";
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
    tags: tagsForBook(book).map((tag) => ({
      name: tag.name,
      position: tag.position ?? ""
    })),
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
    tags: form.tags
      .map((tag) => ({
        name: tag.name.trim(),
        position: tag.position.trim() || null
      }))
      .filter((tag) => tag.name),
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

/** Formats the browser can show inline; anything else gets an "Open" link. */
function canPreviewCompanion(extension: string) {
  const lower = extension.toLowerCase();
  return lower === "epub" || lower === "pdf" || lower === "txt" || lower === "html" || lower === "htm";
}

/** Pseudo companion id for the picture gallery tab. */
const GALLERY_COMPANION_ID = "__gallery__";

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

// Merely touching window.localStorage throws when site data is blocked, and
// setItem throws under quota pressure; neither should take the app down.
function readStoredValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage failures
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

type FragmentRange = { index: number; start: number; end: number };

/**
 * Where every fragment of the displayed document sits in its search index,
 * found in order so a repeated sentence lands on its own occurrence. Sorted
 * by position so a tap can be resolved with one scan.
 */
function locateFragments(index: DocumentSearchIndex, fragments: SyncFragment[], href: string): FragmentRange[] {
  const ranges: FragmentRange[] = [];
  let cursor = 0;
  fragments.forEach((fragment, position) => {
    if (!hrefsMatch(href, fragment.href)) {
      return;
    }
    const needle = normalizeSyncNeedle(fragment.text);
    if (!needle) {
      return;
    }
    let at = index.text.indexOf(needle, cursor);
    if (at === -1) {
      at = index.text.indexOf(needle);
      if (at === -1) {
        return;
      }
    }
    ranges.push({ index: position, start: at, end: at + needle.length });
    cursor = at + needle.length;
  });
  return ranges.sort((a, b) => a.start - b.start);
}

/** The fragment a tap at `position` belongs to: the last one that starts at or before it. */
function fragmentAtIndexPosition(ranges: FragmentRange[], position: number) {
  let best = -1;
  for (const range of ranges) {
    if (range.start > position) {
      break;
    }
    best = range.index;
  }
  return best;
}

/** The search-index position of a caret inside a text node, or -1. */
function indexPositionForCaret(index: DocumentSearchIndex, node: Node, offset: number) {
  if (node.nodeType !== Node.TEXT_NODE) {
    // A caret on an element: use its first text node.
    const walker = index.doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode();
    if (!first) {
      return -1;
    }
    node = first;
    offset = 0;
  }
  let last = -1;
  for (let position = 0; position < index.map.length; position += 1) {
    const entry = index.map[position];
    if (entry.node !== node) {
      continue;
    }
    if (entry.offset >= offset) {
      return position;
    }
    last = position;
  }
  return last;
}

/** Whether a point lies on one of the text node's line boxes (with a little slack). */
function pointOnText(node: Node, x: number, y: number): boolean {
  const doc = node.ownerDocument;
  if (!doc || node.nodeType !== Node.TEXT_NODE) {
    return false;
  }
  const range = doc.createRange();
  range.selectNodeContents(node);
  const slack = 6;
  for (const rect of Array.from(range.getClientRects())) {
    if (x >= rect.left - slack && x <= rect.right + slack && y >= rect.top - slack && y <= rect.bottom + slack) {
      return true;
    }
  }
  return false;
}

/** The text position under a point in the reader document, on any browser. */
function caretAtPoint(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const withCaret = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof withCaret.caretPositionFromPoint === "function") {
    const caret = withCaret.caretPositionFromPoint(x, y);
    return caret ? { node: caret.offsetNode, offset: caret.offset } : null;
  }
  if (typeof withCaret.caretRangeFromPoint === "function") {
    const range = withCaret.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

/** Marker colours for the narrated sentence, per reading theme. */
function sentenceHighlightStyle(theme: ReaderTheme, precision: SyncPrecision | null) {
  // The night page is dark, so the marker must lighten instead of darken.
  const soft = precision === "estimated";
  return theme === "night"
    ? { fill: "#e8b64c", "fill-opacity": soft ? "0.22" : "0.4", "mix-blend-mode": "screen" }
    : { fill: "#d9a441", "fill-opacity": soft ? "0.18" : "0.32", "mix-blend-mode": "multiply" };
}

export function EpubReadalong({
  bookId,
  storageScope,
  title,
  url,
  loadBytes,
  listeningChapter,
  syncTarget,
  syncFragments,
  precision,
  positionSeconds,
  followLeadSeconds = 0,
  onSeekTo,
  onPinNarration,
  immersive = false,
  onClose,
  chapterTitle = null,
  positionLabel = null,
  playback = null,
  onListen,
  syncTools = null,
  companionSwitcher = null
}: {
  bookId: string;
  storageScope: string;
  title: string;
  url: string;
  /** Reads the ebook, from the device when a copy is already there. */
  loadBytes?: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  listeningChapter: string | null;
  syncTarget: EpubSyncTarget | null;
  syncFragments: SyncFragment[] | null;
  precision: SyncPrecision | null;
  positionSeconds: number;
  /** A small optional lead for switching to the next narrated sentence. */
  followLeadSeconds?: number;
  onSeekTo?: (seconds: number) => void;
  /** "The narrator is reading this sentence now": re-times an estimated map. */
  onPinNarration?: (fragment: { href: string; text: string }) => void;
  /** A full-screen reading surface with its own bars and sheets (the native app). */
  immersive?: boolean;
  onClose?: () => void;
  chapterTitle?: string | null;
  positionLabel?: string | null;
  /** Transport for the book being read, when it is the one playing. */
  playback?: {
    playing: boolean;
    speed: number;
    sleepRemaining: number;
    onToggle: () => void;
    onSkip: (delta: number) => void;
    /** Open the app's speed, sleep timer, or chapter sheet over the reader. */
    onOpen: (sheet: "speed" | "sleep" | "chapters") => void;
  } | null;
  /** Start playing this book, offered when it is not the one playing. */
  onListen?: () => void;
  /** App-level sync actions and notices, shown in the appearance sheet. */
  syncTools?: ReactNode;
  /** Switcher for the book's other files, shown in the contents sheet. */
  companionSwitcher?: ReactNode;
}) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<EpubBook | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const syncedTargetRef = useRef<string | null>(null);
  const epubCfiClassRef = useRef<typeof EpubCFI | null>(null);
  const searchIndexRef = useRef<DocumentSearchIndex | null>(null);
  const searchCursorRef = useRef(0);
  const fragmentRangesRef = useRef<{ doc: Document; href: string; ranges: FragmentRange[] } | null>(null);
  const highlightCfiRef = useRef<string | null>(null);
  const narratedRangeRef = useRef<{ index: DocumentSearchIndex; start: number; length: number; contents: Contents } | null>(null);
  const highlightThemeRef = useRef<ReaderTheme | null>(null);
  const highlightedFragmentRef = useRef(-1);
  const autoNavHrefRef = useRef<string | null>(null);
  const lastLocationRef = useRef<Location | null>(null);
  const locationRef = useRef<Location | null>(null);
  // The place being read, as a CFI: what the reader reopens to and turns
  // back to after a resize or reflow. It only moves once its page has gone
  // off screen, so a relayout that starts the same page a few words earlier
  // does not walk the remembered place backwards on every reopen.
  const anchorCfiRef = useRef<string | null>(null);
  // While the reader is putting the page back where it was — opening the
  // book, or laying it out again after a resize or a text-size change — it
  // passes through the pages between the top of the chapter and the
  // remembered place. Until it arrives, those pages must not be mistaken
  // for somewhere the listener turned to.
  const restoringUntilRef = useRef(0);
  // Set once the listener turns a page themselves: the reader stops putting
  // the page back and follows them instead.
  const handNavigatedRef = useRef(false);
  const readerNavigationVersionRef = useRef(0);
  const beginRestore = useCallback(() => {
    // A deadline, so a place that never resolves cannot freeze the anchor.
    restoringUntilRef.current = performance.now() + 5000;
  }, []);
  const syncFragmentsRef = useRef<SyncFragment[] | null>(syncFragments);
  const syncTargetRef = useRef<EpubSyncTarget | null>(syncTarget);
  const onSeekToRef = useRef(onSeekTo);
  const loadBytesRef = useRef(loadBytes);
  const onPinNarrationRef = useRef(onPinNarration);
  // Set while the listener is choosing the sentence being narrated: the next
  // tap places a sync anchor instead of seeking.
  const [pinning, setPinning] = useState(false);
  const pinningRef = useRef(false);
  pinningRef.current = pinning;
  // Bumped whenever the page reflows (text size, zoom, window resize): the
  // markers were measured against the old layout and the narrated sentence
  // may have moved to another page.
  const [relayoutTick, setRelayoutTick] = useState(0);
  const handledRelayoutRef = useRef(0);
  const attachedDocsRef = useRef<WeakSet<Document>>(new WeakSet());
  const touchStartRef = useRef<{ x: number; y: number; at: number } | null>(null);
  // When a tap was handled on touchend, the click iOS may still send for it
  // must not be handled again.
  const lastTouchTapRef = useRef(0);
  const readerUrlRef = useRef(url);
  if (readerUrlRef.current !== url) {
    readerUrlRef.current = url;
    lastLocationRef.current = null;
    anchorCfiRef.current = null;
    restoringUntilRef.current = 0;
    handNavigatedRef.current = false;
  }
  syncFragmentsRef.current = syncFragments;
  syncTargetRef.current = syncTarget;
  onSeekToRef.current = onSeekTo;
  loadBytesRef.current = loadBytes;
  onPinNarrationRef.current = onPinNarration;
  const [toc, setToc] = useState<Array<NavItem & { depth: number }>>([]);
  const [location, setLocation] = useState<Location | null>(null);
  const [activeHref, setActiveHref] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  // The book is still downloading or unpacking after a while: worth a word
  // to the listener, never a reason to give up on a slow connection.
  const [slowToOpen, setSlowToOpen] = useState(false);
  const [follow, setFollowState] = useState(() => readStoredValue("operalibre.readerFollow") !== "0");
  const setFollow = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
    setFollowState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      writeStoredValue("operalibre.readerFollow", next ? "1" : "0");
      return next;
    });
  }, []);
  const [readerThemeChoice, setReaderThemeChoice] = useState<ReaderThemeChoice>(() =>
    readReaderThemeChoice()
  );
  // Whether the app is in its dark look, for the auto theme; follows the
  // system theme and the iOS appearance setting while the reader is open.
  const [appDark, setAppDark] = useState(currentAppPrefersDark);
  useEffect(() => watchAppPrefersDark(setAppDark), []);
  const readerTheme = resolveReaderTheme(readerThemeChoice, appDark);
  const [fontScale, setFontScale] = useState(() => {
    const stored = Number(readStoredValue("operalibre.readerFontScale"));
    return Number.isFinite(stored) && stored >= 85 && stored <= 140 ? stored : 100;
  });
  // The look a freshly opened book is styled with, and what the open one has
  // been given so far, so a change re-styles it exactly once.
  const readerThemeRef = useRef(readerTheme);
  readerThemeRef.current = readerTheme;
  const fontScaleRef = useRef(fontScale);
  fontScaleRef.current = fontScale;
  const appliedThemeRef = useRef<ReaderTheme | null>(null);
  const appliedFontScaleRef = useRef<number | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  // Full screen: the native reader always, the web reader in focus mode. The
  // bars fade out for reading and a tap on blank page brings them back.
  const fullscreen = immersive || focusMode;
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const [chromeHidden, setChromeHidden] = useState(false);
  const chromeHiddenRef = useRef(chromeHidden);
  chromeHiddenRef.current = chromeHidden;
  const [sheet, setSheet] = useState<"contents" | "appearance" | null>(null);
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const locationStorageKey = readerStorageKey(storageScope, bookId, "location");
  const openingPreferenceKey = `operalibre.reader.${storageScope}.opening`;
  const returnLocationKey = `${locationStorageKey}.return.${url.split("?")[0]}`;
  const [openAtListening, setOpenAtListening] = useState(() => readStoredValue(openingPreferenceKey) === "listening");
  // Freeze the launch decision. Later audio updates only refresh the manual action.
  const openingChoiceRef = useRef({
    enabled: openAtListening,
    chapter: listeningChapter,
    following: follow && (!!syncTarget || !!syncFragments?.length)
  });
  const [returnLocation, setReturnLocation] = useState(() => readStoredValue(returnLocationKey));
  const [catchUpCfi, setCatchUpCfi] = useState<string | null>(null);
  const [catchUpNotice, setCatchUpNotice] = useState("");
  const [offerOpeningPreference, setOfferOpeningPreference] = useState(false);
  const [catchUpBusy, setCatchUpBusy] = useState(false);
  const changeOpeningPreference = (enabled: boolean) => {
    setOpenAtListening(enabled);
    writeStoredValue(openingPreferenceKey, enabled ? "listening" : "reading");
    setOfferOpeningPreference(false);
  };
  const sheetRootRef = useRef<HTMLElement | null>(null);
  // A long table of contents opens on the chapter being read, not at the top.
  // The scroll runs after the sheet has settled to its card height and moves
  // only the sheet's own scrollbar (scrollIntoView would scroll ancestors and
  // make the sheet flash full-height as it opens).
  useEffect(() => {
    if (sheet !== "contents") {
      return;
    }
    const raf = requestAnimationFrame(() => {
      const root = sheetRootRef.current;
      const current = root?.querySelector<HTMLElement>(".epub-toc button.current");
      if (!root || !current) {
        return;
      }
      root.scrollTop = Math.max(0, current.offsetTop - root.clientHeight / 2 + current.offsetHeight / 2);
    });
    return () => cancelAnimationFrame(raf);
  }, [sheet]);

  const resumeFollowing = useCallback(() => {
    highlightedFragmentRef.current = -1;
    // Let the chapter-sync effect re-open the playing chapter on the next run.
    syncedTargetRef.current = null;
    setFollow(true);
  }, []);

  // What a tap on a sentence does: seek there, or, while pinning, tell the
  // server the narrator is reading it now.
  const tapFragment = useCallback((fragment: SyncFragment) => {
    if (pinningRef.current) {
      setPinning(false);
      onPinNarrationRef.current?.({ href: fragment.href, text: fragment.text });
      return;
    }
    onSeekToRef.current?.(fragment.startSeconds);
    highlightedFragmentRef.current = -1;
    setFollow(true);
  }, []);

  // Turning a page by hand means the listener wants to read ahead (or
  // back); the narration marker must not drag the page away again until they
  // ask to return.
  const navigateByHand = useCallback((action: () => unknown) => {
    readerNavigationVersionRef.current += 1;
    // Chapter-level following pulls the page just as a sentence marker does,
    // so a page turned by hand has to stop that too, or the reader is
    // dragged back to the narrator's chapter on the next run.
    const followingNarration =
      (syncFragmentsRef.current?.length ?? 0) > 0 || !!syncTargetRef.current;
    if (followingNarration) {
      setFollow(false);
    }
    // The listener is driving now; where they stop is the remembered place.
    handNavigatedRef.current = true;
    restoringUntilRef.current = 0;
    readerDebugLog("hand");
    void action();
  }, []);

  const ensureSearchIndex = useCallback((doc: Document) => {
    if (!searchIndexRef.current || searchIndexRef.current.doc !== doc) {
      searchIndexRef.current = buildDocumentSearchIndex(doc);
      searchCursorRef.current = 0;
      fragmentRangesRef.current = null;
    }
    return searchIndexRef.current;
  }, []);

  // WKWebView does not deliver taps made on the epub iframe's own document to
  // its listeners, so in the full-screen reader an app-layer overlay catches
  // taps instead (the reader chrome, in this same layer, receives them
  // reliably). The overlay reports a page-relative x and the tapped point in
  // window coordinates; this resolves the point to a page turn, a sentence
  // seek, or a bar toggle.
  const handleOverlayTap = useCallback(
    (xFraction: number, clientX: number, clientY: number) => {
      const rendition = renditionRef.current;
      if (xFraction < 0.25) {
        navigateByHand(() => rendition?.prev());
        return;
      }
      if (xFraction > 0.75) {
        navigateByHand(() => rendition?.next());
        return;
      }
      // Middle: seek to the tapped sentence, if the tap landed on one.
      const contentsList = ([] as Contents[]).concat(
        (rendition?.getContents() as unknown as Contents[]) ?? []
      );
      const contents = contentsList.find((candidate) => candidate?.document?.body);
      const doc = contents?.document;
      const frame = doc?.defaultView?.frameElement as HTMLElement | undefined;
      const fragments = syncFragmentsRef.current;
      if (doc && frame && fragments && fragments.length > 0) {
        const frameBox = frame.getBoundingClientRect();
        const innerX = clientX - frameBox.left;
        const innerY = clientY - frameBox.top;
        const caret = caretAtPoint(doc, innerX, innerY);
        if (caret && pointOnText(caret.node, innerX, innerY)) {
          const index = ensureSearchIndex(doc);
          const position = indexPositionForCaret(index, caret.node, caret.offset);
          if (position >= 0) {
            const href = locationRef.current?.start?.href ?? "";
            if (
              !fragmentRangesRef.current ||
              fragmentRangesRef.current.doc !== doc ||
              fragmentRangesRef.current.href !== href
            ) {
              fragmentRangesRef.current = { doc, href, ranges: locateFragments(index, fragments, href) };
            }
            const fragmentIndex = fragmentAtIndexPosition(fragmentRangesRef.current.ranges, position);
            if (fragmentIndex >= 0) {
              tapFragment(fragments[fragmentIndex]);
              return;
            }
          }
        }
      }
      setChromeHidden((hidden) => !hidden);
    },
    [ensureSearchIndex, navigateByHand, tapFragment]
  );

  // A horizontal swipe on the overlay turns the page as well.
  const overlaySwipeRef = useRef<{ x: number; y: number } | null>(null);
  const handleOverlayPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    overlaySwipeRef.current = { x: event.clientX, y: event.clientY };
  }, []);
  const handleOverlayPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = overlaySwipeRef.current;
      overlaySwipeRef.current = null;
      const rendition = renditionRef.current;
      const stage = viewerRef.current?.getBoundingClientRect();
      if (!start || !stage || stage.width === 0) {
        return;
      }
      const deltaX = event.clientX - start.x;
      const deltaY = event.clientY - start.y;
      if (Math.abs(deltaX) > 55 && Math.abs(deltaY) < 45) {
        navigateByHand(() => (deltaX < 0 ? rendition?.next() : rendition?.prev()));
        return;
      }
      if (Math.abs(deltaX) < 16 && Math.abs(deltaY) < 16) {
        handleOverlayTap((event.clientX - stage.left) / stage.width, event.clientX, event.clientY);
      }
    },
    [handleOverlayTap]
  );

  useEffect(() => {
    if (!viewerRef.current) {
      return;
    }

    let cancelled = false;
    const debugLog = (entry: string) => {
      if (import.meta.env.DEV) {
        const debugWindow = window as unknown as { __operalibreReaderOpens?: string[] };
        debugWindow.__operalibreReaderOpens = [...(debugWindow.__operalibreReaderOpens ?? []), `${Math.round(performance.now())}:${entry}`];
      }
    };
    debugLog(`effect:${url.slice(-8)}:${locationStorageKey.slice(-12)}`);
    setToc([]);
    setLocation(null);
    setActiveHref("");
    setError(null);
    setErrorDetail(null);
    setIsReady(false);
    setSlowToOpen(false);
    syncedTargetRef.current = null;
    handNavigatedRef.current = false;
    searchIndexRef.current = null;
    searchCursorRef.current = 0;
    fragmentRangesRef.current = null;
    highlightCfiRef.current = null;
    narratedRangeRef.current = null;
    highlightedFragmentRef.current = -1;
    autoNavHrefRef.current = null;
    attachedDocsRef.current = new WeakSet();

    const abortController = new AbortController();
    let readyTimeout: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let book: EpubBook | null = null;
    let rendition: Rendition | null = null;
    const handleRelocated = (nextLocation: Location) => {
      lastLocationRef.current = nextLocation;
      locationRef.current = nextLocation;
      setLocation(nextLocation);
      setIsReady(true);
      if (import.meta.env.DEV) {
        const container = viewerRef.current?.querySelector<HTMLElement>(".epub-container");
        debugLog(
          `relocated:${nextLocation.start?.cfi}..${nextLocation.end?.cfi}:p${nextLocation.start?.displayed?.page}/${nextLocation.start?.displayed?.total}:sl${container?.scrollLeft}/${container?.clientWidth}/${container?.scrollWidth}:anchor=${anchorCfiRef.current}`
        );
      }
      const EpubCfiClass = epubCfiClassRef.current;
      const restoring = performance.now() < restoringUntilRef.current;
      const update = anchorAfterRelocation(
        anchorCfiRef.current,
        { start: nextLocation.start?.cfi, end: nextLocation.end?.cfi },
        (a, b) => (EpubCfiClass ? new EpubCfiClass().compare(a, b) : 0),
        restoring
      );
      if (update.arrived) {
        restoringUntilRef.current = 0;
      }
      readerDebugLog(
        `reloc ${restoring ? "restoring" : "settled"} p${nextLocation.start?.displayed?.page}/${nextLocation.start?.displayed?.total} start=${shortCfi(nextLocation.start?.cfi)} anchor=${shortCfi(anchorCfiRef.current)}->${shortCfi(update.anchor)}${update.arrived ? " arrived" : ""}`
      );
      if (update.anchor && update.anchor !== anchorCfiRef.current) {
        anchorCfiRef.current = update.anchor;
        writeStoredValue(locationStorageKey, update.anchor);
      }
    };

    // Tapping a sentence seeks the audio to it and resumes following. The
    // narrated sentence's own marker has its own click handler (an SVG
    // overlay), so clicks landing on that overlay are left to it.
    // The narrated sentence under a tap, if the tap landed on one.
    const fragmentUnderTap = (doc: Document, clientX: number, clientY: number): SyncFragment | null => {
      const fragments = syncFragmentsRef.current;
      if (!fragments || fragments.length === 0) {
        return null;
      }
      const caret = caretAtPoint(doc, clientX, clientY);
      // Caret lookup snaps to the nearest text; a tap in a margin must not
      // read as a tap on the closest sentence.
      if (!caret || !pointOnText(caret.node, clientX, clientY)) {
        return null;
      }
      const index = ensureSearchIndex(doc);
      const position = indexPositionForCaret(index, caret.node, caret.offset);
      if (position < 0) {
        return null;
      }
      const href = locationRef.current?.start?.href ?? "";
      if (
        !fragmentRangesRef.current ||
        fragmentRangesRef.current.doc !== doc ||
        fragmentRangesRef.current.href !== href
      ) {
        fragmentRangesRef.current = { doc, href, ranges: locateFragments(index, fragments, href) };
      }
      const fragmentIndex = fragmentAtIndexPosition(fragmentRangesRef.current.ranges, position);
      return fragmentIndex < 0 ? null : fragments[fragmentIndex];
    };
    const handleTap = (doc: Document, target: Element | null, clientX: number, clientY: number) => {
      if (target?.closest?.("a, button, input, textarea, select, svg")) {
        return;
      }
      // Full screen reads like a paper book: the outer quarters of the page
      // turn it, the middle seeks to the tapped sentence, and a tap on nothing
      // in particular shows or hides the bars.
      if (fullscreenRef.current) {
        // The chapter is one wide, scrolled document; the visible page is
        // the stage's box in the app's own coordinates.
        const frame = doc.defaultView?.frameElement;
        const stage = viewerRef.current?.getBoundingClientRect();
        if (frame && stage && stage.width > 0) {
          const x = (frame.getBoundingClientRect().left + clientX - stage.left) / stage.width;
          if (x < 0.25) {
            navigateByHand(() => rendition?.prev());
            return;
          }
          if (x > 0.75) {
            navigateByHand(() => rendition?.next());
            return;
          }
        }
      }
      const fragment = fragmentUnderTap(doc, clientX, clientY);
      if (fragment) {
        tapFragment(fragment);
      } else if (fullscreenRef.current) {
        setChromeHidden((hidden) => !hidden);
      }
    };
    const handleContentClick = (event: MouseEvent) => {
      // A tap already handled on touchend; iOS may still send its click.
      if (performance.now() - lastTouchTapRef.current < 700) {
        return;
      }
      const doc = (event.target as Node | null)?.ownerDocument;
      if (doc) {
        handleTap(doc, event.target as Element | null, event.clientX, event.clientY);
      }
    };
    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY, at: performance.now() } : null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      event.preventDefault();
    };
    const handleTouchEnd = (event: TouchEvent) => {
      const start = touchStartRef.current;
      const touch = event.changedTouches[0];
      touchStartRef.current = null;
      if (!start || !touch) {
        return;
      }
      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      // iOS withholds the click for a touch whose move was cancelled (the
      // scroll lock above), and a finger rarely lands perfectly still, so a
      // tap is recognised here rather than waited for as a click.
      if (Math.abs(deltaX) < 12 && Math.abs(deltaY) < 12 && performance.now() - start.at < 600) {
        const target = event.target as Element | null;
        if (target?.closest?.("a, button, input, textarea, select")) {
          return;
        }
        lastTouchTapRef.current = performance.now();
        const doc = (event.target as Node | null)?.ownerDocument;
        if (doc) {
          handleTap(doc, target, touch.clientX, touch.clientY);
        }
        return;
      }
      if (Math.abs(deltaX) < 60 || Math.abs(deltaY) > 50) {
        return;
      }
      navigateByHand(() => (deltaX < 0 ? rendition?.next() : rendition?.prev()));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        navigateByHand(() => rendition?.next());
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        navigateByHand(() => rendition?.prev());
      }
    };
    const attachToDocument = (doc: Document) => {
      if (attachedDocsRef.current.has(doc)) {
        return;
      }
      attachedDocsRef.current.add(doc);
      doc.addEventListener("click", handleContentClick);
      doc.addEventListener("touchstart", handleTouchStart, { passive: true });
      // A paginated chapter is one wide, column-laid-out document. iOS lets a
      // finger drag it sideways (and the page behind it) even with overflow
      // hidden, which tears the page mid-column whenever the reader isn't
      // actively snapping back to the narration. Pages turn by swipe or tap.
      doc.addEventListener("touchmove", handleTouchMove, { passive: false });
      doc.addEventListener("touchend", handleTouchEnd);
      doc.addEventListener("keydown", handleKeyDown);
    };
    const handleRendered = () => {
      debugLog("rendered");
      setIsReady(true);
      const contentsList = ([] as Contents[]).concat(
        (rendition?.getContents() as unknown as Contents[]) ?? []
      );
      for (const contents of contentsList) {
        if (contents?.document) {
          attachToDocument(contents.document);
        }
      }
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
            setSlowToOpen(true);
          }
        }, 12000);

        const data = loadBytesRef.current
          ? await loadBytesRef.current(url, abortController.signal)
          : await (async () => {
              const response = await fetch(url, {
                credentials: "include",
                signal: abortController.signal
              });
              if (!response.ok) {
                throw new Error(`EPUB request failed with ${response.status}`);
              }
              return response.arrayBuffer();
            })();
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

        // Keep touch from scrolling the chapter document itself; navigation
        // is by page turn only.
        const readerLockRules = {
          html: { "touch-action": "none !important", "overscroll-behavior": "none !important" }
        };
        // One stylesheet for every look; the colours come from custom
        // properties set per theme (see applyReaderThemeColors).
        rendition.themes.register("operalibre", {
          body: {
            color: "var(--reader-ink) !important",
            background: "var(--reader-page) !important",
            "font-family": "Georgia, 'Times New Roman', serif !important",
            "line-height": "1.78 !important",
            padding: "0 5% !important",
            // The narrow phone column plus em-dash-joined words makes justified
            // text open large gaps between words; left align reads cleanly and
            // hyphenation keeps the ragged edge tidy.
            "text-align": "left !important",
            "-webkit-hyphens": "auto",
            hyphens: "auto"
          },
          p: {
            "margin-bottom": "1.15em !important",
            "text-align": "left !important",
            "-webkit-hyphens": "auto",
            hyphens: "auto"
          },
          "p, li, blockquote, div": { "text-align": "left !important" },
          a: { color: "var(--reader-link) !important" },
          img: { "max-width": "100% !important", height: "auto !important" },
          ...readerLockRules
        });

        // Style the pages before the first one is laid out. Applying the
        // theme and text size afterwards reflows the chapter under a stage
        // still scrolled to the old page, which then shows earlier words than
        // the remembered place, and that earlier page gets saved in its turn.
        rendition.themes.select("operalibre");
        applyReaderThemeColors(rendition.themes, readerThemeRef.current);
        rendition.themes.fontSize(`${fontScaleRef.current}%`);
        appliedThemeRef.current = readerThemeRef.current;
        appliedFontScaleRef.current = fontScaleRef.current;

        bookRef.current = book;
        renditionRef.current = rendition;
        rendition.on("relocated", handleRelocated);
        rendition.on("rendered", handleRendered);
        if (import.meta.env.DEV) {
          // Inspectable from the console while developing the reader.
          const debugWindow = window as unknown as { __operalibreReader?: unknown; __operalibreReaderOpens?: string[] };
          debugWindow.__operalibreReader = { book, rendition };
          debugWindow.__operalibreReaderOpens = [...(debugWindow.__operalibreReaderOpens ?? []), `${Math.round(performance.now())}:${url.slice(-12)}`];
        }

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

        // Reopen where the listener left off; when narration is being
        // followed the marker moves the page again as soon as it is known.
        const savedLocation = readStoredValue(locationStorageKey);
        readerDebugLog(`stored=${shortCfi(savedLocation)} last=${shortCfi(lastLocationRef.current?.start?.cfi)}`);
        let startAt = anchorCfiRef.current ?? savedLocation;
        const originalLocation = startAt;
        const openingChoice = openingChoiceRef.current;
        // Consume this once, including failed matches and loads. Reflow never retries it.
        openingChoiceRef.current = { enabled: false, chapter: null, following: false };
        if (openingChoice.enabled && !openingChoice.following) {
          try {
            const navigation = await book.loaded.navigation;
            const target = await resolveListeningCfi(book, flattenToc(navigation.toc), openingChoice.chapter);
            if (cancelled) return;
            if (!handNavigatedRef.current && canCatchUp(startAt, target, (a, b) => new epubModule.EpubCFI().compare(a, b))) {
              writeStoredValue(returnLocationKey, startAt!);
              setReturnLocation(startAt);
              startAt = target;
              setCatchUpNotice(`Opened at ${openingChoice.chapter}.`);
            }
          } catch {
            // An unavailable chapter preserves the saved reading place.
          }
        }
        anchorCfiRef.current = startAt;
        debugLog(`display:${startAt}`);
        readerDebugLog(`open saved=${shortCfi(startAt)}`);
        if (startAt) {
          beginRestore();
        }
        try {
          await rendition.display(startAt ?? undefined);
          if (!cancelled && startAt && startAt !== originalLocation) writeStoredValue(locationStorageKey, startAt);
        } catch (error) {
          // A remembered place that no longer resolves (the file was
          // replaced) must not keep the book from opening at all.
          if (!startAt || cancelled) {
            throw error;
          }
          console.warn("EPUB remembered place could not be opened", error);
          readerDebugLog(`open failed ${String(error).slice(0, 60)}`);
          anchorCfiRef.current = originalLocation;
          setCatchUpNotice("");
          beginRestore();
          try {
            await rendition.display(originalLocation ?? undefined);
          } catch {
            anchorCfiRef.current = null;
            restoringUntilRef.current = 0;
            await rendition.display();
          }
        }
        // The listener left off here, so this is where the book opens; the
        // chapter being played counts as already handled. It takes the page
        // only once the narration moves on to a different chapter.
        if (anchorCfiRef.current) {
          syncedTargetRef.current = syncTargetRef.current?.id ?? null;
        }
        // The chapter's pictures and web fonts arrive after the first
        // layout and push the text along, so the page epub.js first shows
        // for a remembered place is usually an earlier one. Check back while
        // the layout settles and turn to the place again if it has moved off
        // the page — unless the listener has started reading somewhere else.
        void (async () => {
          for (const delay of [300, 700, 1400, 2500]) {
            await new Promise((resolve) => window.setTimeout(resolve, delay));
            const anchor = anchorCfiRef.current;
            const EpubCfiClass = epubCfiClassRef.current;
            const page = locationRef.current;
            if (cancelled || handNavigatedRef.current || !anchor || !rendition) {
              return;
            }
            if (!EpubCfiClass || !page?.start?.cfi || !page.end?.cfi) {
              continue;
            }
            const compare = (a: string, b: string) => new EpubCfiClass().compare(a, b);
            if (anchorOnPage(anchor, { start: page.start.cfi, end: page.end.cfi }, compare)) {
              continue;
            }
            readerDebugLog(`settle back to ${shortCfi(anchor)} from ${shortCfi(page.start.cfi)}`);
            beginRestore();
            try {
              await rendition.display(anchor);
            } catch {
              return;
            }
          }
        })();
        if (!cancelled) {
          setIsReady(true);
          setSlowToOpen(false);
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
      // epub.js only gains a view manager once it has attached; a resize
      // before then throws inside the observer callback.
      const attached = !!(rendition as unknown as { manager?: unknown } | null)?.manager;
      if (bounds && bounds.width > 0 && bounds.height > 0 && rendition && attached) {
        // epub.js re-lays the chapter out and turns to the given place; left
        // to itself it would turn to the old page's first words instead,
        // which lands a little earlier with every pass.
        debugLog(`resize:${Math.floor(bounds.width)}x${Math.floor(bounds.height)}:anchor=${anchorCfiRef.current}`);
        readerDebugLog(
          `resize ${Math.floor(bounds.width)}x${Math.floor(bounds.height)} anchor=${shortCfi(anchorCfiRef.current)}`
        );
        if (anchorCfiRef.current) {
          beginRestore();
        }
        (rendition as unknown as { resize(width: number, height: number, cfi?: string): void }).resize(
          Math.floor(bounds.width),
          Math.floor(bounds.height),
          anchorCfiRef.current ?? undefined
        );
        setRelayoutTick((tick) => tick + 1);
      }
    });
    resizeObserver.observe(viewerRef.current);
    void openBook();

    return () => {
      cancelled = true;
      debugLog("cleanup");
      readerDebugLog(`close anchor=${shortCfi(anchorCfiRef.current)}`);
      abortController.abort();
      if (readyTimeout !== null) {
        window.clearTimeout(readyTimeout);
      }
      resizeObserver?.disconnect();
      // epub.js teardown throws when a rendition is destroyed before it has
      // attached (the reader closed while the book was still opening), and a
      // throw here would unmount the whole app.
      try {
        rendition?.off("relocated", handleRelocated);
        rendition?.off("rendered", handleRendered);
        rendition?.destroy();
      } catch (error) {
        console.warn("EPUB rendition teardown failed", error);
      }
      try {
        book?.destroy();
      } catch (error) {
        console.warn("EPUB book teardown failed", error);
      }
      renditionRef.current = null;
      bookRef.current = null;
    };
  }, [beginRestore, ensureSearchIndex, locationStorageKey, navigateByHand, returnLocationKey, tapFragment, url]);

  useEffect(() => {
    const book = bookRef.current;
    if (!isReady || !book) return;
    let cancelled = false;
    setCatchUpCfi(null);
    void resolveListeningCfi(book, toc, listeningChapter).then((target) => {
      if (!cancelled) setCatchUpCfi(target);
    }).catch(() => { /* A chapter that cannot be resolved is not offered. */ });
    return () => { cancelled = true; };
  }, [isReady, toc, listeningChapter]);

  const moveReaderTo = async (target: string, returning: boolean) => {
    const rendition = renditionRef.current;
    const previous = anchorCfiRef.current;
    if (!rendition || !previous || catchUpBusy) return;
    const navigationVersion = ++readerNavigationVersionRef.current;
    setCatchUpBusy(true);
    if (!returning) {
      writeStoredValue(returnLocationKey, previous);
      setReturnLocation(previous);
    }
    setFollow(false);
    handNavigatedRef.current = true;
    anchorCfiRef.current = target;
    beginRestore();
    try {
      await rendition.display(target);
      if (renditionRef.current !== rendition || readerNavigationVersionRef.current !== navigationVersion) return;
      writeStoredValue(locationStorageKey, target);
      setCatchUpNotice(returning ? "Returned to your previous reading place." : `Moved to ${listeningChapter}.`);
      setOfferOpeningPreference(!returning && !openAtListening);
    } catch {
      if (renditionRef.current !== rendition || readerNavigationVersionRef.current !== navigationVersion) return;
      anchorCfiRef.current = previous;
      beginRestore();
      await rendition.display(previous).catch(() => undefined);
      setCatchUpNotice("That place could not be opened. Your reading place is saved.");
    } finally {
      setCatchUpBusy(false);
    }
  };

  useEffect(() => {
    writeReaderThemeChoice(readerThemeChoice);
  }, [readerThemeChoice]);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (isReady && rendition && appliedThemeRef.current !== readerTheme) {
      applyReaderThemeColors(rendition.themes, readerTheme);
      appliedThemeRef.current = readerTheme;
    }
  }, [isReady, readerTheme]);

  useEffect(() => {
    writeStoredValue("operalibre.readerFontScale", String(fontScale));
    const rendition = renditionRef.current;
    if (!isReady || !rendition || appliedFontScaleRef.current === fontScale) {
      return;
    }
    appliedFontScaleRef.current = fontScale;
    rendition.themes.fontSize(`${fontScale}%`);
    readerDebugLog(`fontScale ${fontScale} anchor=${shortCfi(anchorCfiRef.current)}`);
    if (anchorCfiRef.current) {
      beginRestore();
    }
    // The chapter reflows at the new size while the stage stays scrolled to
    // the old page, which now holds different words. Lay the chapter out
    // afresh and turn to the place being read.
    rendition.clear();
    void rendition.display(anchorCfiRef.current ?? locationRef.current?.start?.cfi ?? undefined);
    setRelayoutTick((tick) => tick + 1);
  }, [beginRestore, fontScale, isReady]);

  useEffect(() => {
    if (!fullscreen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (sheetRef.current) {
        setSheet(null);
      } else if (!immersive) {
        setFocusMode(false);
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [fullscreen, immersive]);

  // Chapter-level sync: with no sentence map, follow keeps the reader on the
  // chapter being played. Turning a page (which clears follow) stops it, so a
  // listener can read ahead; turning follow back on re-opens the chapter.
  useEffect(() => {
    if (!syncTarget || !isReady || toc.length === 0) {
      return;
    }
    if (!shouldOpenPlayingChapter(follow, syncTarget.id, syncedTargetRef.current)) {
      return;
    }
    const href = findTocHrefForChapterTitle(toc, syncTarget.title);
    if (!href) {
      return;
    }
    syncedTargetRef.current = syncTarget.id;
    setActiveHref(href);
    readerDebugLog(`chapterJump ${href}`);
    void renditionRef.current?.display(href);
  }, [follow, isReady, syncTarget, toc]);

  const fragmentIndex = useMemo(
    () =>
      syncFragments && syncFragments.length > 0
        ? findActiveFragmentIndex(syncFragments, positionSeconds, followLeadSeconds)
        : -1,
    [followLeadSeconds, positionSeconds, syncFragments]
  );

  const removeAnnotation = useCallback((cfi: string | null) => {
    const rendition = renditionRef.current;
    if (!rendition || !cfi) {
      return;
    }
    try {
      rendition.annotations.remove(cfi, "highlight");
    } catch {
      // stale annotation already gone
    }
  }, []);

  // Sentence-level readalong: highlight the fragment being narrated and keep
  // it on screen, following page turns and chapter boundaries.
  useEffect(() => {
    const rendition = renditionRef.current;
    const sentenceStyle = sentenceHighlightStyle(readerTheme, precision);
    if (!follow || !syncFragments || fragmentIndex < 0) {
      removeAnnotation(highlightCfiRef.current);
      highlightCfiRef.current = null;
      highlightedFragmentRef.current = -1;
      narratedRangeRef.current = null;
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
    // Keep the spoken position visible even when a sentence spans pages.
    // The annotation remains sentence-wide; word timing only guides navigation.
    const spokenCfi = () => {
      const target = narratedRangeRef.current;
      if (!target) return highlightCfiRef.current;
      const rawOffset = narrationTextOffset(fragment, positionSeconds);
      const offset = normalizeSyncNeedle(fragment.text.slice(0, rawOffset) + "x").length - 1;
      const point = target.index.map[target.start + Math.min(offset, target.length - 1)];
      if (!point) return highlightCfiRef.current;
      try {
        const range = target.index.doc.createRange();
        range.setStart(point.node, point.offset);
        range.collapse(true);
        return target.contents.cfiFromRange(range);
      } catch {
        return highlightCfiRef.current;
      }
    };
    const keepOnPage = (cfi: string) => {
      const EpubCfiClass = epubCfiClassRef.current;
      if (!EpubCfiClass || !location.start?.cfi || !location.end?.cfi) {
        return;
      }
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
    };
    if (highlightedFragmentRef.current === fragmentIndex) {
      const relaid = handledRelayoutRef.current !== relayoutTick;
      if ((highlightThemeRef.current !== readerTheme || relaid) && highlightCfiRef.current) {
        // Redraw against the current layout.
        removeAnnotation(highlightCfiRef.current);
        rendition.annotations.highlight(
          highlightCfiRef.current,
          {},
          () => tapFragment(fragment),
          "readalong-highlight",
          sentenceStyle
        );
        highlightThemeRef.current = readerTheme;
        handledRelayoutRef.current = relayoutTick;
      }
      if (highlightCfiRef.current) {
        keepOnPage(spokenCfi() ?? highlightCfiRef.current);
      }
      return;
    }
    handledRelayoutRef.current = relayoutTick;

    const contentsList = ([] as Contents[]).concat(
      (rendition.getContents() as unknown as Contents[]) ?? []
    );
    const contents = contentsList.find((candidate) => candidate?.document?.body);
    const doc = contents?.document;
    if (!contents || !doc) {
      return;
    }
    const index = ensureSearchIndex(doc);

    // Mark the fragment handled up front so a missing sentence doesn't retry
    // on every relocation.
    highlightedFragmentRef.current = fragmentIndex;
    narratedRangeRef.current = null;

    const needle = normalizeSyncNeedle(fragment.text);
    const found = findRangeInSearchIndex(index, needle, searchCursorRef.current);
    if (!found) {
      return;
    }
    searchCursorRef.current = found.endOffset;
    narratedRangeRef.current = { index, start: found.endOffset - needle.length, length: needle.length, contents };

    let cfi: string;
    try {
      cfi = contents.cfiFromRange(found.range);
    } catch {
      return;
    }
    removeAnnotation(highlightCfiRef.current);
    rendition.annotations.highlight(
      cfi,
      {},
      () => tapFragment(fragment),
      "readalong-highlight",
      sentenceStyle
    );
    highlightCfiRef.current = cfi;
    highlightThemeRef.current = readerTheme;
    keepOnPage(spokenCfi() ?? cfi);
  }, [ensureSearchIndex, follow, fragmentIndex, isReady, location, positionSeconds, precision, readerTheme, relayoutTick, removeAnnotation, syncFragments, tapFragment]);

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
  const hasSync = !!syncFragments && syncFragments.length > 0;
  // Chapter-sync books have no marker but still follow the narrated chapter,
  // so they get the same follow toggle.
  const canFollow = hasSync || !!syncTarget;
  const followLabel = precision === "estimated" ? "Following approximately" : "Following by sentence";
  const statusLabel = hasSync
    ? follow
      ? fragmentIndex >= 0
        ? `${followLabel} · ${locationLabel}`
        : `Waiting for narration · ${locationLabel}`
      : `Reading freely · ${locationLabel}`
    : syncTarget
      ? `Chapter sync · ${locationLabel}`
      : locationLabel;
  const awayFromNarration = hasSync && !follow && fragmentIndex >= 0;

  const pageInfo =
    location?.start?.displayed && location.start.displayed.total > 0
      ? `Page ${location.start.displayed.page} of ${location.start.displayed.total}`
      : null;
  const chapterLabel = chapterTitle ?? currentTocItem?.label?.trim() ?? null;
  const hint = pinning
    ? "Tap the sentence the narrator is reading right now."
    : awayFromNarration
      ? "Reading freely. The narration marker is off while you turn pages yourself."
      : precision === "estimated"
        ? "Approximate sync: the marker is timed from the chapter list. Tap any sentence to play from there; if the marker drifts, use Sync here to pin it to the narrator."
        : "Tap any sentence to play from there. Turning a page pauses following.";
  const goToHref = (href: string) => {
    setActiveHref(href);
    syncedTargetRef.current = null;
    if (href) {
      navigateByHand(() => renditionRef.current?.display(href));
    }
  };
  const handleReaderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      navigateByHand(() => renditionRef.current?.next());
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      navigateByHand(() => renditionRef.current?.prev());
    }
  };

  const themeOptions = (
    <div className="epub-theme-options" aria-label="Reading theme">
      {READER_THEME_CHOICES.map((choice) => (
        <button
          type="button"
          key={choice}
          className={readerThemeChoice === choice ? "selected" : ""}
          aria-pressed={readerThemeChoice === choice}
          onClick={() => setReaderThemeChoice(choice)}
          title={choice === "auto" ? `Follows the app: ${readerTheme} right now` : undefined}
        >
          {choice}
        </button>
      ))}
    </div>
  );
  const fontControls = (
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
  );
  const followActionLabel = hasSync
    ? (follow ? "Stop following narration" : "Follow narration")
    : (follow ? "Stop following chapters" : "Follow chapters");
  const followButton = canFollow ? (
    <button
      type="button"
      className={`epub-tool-button ${follow ? "selected" : ""}`}
      onClick={() => (follow ? setFollow(false) : resumeFollowing())}
      aria-pressed={follow}
      aria-label={followActionLabel}
      title={followActionLabel}
    >
      <LocateFixed size={15} />
      <span>{hasSync ? "Follow" : "Chapter sync"}</span>
    </button>
  ) : null;
  const pinButton =
    hasSync && precision === "estimated" && onPinNarration ? (
      <button
        type="button"
        className={`epub-tool-button ${pinning ? "selected" : ""}`}
        onClick={() => {
          setPinning((active) => !active);
          setSheet(null);
        }}
        aria-pressed={pinning}
        aria-label={pinning ? "Cancel sync adjustment" : "Adjust sync to the narrator"}
        title="The marker has drifted? Tap this, then tap the sentence being read."
      >
        <Crosshair size={15} />
        <span>Sync here</span>
      </button>
    ) : null;

  // The page itself. It must keep its place in the tree between the inline
  // and full-screen layouts: epub.js is attached to this very element.
  const stage = (
    <div className="epub-stage" ref={viewerRef}>
      {fullscreen ? null : (
        <span className="epub-progress" style={{ width: `${Math.max(0, Math.min(100, (percent ?? 0) * 100))}%` }} />
      )}
      {!isReady && !error ? (
        <span className="epub-loading">
          {slowToOpen ? "Still opening the ebook… a large book takes a moment on a slow connection." : "Loading EPUB…"}
        </span>
      ) : null}
      {error ? (
        <span className="epub-error">
          {error}
          {errorDetail ? <small>{errorDetail}</small> : null}
        </span>
      ) : null}
    </div>
  );

  const reader = (
    <div
      className={`epub-reader theme-${readerTheme} ${fullscreen ? "fullscreen" : ""} ${immersive ? "immersive" : ""} ${fullscreen && chromeHidden ? "chrome-hidden" : ""} ${precision === "estimated" ? "estimated" : ""}`}
      tabIndex={0}
      onKeyDown={handleReaderKeyDown}
    >
      {fullscreen ? (
        <header className="epub-topbar">
          <button
            type="button"
            className="epub-icon-button"
            onClick={() => (immersive ? onClose?.() : setFocusMode(false))}
            aria-label="Close the reader"
          >
            <X size={20} />
          </button>
          <div className="epub-topbar-title">
            <strong>{title}</strong>
            {chapterLabel ? <span>{chapterLabel}</span> : null}
          </div>
          <div className="epub-topbar-actions">
            {canFollow ? (
              <button
                type="button"
                className={`epub-icon-button ${follow ? "selected" : ""}`}
                onClick={() => (follow ? setFollow(false) : resumeFollowing())}
                aria-pressed={follow}
                aria-label={followActionLabel}
              >
                <LocateFixed size={19} />
              </button>
            ) : null}
            <button type="button" className="epub-icon-button" onClick={() => setSheet("contents")} aria-label="Contents">
              <List size={20} />
            </button>
            <button type="button" className="epub-icon-button" onClick={() => setSheet("appearance")} aria-label="Appearance and sync">
              <ALargeSmall size={22} />
            </button>
          </div>
        </header>
      ) : (
        <div className="epub-reader-chrome">
          <div className="epub-toolbar">
            <button
              type="button"
              onClick={() => navigateByHand(() => renditionRef.current?.prev())}
              aria-label="Previous page"
            >
              <ChevronLeft size={17} />
            </button>
            <div className="epub-location">
              <select
                aria-label={`${title} table of contents`}
                value={selectedTocHref}
                onChange={(event) => goToHref(event.currentTarget.value)}
              >
                <option value="">Contents</option>
                {toc.map((item) => (
                  <option key={`${item.href}-${item.label}`} value={item.href}>
                    {" ".repeat(item.depth * 2)}{item.label}
                  </option>
                ))}
              </select>
              <span className="epub-status" aria-live="polite">{statusLabel}</span>
            </div>
            <button
              type="button"
              onClick={() => navigateByHand(() => renditionRef.current?.next())}
              aria-label="Next page"
            >
              <ChevronRight size={17} />
            </button>
          </div>

          <div className="epub-preferences" aria-label="Reader appearance">
            {themeOptions}
            {fontControls}
            {pinButton}
            {followButton}
            <button
              type="button"
              className="epub-tool-button"
              onClick={() => setFocusMode(true)}
              aria-label="Open reader focus mode"
              title="Focus mode"
            >
              <Maximize2 size={15} />
              <span>Focus</span>
            </button>
          </div>
        </div>
      )}
      <div className="epub-catch-up" aria-label="Reading and listening place">
        {isReady && canCatchUp(anchorCfiRef.current, catchUpCfi, (a, b) => {
          const Cfi = epubCfiClassRef.current;
          return Cfi ? new Cfi().compare(a, b) : 0;
        }) ? (
          <button type="button" disabled={catchUpBusy} onClick={() => void moveReaderTo(catchUpCfi!, false)}>
            Go to listening chapter{listeningChapter ? ` · ${listeningChapter}` : ""}
          </button>
        ) : null}
        {returnLocation ? (
          <button type="button" disabled={!isReady || catchUpBusy} onClick={() => void moveReaderTo(returnLocation, true)}>
            Return to previous reading place
          </button>
        ) : null}
        {catchUpNotice ? <span role="status">{catchUpNotice}</span> : null}
        {offerOpeningPreference ? (
          <span>Open at your listening chapter next time? <button type="button" onClick={() => changeOpeningPreference(true)}>Yes</button> <button type="button" onClick={() => setOfferOpeningPreference(false)}>Not now</button></span>
        ) : null}
        {!fullscreen ? (
          <label>When opening <select value={openAtListening ? "listening" : "reading"} onChange={(event) => changeOpeningPreference(event.target.value === "listening")}>
            <option value="reading">Resume reading</option>
            <option value="listening">Open at listening chapter</option>
          </select></label>
        ) : null}
      </div>
      {fullscreen ? (
        <div className="epub-stage-wrap">
          {stage}
          <div
            className="epub-tapzones"
            onPointerDown={handleOverlayPointerDown}
            onPointerUp={handleOverlayPointerUp}
            aria-hidden="true"
          >
            <span className="epub-tapzone epub-tapzone-prev" />
            <span className="epub-tapzone epub-tapzone-next" />
          </div>
        </div>
      ) : (
        stage
      )}
      {fullscreen ? (
        <footer className="epub-bottombar">
          <div className="epub-pagebar" aria-hidden="true">
            <i style={{ width: `${Math.max(0, Math.min(100, (percent ?? 0) * 100))}%` }} />
          </div>
          <div className="epub-pageinfo">
            <span>
              {hasSync
                ? follow
                  ? fragmentIndex >= 0
                    ? followLabel
                    : "Waiting for narration"
                  : "Reading freely"
                : syncTarget
                  ? follow
                    ? "Following by chapter"
                    : "Reading freely"
                  : locationLabel}
            </span>
            <span>{pageInfo ?? locationLabel}</span>
          </div>
          {playback ? (
            <div className={`epub-audiobar ${pinning ? "pinning" : ""}`}>
              <button type="button" className="epub-icon-button epub-skip" onClick={() => playback.onSkip(-15)} aria-label="Back 15 seconds">
                <RotateCcw size={19} />
                <small>15</small>
              </button>
              <button
                type="button"
                className="epub-audiobar-play"
                onClick={playback.onToggle}
                aria-label={playback.playing ? "Pause" : "Play"}
              >
                {playback.playing ? <Pause size={22} /> : <Play size={22} />}
              </button>
              <button type="button" className="epub-icon-button epub-skip" onClick={() => playback.onSkip(30)} aria-label="Forward 30 seconds">
                <RotateCw size={19} />
                <small>30</small>
              </button>
              <div className="epub-audiobar-status" role="status">
                {pinning ? (
                  <>
                    <span>Tap the sentence being read</span>
                    <button type="button" className="epub-footer-action" onClick={() => setPinning(false)}>
                      <X size={14} />
                      <span>Cancel</span>
                    </button>
                  </>
                ) : (
                  <span className="epub-audiobar-time">{positionLabel ?? ""}</span>
                )}
              </div>
              {/* The rest of the player without leaving the page: the app's own
                  speed, sleep, and chapter sheets open over the reader. */}
              <div className="epub-audiobar-extras">
                <button
                  type="button"
                  className="epub-icon-button epub-audiobar-speed"
                  onClick={() => playback.onOpen("speed")}
                  aria-label={`Playback speed, ${playback.speed}×`}
                >
                  <span>{playback.speed}×</span>
                </button>
                <button
                  type="button"
                  className="epub-icon-button"
                  onClick={() => playback.onOpen("sleep")}
                  aria-label={playback.sleepRemaining > 0 ? `Sleep timer, ${Math.ceil(playback.sleepRemaining / 60)} minutes left` : "Sleep timer"}
                >
                  <Timer size={18} />
                  {playback.sleepRemaining > 0 ? <small>{Math.ceil(playback.sleepRemaining / 60)}m</small> : null}
                </button>
                <button type="button" className="epub-icon-button" onClick={() => playback.onOpen("chapters")} aria-label="Chapters">
                  <ListMusic size={18} />
                </button>
              </div>
            </div>
          ) : onListen ? (
            <button type="button" className="epub-audiobar-listen" onClick={onListen}>
              <Play size={15} />
              <span>Listen while you read</span>
            </button>
          ) : null}
        </footer>
      ) : hasSync ? (
        // Guidance and the way back live in a bar under the page, never over
        // the words: a listener reading ahead must keep every line legible.
        <div className={`epub-footer ${pinning ? "pinning" : ""}`}>
          <p className="epub-hint" role="status">{hint}</p>
          {pinning ? (
            <button type="button" className="epub-footer-action" onClick={() => setPinning(false)}>
              <X size={14} />
              <span>Cancel</span>
            </button>
          ) : awayFromNarration ? (
            <button type="button" className="epub-footer-action" onClick={resumeFollowing}>
              <Undo2 size={14} />
              <span>Return to narration</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {fullscreen && sheet ? (
        <div className="epub-sheet-layer" role="presentation">
          <button type="button" className="epub-sheet-scrim" aria-label="Close" onClick={() => setSheet(null)} />
          <section
            className="epub-sheet"
            ref={sheetRootRef}
            role="dialog"
            aria-modal="true"
            aria-label={sheet === "contents" ? "Contents" : "Appearance and sync"}
          >
            <div className="epub-sheet-grabber" aria-hidden="true" />
            {sheet === "contents" ? (
              <>
                <h3>Contents</h3>
                {toc.length === 0 ? (
                  <p className="epub-sheet-hint">This book has no table of contents.</p>
                ) : (
                  <ul className="epub-toc">
                    {toc.map((item) => {
                      const current = hrefsMatch(selectedTocHref, item.href);
                      return (
                        <li key={`${item.href}-${item.label}`} style={{ paddingLeft: `${item.depth * 16}px` }}>
                          <button
                            type="button"
                            className={current ? "current" : ""}
                            aria-current={current ? "location" : undefined}
                            onClick={() => {
                              goToHref(item.href);
                              setSheet(null);
                            }}
                          >
                            {item.label.trim()}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {companionSwitcher ? (
                  <>
                    <h3>Other files</h3>
                    {companionSwitcher}
                  </>
                ) : null}
              </>
            ) : (
              <>
                <h3>Appearance</h3>
                <div className="epub-sheet-row">{themeOptions}</div>
                <div className="epub-sheet-row">{fontControls}</div>
                <h3>When opening</h3>
                <label className="epub-sheet-row">Starting place
                  <select value={openAtListening ? "listening" : "reading"} onChange={(event) => changeOpeningPreference(event.target.value === "listening")}>
                    <option value="reading">Resume reading</option>
                    <option value="listening">Open at listening chapter</option>
                  </select>
                </label>
                <p className="epub-sheet-hint">Opens at the beginning of your listening chapter when it is ahead. Your previous page stays available. Follow is controlled separately. Saved for this account on this device.</p>
                {canFollow || syncTools ? (
                  <>
                    <h3>Narration</h3>
                    {canFollow ? (
                      <>
                        <div className="epub-sheet-row">
                          {followButton}
                          {pinButton}
                        </div>
                        <p className="epub-sheet-hint">
                          {hasSync
                            ? hint
                            : "This book follows by chapter: the reader opens to the chapter being played. Turn following off to read ahead on your own."}
                        </p>
                      </>
                    ) : null}
                    {syncTools}
                  </>
                ) : null}
              </>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
  return immersive ? createPortal(reader, document.body) : reader;
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
  onCommit,
  onPreview
}: {
  ariaLabel: string;
  max: number;
  value: number;
  onCommit: (value: number) => void;
  onPreview?: (value: number | null) => void;
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
    onPreview?.(null);
  };
  const cancel = () => {
    pendingRef.current = null;
    setDragValue(null);
    onPreview?.(null);
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
        onPreview?.(next);
      }}
      onPointerUp={commit}
      onPointerCancel={cancel}
      onTouchEnd={commit}
      onTouchCancel={cancel}
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
    if (Capacitor.isNativePlatform()) {
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
  if (!hasUserConfiguredServer()) {
    // A phone with no server configured opens straight into the on-device
    // library rather than gating on server setup: someone who installs the
    // app before their server exists can still listen, and connecting stays
    // one tap away on the shelf and in settings. The mode must be persisted
    // before MainApp renders because it reads isLocalMode() directly.
    if (Capacitor.isNativePlatform()) {
      enterLocalMode();
      return { phase: "ready", user: DEVICE_USER };
    }
    return { phase: "server" };
  }

  // A native launch should not sit behind a network timeout. This is the same
  // cached identity used for offline mode; checkAuth validates it in the
  // background and still returns to login if the server rejects the session.
  // Media elements cannot send the API Authorization header, so the native
  // shelf must wait for its query-safe media credential before it renders
  // remote artwork. This matters on the first launch after upgrading from a
  // build that only persisted the full session token.
  const cachedUser = Capacitor.isNativePlatform() && getStoredToken() && getStoredMediaToken()
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

/**
 * One column of the filter panel: a heading and a cloud of toggleable chips.
 * Genre and tag are the same control twice over, so they share this rather than
 * diverging the moment one of them grows a feature.
 */
function ShelfFacetGroup({
  title,
  hint,
  options,
  selected,
  onToggle
}: {
  title: string;
  hint: string;
  options: ShelfFacetOption[];
  selected: string[];
  onToggle: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const matching = options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()));
  // A chosen chip survives the collapse even when it sits past the preview, so a
  // filter can always be undone where it was set rather than only after
  // expanding a list you may not remember choosing from.
  const visible = expanded || query.trim()
    ? matching
    : matching.filter((option, index) => index < SHELF_FACET_PREVIEW_COUNT || selected.includes(option.key));
  const hiddenCount = matching.length - visible.length;

  return (
    <div className="shelf-facet">
      <div className="shelf-facet-heading">
        <span className="shelf-facet-title">{title}</span>
        {selected.length > 0 ? <span className="shelf-facet-count">{selected.length} selected</span> : null}
      </div>
      {options.length > SHELF_FACET_PREVIEW_COUNT ? (
        <label className="shelf-facet-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            aria-label={`Find ${title.toLowerCase()}`}
            placeholder={`Find ${title.toLowerCase()}…`}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      ) : null}
      {options.length === 0 ? (
        <p className="shelf-facet-hint">{hint}</p>
      ) : (
        <>
          <div className="shelf-facet-chips" role="group" aria-label={`Filter by ${title.toLowerCase()}`}>
            {visible.map((option) => {
              const isSelected = selected.includes(option.key);
              // Zero means this chip adds nothing under the filters already set.
              // It stays put, dimmed, rather than vanishing and shuffling every
              // other chip out from under the pointer.
              const isEmpty = option.count === 0 && !isSelected;
              return (
                <button
                  type="button"
                  key={option.key}
                  className={`facet-chip ${isSelected ? "selected" : ""}`}
                  aria-pressed={isSelected}
                  disabled={isEmpty}
                  onClick={() => onToggle(option.key)}
                >
                  {isSelected ? <Check size={11} strokeWidth={2.5} aria-hidden="true" /> : null}
                  <span className="facet-chip-label">{option.label}</span>
                  <em>{option.count}</em>
                </button>
              );
            })}
          </div>
          {matching.length === 0 ? <p className="shelf-facet-hint">No {title.toLowerCase()} match “{query.trim()}”.</p> : null}
          {!query.trim() && (hiddenCount > 0 || expanded) ? (
            <button type="button" className="shelf-facet-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show fewer" : `${hiddenCount} more`}
            </button>
          ) : null}
        </>
      )}
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
      if (Capacitor.isNativePlatform()) {
        enterLocalMode();
        setAuthState({ phase: "ready", user: DEVICE_USER });
        return;
      }
      setAuthState({ phase: "server" });
      return;
    }
    try {
      const status = await getAuthStatus();
      if (status.setupRequired) {
        await clearCarLibrary();
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
        await clearCarLibrary();
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
        await clearCarLibrary();
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
      void clearCarLibrary().catch(console.error);
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
    if (Capacitor.isNativePlatform()) return <NativeLaunchPlaceholder />;
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
        onLocal={Capacitor.isNativePlatform() ? () => {
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
        onChangeServer={async () => {
          await clearCarLibrary();
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
      onConnectServer={async () => {
        await clearCarLibrary();
        exitLocalMode();
        setAuthState({ phase: "server", returnToLocal: true });
      }}
      onLogout={async () => {
        await clearCarLibrary();
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
        // Otherwise checkAuth's offline fallback signs the account straight
        // back in the next time the server cannot be reached.
        forgetOfflineUser();
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

const EPUB_FILE_ACCEPT = ".epub,application/epub+zip";

/**
 * Remembers that the reader waved off the shelf's connect-a-server card. Kept
 * separate from the server keys in api.ts: it describes the pitch, not the
 * connection, and must survive entering and leaving local mode.
 */
const CONNECT_PROMPT_DISMISSED_KEY = "operalibre.connectPromptDismissed";

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
  const capabilities = serverCapabilities(getServerType(), currentUser, { local: localMode, demo: demoMode });
  const native = Capacitor.isNativePlatform();
  const ios = native && document.documentElement.classList.contains("platform-ios");
  // Shared reading is an OperaLibre-server feature: Jellyfin keeps its own user
  // data, and demo/local libraries have no other listeners to compare against.
  const sharedProgressAvailable = capabilities.sharedActivity;
  const rotationLockAvailable = isRotationLockAvailable();
  const [nativeTab, setNativeTab] = useState<NativeTab>("shelf");
  const [gamesEnabled, setGamesEnabled] = useState(readGamesEnabled);
  // The ebook reader ships off by default; the narration-follow highlight is a
  // sub-option beneath it, off by default and behind a warning.
  const [readalongEnabled, setReadalongEnabled] = useState(readReadalongEnabled);
  const [followSyncEnabled, setFollowSyncEnabled] = useState(readFollowSyncEnabled);
  const [followAggressiveness, setFollowAggressiveness] = useState(readFollowAggressiveness);
  const [rotationLockEnabled, setRotationLockEnabled] = useState(() => readStoredRotationLock() !== null);
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(() =>
    ios ? readStoredAppearanceMode() : "light"
  );
  const [rotationLockBusy, setRotationLockBusy] = useState(false);
  const [rotationLockError, setRotationLockError] = useState<string | null>(null);
  const [serverAliases, setServerAliases] = useState<ServerAlias[]>(getServerAliases);
  const [connectPromptDismissed, setConnectPromptDismissed] = useState(
    () => readStoredValue(CONNECT_PROMPT_DISMISSED_KEY) === "true"
  );
  const [aliasName, setAliasName] = useState("");
  const [aliasUrl, setAliasUrl] = useState("");
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [switchingAliasId, setSwitchingAliasId] = useState<string | null>(null);

  function updateAppearanceMode(mode: AppearanceMode) {
    if (mode === appearanceMode) return;
    setAppearanceMode(mode);
    writeAppearanceMode(window.localStorage, mode);
    applyAppearanceMode(mode);
    syncStatusBarStyle(mode);
    haptic("light");
  }

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
  // Ticks once per feed request, whether a poll or a mark-as-seen. Answers are
  // not guaranteed to arrive in the order they were asked for — a focus poll
  // can overlap the interval one, and either can outlast the 30s gap — so only
  // the newest request is allowed to touch the feed or the baseline above.
  // An older answer landing would rewind the baseline, and the next poll would
  // then treat already-announced finishes as new and banner them again.
  const finishRequestRef = useRef(0);
  const finishFeedAvailable =
    capabilities.sharedActivity && isNotifiedOfFinishes(currentUser);

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
      const request = (finishRequestRef.current += 1);
      void getFinishFeed()
        .then(async (next) => {
          if (cancelled || request !== finishRequestRef.current) return;
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
    const request = (finishRequestRef.current += 1);
    void markFinishFeedSeen(latest)
      .then((next) => {
        // Shares the sequence with the poll above: a request already in flight
        // when the panel opened must not land afterwards and un-clear the
        // badge the listener just read.
        if (request !== finishRequestRef.current) return;
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
  const progressSaveDrainPromiseRef = useRef<Promise<void> | null>(null);
  const progressSaveAbortController = useRef<AbortController | null>(null);
  const queuedProgressSaves = useRef<Map<string, QueuedProgressSave>>(new Map());
  const progressMutationVersion = useRef(0);
  // Unlike playbackTouchedRef, this advances only for an actual listener
  // action. Shelf Resume starts playback optimistically while reconciliation
  // is still running, and that automatic start must not make a fresher server
  // reply look stale.
  const playbackActionVersionRef = useRef(0);
  const restoredProgressBookId = useRef<string | null>(null);
  // Tearing a session down (completion, reset) is not a progress mutation and
  // not a listener action, so neither version above moves. Foreground adoption
  // still has to notice: a continuation that lands after the session was
  // cleared would restore the position it just discarded.
  const playbackSessionVersion = useRef(0);
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
  // The whole-book position each book's latest deliberate seek aimed at, and
  // the position the server last acknowledged for it. Together they decide
  // whether a seek needs the server's reset guard lifted — a forward tap must
  // not hand that authority to whatever stale clock gets persisted next.
  const intentionalSeekTargetRef = useRef<Map<string, number>>(new Map());
  const acknowledgedServerPositionRef = useRef<Map<string, number>>(new Map());
  // Set by startPlayback for an automatic Shelf-Resume start, consumed by the
  // element's `play` event. That event cannot tell an automatic start from a
  // listener's tap, and treating the automatic one as a listener action bumped
  // playbackActionVersionRef — after which the restore effect dropped the
  // /progress reply whenever it landed after loadedmetadata, and the stale
  // optimistic position kept playing.
  const autoResumePlayEventPendingRef = useRef(false);
  const explicitSessionStartBookIdRef = useRef<string | null>(null);
  // A shelf Resume is a request to play the *restored* position. Autoplay is
  // therefore armed by the restore effect rather than by the click, so it can
  // never start the placeholder first track while the real one resolves.
  const resumeAutoplayBookIdRef = useRef<string | null>(null);
  const resumeAutoplayPendingRef = useRef(false);
  const resumeReconciliationBookIdRef = useRef<string | null>(null);
  const foregroundAdoptInFlightRef = useRef(false);
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
  const playbackBookIdRef = useRef(playbackBookId);
  playbackBookIdRef.current = playbackBookId;
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
  const [scrubPreview, setScrubPreview] = useState<number | null>(null);
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
    gainSyncRef.current = createBookGainSync(
      setBookVolume,
      localGainWritesRef.current,
      unsyncedBookGainStore(currentUser.id)
    );
  }
  // Read by the native player at load time, which happens before the effect
  // that pushes the gain across.
  const playbackGainRef = useRef(BOOK_GAIN_DEFAULT);
  const gainChainRef = useRef<PlaybackGainChain | null>(null);
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const [customSleepTimers, setCustomSleepTimers] = useState<number[]>(readStoredCustomSleepTimers);
  const [sleepCustomOpen, setSleepCustomOpen] = useState(false);
  const [sleepCustomDraft, setSleepCustomDraft] = useState("");
  const sleepChoices = useMemo(() => sleepTimerChoices(customSleepTimers), [customSleepTimers]);
  const sleepCustomMinutes = normalizeSleepTimerMinutes(sleepCustomDraft);
  const sleepDeadlineRef = useRef<number | null>(null);
  const sleepRemainingRef = useRef(0);
  useEffect(() => {
    sleepRemainingRef.current = sleepRemaining;
  }, [sleepRemaining]);
  const [nativePlayerSheet, setNativePlayerSheet] = useState<NativePlayerSheet>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Serving the cached library because the server is unreachable; books
  // without a local download can't actually play in this state.
  const [isOffline, setIsOffline] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>(() => readStoredSortMode("local"));
  const [sortReversed, setSortReversed] = useState(() => readStoredValue("operalibre.sortReversed.local") === "true");
  const [viewMode, setViewMode] = useState<ShelfViewMode>(readStoredShelfViewMode);
  const [librarySource, setLibrarySource] = useState<LibrarySource>("local");
  const [libroRefreshKey, setLibroRefreshKey] = useState(0);
  const lastPurchaseSource = useRef<"audible" | "libro">("libro");
  useEffect(() => {
    if (librarySource !== "local") lastPurchaseSource.current = librarySource;
  }, [librarySource]);
  const [searchQuery, setSearchQuery] = useState("");
  const shelfSearchRef = useRef<HTMLInputElement | null>(null);
  const [shelfFilters, setShelfFilters] = useState<ShelfFilters>(EMPTY_SHELF_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterToggleRef = useRef<HTMLButtonElement | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
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
  const libationMessage = formatLibationMessage(libationStatus);
  const brokenLibationAccounts = libationStatus?.accounts.filter((account) => !account.authenticated) ?? [];
  const pendingLibationJobs = libationJobs.filter(isPendingJob);
  const displayedLibationJobs = pendingLibationJobs.length > 0 ? pendingLibationJobs : libationJobs.slice(0, 1);
  const refreshLibationJob = pendingLibationJobs.find((job) => job.kind === "libation-sync");
  const downloadAllLibationJob = pendingLibationJobs.find((job) => job.kind === "libation-liberate-all");
  const isRefreshingAudible = libationRefreshPending || !!refreshLibationJob;
  const canBrowseLibation = capabilities.imports && (currentUser.isAdmin || (native && !!libationStatus?.enabled));
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadBookName, setUploadBookName] = useState("");
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [ebookUploadBook, setEbookUploadBook] = useState<Book | null>(null);
  const [ebookUploadFile, setEbookUploadFile] = useState<File | null>(null);
  const [ebookUploadBusy, setEbookUploadBusy] = useState(false);
  const [ebookUploadError, setEbookUploadError] = useState<string | null>(null);
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
  // Native AVPlayer sends its definitive clock only after foregrounding. Keep
  // the server-adoption path behind that handoff, otherwise an older server
  // revision can replace a lock-screen rewind before its native event reaches
  // the resumed WebView.
  const nativeForegroundSyncGateRef = useRef(new NativeForegroundSyncGate());
  const foregroundProgressSyncRef = useRef<ReturnType<typeof createForegroundProgressSync> | null>(null);
  const foregroundProgressActionsRef = useRef({ nativeAudio, persistProgress, adoptNewerServerProgress });
  foregroundProgressActionsRef.current = { nativeAudio, persistProgress, adoptNewerServerProgress };
  const libraryRequestGenerationRef = useRef(0);
  // A listing refused while the server's startup scan runs is asked for
  // again after its Retry-After; the timer and the latest loader live in
  // refs so a scheduled retry always runs the current one and a fresh load
  // (mount, refresh, sign-in) cancels whatever was pending.
  const libraryRetryTimerRef = useRef<number | null>(null);
  const loadBooksRef = useRef<() => Promise<void>>(async () => undefined);
  // Set once native playback has attached, so the effect that sees the
  // player closed can tell that from the app's first render.
  const nativeAudioAttachedRef = useRef(false);
  const downloadAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const [downloadedBookIds, setDownloadedBookIds] = useState<Set<string>>(new Set());
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
  const [downloadStatus, setDownloadStatus] = useState<DeviceNotice | null>(null);
  const [completionPendingBookId, setCompletionPendingBookId] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<DeviceNotice | null>(null);
  const [unplayedConfirmationBookId, setUnplayedConfirmationBookId] = useState<string | null>(null);
  const [syncConfirmationBook, setSyncConfirmationBook] = useState<Book | null>(null);
  // Native jobs are persisted and serialized by iOS; this map only mirrors
  // their current queue/progress for the UI.
  const [activeDownloads, setActiveDownloads] = useState<Record<string, DeviceDownloadActivity>>({});
  const activeDownloadIdsRef = useRef<Set<string>>(new Set());
  const [deviceImport, setDeviceImport] = useState<{ completed: number; total: number } | null>(null);

  // Restores whatever sort was last chosen for this shelf rather than collapsing to
  // "title": each source keeps its own persisted sort (see readStoredSortMode).
  useEffect(() => {
    setSortMode(readStoredSortMode(librarySource));
    setSortReversed(readStoredValue(`operalibre.sortReversed.${librarySource}`) === "true");
  }, [librarySource]);

  function selectSortMode(mode: SortMode) {
    setSortMode(mode);
    writeStoredValue(sortModeStorageKey(librarySource), mode);
  }

  function reverseSort() {
    setSortReversed(!sortReversed);
    writeStoredValue(`operalibre.sortReversed.${librarySource}`, String(!sortReversed));
  }

  function selectViewMode(mode: ShelfViewMode) {
    setViewMode(mode);
    writeStoredShelfViewMode(mode);
  }

  const isCompactView = viewMode === "compact";

  function closeShelfFilters() {
    setFiltersOpen(false);
    filterToggleRef.current?.focus();
  }

  const sortOrderLabel = sortMode === "duration"
    ? sortReversed ? "Shortest first" : "Longest first"
    : sortMode === "progress"
      ? sortReversed ? "Finished first" : "In progress first"
      : sortMode === "tag" || sortMode === "series"
        ? sortReversed ? "Reverse book order" : "Book order"
        : sortReversed ? "Z–A" : "A–Z";

  const allShelfFacets = useMemo(() => ({
    genres: countShelfFacet(books, "genres"),
    tags: countShelfFacet(books, "tags")
  }), [books]);

  // Each book scored once against every filter axis separately. Keeping the five
  // verdicts apart is what lets the panel count a group over the books the
  // *other* groups allow without walking the library again per chip.
  const shelfMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return books.map((book) => ({
      book,
      search: bookMatchesShelfSearch(book, query),
      status: bookMatchesShelfStatus(book, shelfFilters.status),
      availableOnDevice:
        demoMode
        || localMode
        || book.source === "device"
        || !!book.deviceBookId
        || downloadedBookIds.has(book.id),
      genres: bookMatchesFacet(book, "genres", shelfFilters.genres),
      tags: bookMatchesFacet(book, "tags", shelfFilters.tags)
    })).map((match) => ({
      ...match,
      downloaded: bookMatchesShelfDownload(match.availableOnDevice, shelfFilters.downloadedOnly)
    }));
  }, [books, demoMode, downloadedBookIds, localMode, searchQuery, shelfFilters]);

  const shelfFacets = useMemo(() => {
    const forGenres: Book[] = [];
    const forTags: Book[] = [];
    const statusCounts: Record<ShelfStatusFilter, number> = {
      all: 0,
      inProgress: 0,
      notStarted: 0,
      finished: 0
    };
    let downloadedCount = 0;
    for (const match of shelfMatches) {
      if (match.search && match.status && match.tags && match.downloaded) forGenres.push(match.book);
      if (match.search && match.status && match.genres && match.downloaded) forTags.push(match.book);
      if (match.search && match.genres && match.tags && match.downloaded) {
        statusCounts.all += 1;
        statusCounts[readingStatus(match.book)] += 1;
      }
      if (match.search && match.status && match.genres && match.tags && match.availableOnDevice) {
        downloadedCount += 1;
      }
    }
    return {
      genres: updateShelfFacetCounts(allShelfFacets.genres, forGenres, "genres"),
      tags: updateShelfFacetCounts(allShelfFacets.tags, forTags, "tags"),
      statusCounts,
      downloadedCount
    };
  }, [allShelfFacets, shelfMatches]);

  const activeShelfFilterCount = countActiveShelfFilters(shelfFilters);
  // Genres, tags and progress are all things only your own shelf records; the
  // Audible list keeps its account filter instead. Any shelf with books on it
  // can be filtered — every book has a reading status even when nothing has
  // been given a genre or a tag yet, so this is deliberately not gated on the
  // two chip groups having something in them. Hiding the control until the
  // metadata showed up only made it missing whenever someone went looking.
  const showShelfFilters = librarySource === "local" && books.length > 0;

  // Reads back the chips that are on, so the summary line under the toolbar can
  // name a filter and drop it without the panel being open.
  const activeShelfFilterChips = useMemo(() => {
    const chips: { id: string; caption: string; label: string; clear: () => void }[] = [];
    if (shelfFilters.status !== "all") {
      chips.push({
        id: `status:${shelfFilters.status}`,
        caption: "Status",
        label: readingStatusLabel(shelfFilters.status),
        clear: () => setShelfFilters((filters) => ({ ...filters, status: "all" }))
      });
    }
    if (shelfFilters.downloadedOnly) {
      chips.push({
        id: "availability:downloaded",
        caption: "Availability",
        label: "Downloaded on Device",
        clear: () => setShelfFilters((filters) => ({ ...filters, downloadedOnly: false }))
      });
    }
    for (const group of ["genres", "tags"] as ShelfFacetGroupKey[]) {
      const caption = group === "genres" ? "Genre" : "Tag";
      for (const key of shelfFilters[group]) {
        // Keep a removed/renamed value removable until the reader clears it.
        const label = shelfFacets[group].find((option) => option.key === key)?.label ?? key;
        chips.push({
          id: `${group}:${key}`,
          caption,
          label,
          clear: () => setShelfFilters((filters) => toggleShelfFacet(filters, group, key))
        });
      }
    }
    return chips;
  }, [shelfFacets, shelfFilters]);

  function clearShelfFilters() {
    setShelfFilters(EMPTY_SHELF_FILTERS);
  }

  const visibleBooks = useMemo(() => {
    const filtered = shelfMatches
      .filter((match) => match.search && match.status && match.downloaded && match.genres && match.tags)
      .map((match) => match.book);

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortMode) {
        case "author":
          return (a.author ?? "").localeCompare(b.author ?? "") || a.title.localeCompare(b.title);
        case "series":
          return compareShelfLabels(a.metadata.series, b.metadata.series)
            || compareShelfLabels(a.metadata.seriesPosition, b.metadata.seriesPosition)
            || a.title.localeCompare(b.title);
        case "tag": {
          const aTag = tagForShelfSort(a, shelfFilters.tags);
          const bTag = tagForShelfSort(b, shelfFilters.tags);
          return compareShelfLabels(aTag?.name, bTag?.name)
            || compareShelfLabels(aTag?.position, bTag?.position)
            || a.title.localeCompare(b.title);
        }
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
    return sortReversed ? sorted.reverse() : sorted;
  }, [shelfMatches, shelfFilters.tags, sortMode, sortReversed]);

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

    const sorted = [...filtered].sort((a, b) => {
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
    return sortReversed ? sorted.reverse() : sorted;
  }, [audibleAccountFilter, audibleAccountLabels, libationBooks, searchQuery, sortMode, sortReversed]);
  const audibleProfiles = useMemo(() => {
    const profiles = new Map<string, string>();
    for (const book of libationBooks) {
      profiles.set(book.profileId, audibleAccountLabels.get(book.profileId) ?? book.profileName);
    }
    return [...profiles].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [audibleAccountLabels, libationBooks]);

  // Accounts come and go in Libation, so a filter pinned to a departed account
  // would quietly show an empty library under a select that reads "All accounts".
  useEffect(() => {
    if (audibleAccountFilter === "all") return;
    const known = (libationStatus?.accounts ?? []).some((account) => account.id === audibleAccountFilter)
      || audibleProfiles.some((profile) => profile.id === audibleAccountFilter);
    if (!known && (libationStatus || audibleProfiles.length > 0)) {
      setAudibleAccountFilter("all");
    }
  }, [audibleAccountFilter, audibleProfiles, libationStatus]);

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

  // The best position this device knows for a book without asking the
  // server: the synchronous checkpoint, backstopped by the listing summary,
  // distrusting a near-zero checkpoint the same way the restore effect does.
  function lastKnownProgressFor(book: Book): Progress | null {
    const checkpoint = readProgressCheckpoint(
      window.localStorage,
      getServerStorageKey(),
      currentUser.id,
      book.id
    );
    const listed = progressFromBookSummary(book.id, book.progress);
    return isSuspectProgressReset(checkpoint, listed)
      ? listed
      : freshestProgress(checkpoint, listed);
  }

  const currentTrack = useMemo(() => {
    if (!playbackBook) {
      return null;
    }
    const saved = playbackBook.tracks.find((track) => track.id === currentTrackId);
    if (saved) return saved;
    if (currentTrackId) {
      // The track id vanished from the book (a rescan renumbered its files).
      // Falling back to the first track would remount the element at 0:00
      // with no pending seek and let the next tick persist that. Resolve the
      // whole-book offset instead; the effect below stages the matching seek.
      const location = resolveProgressLocation(
        playbackBook.tracks,
        lastKnownProgressFor(playbackBook)
      );
      const resolved = location
        ? playbackBook.tracks.find((track) => track.id === location.trackId)
        : null;
      if (resolved) return resolved;
    }
    return playbackBook.tracks[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackId, playbackBook]);

  const activeTrackIndex = currentTrackIndex(playbackBook, currentTrack);
  // Stable identity keys: every progress save rebuilds `books` (and with it
  // the playbackBook/currentTrack objects), so effects that manage the audio
  // source or restore progress must key on ids — re-running them on object
  // identity would tear down the <audio> src mid-playback every few seconds.
  const playbackBookKey = playbackBook?.id ?? null;
  const currentTrackKey = currentTrack?.id ?? null;
  const playbackReportRef = useRef<{ stop: () => Promise<unknown> } | null>(null);
  const playbackTransitions = useMemo(createPlaybackTransitions, []);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrackKey || playbackBook?.source === "device") return;
    const session = playbackReportingSession(currentTrackKey);
    if (!session) return;
    let lastPosition = audio.currentTime;
    let disposed = false;
    let startScheduled = false;
    const positionForReport = () => playbackReportPosition(currentTrackKey, pendingSeekRef.current, lastPosition);
    const rememberPosition = () => {
      if (Number.isFinite(audio.currentTime)) lastPosition = Math.max(0, audio.currentTime);
    };
    const startIfReady = () => {
      rememberPosition();
      if (startScheduled) return;
      startScheduled = true;
      void playbackTransitions.ready().then(async () => {
        // Recheck after the old track drains: this element may have been
        // replaced again, or the listener may have paused while waiting.
        if (disposed || !playbackTouchedRef.current
          || restoredProgressBookId.current !== playbackBookKey
          || resumeReconciliationBookIdRef.current === playbackBookKey
          || (pendingSeekRef.current && pendingSeekRef.current.trackId !== currentTrackKey)
          || (nativeAudio ? !nativePlaybackPlayingRef.current : audio.paused)) return;
        const reportPosition = positionForReport();
        if (reportPosition !== null) await session.start(reportPosition);
      }).finally(() => { startScheduled = false; });
    };
    const reporting = {
      stop: () => {
        const reportPosition = positionForReport();
        return reportPosition === null ? Promise.resolve() : session.stop(reportPosition);
      }
    };
    playbackReportRef.current = reporting;
    audio.addEventListener("play", startIfReady);
    audio.addEventListener("timeupdate", startIfReady);
    audio.addEventListener("seeked", rememberPosition);
    return () => {
      disposed = true;
      audio.removeEventListener("play", startIfReady);
      audio.removeEventListener("timeupdate", startIfReady);
      audio.removeEventListener("seeked", rememberPosition);
      // The application queue can hold a newer checkpoint behind an in-flight
      // request. Drain that queue before stop, and hold the next start behind it.
      void playbackTransitions.stopAfterProgress(() => progressSaveDrainPromiseRef.current, reporting.stop);
      if (playbackReportRef.current === reporting) playbackReportRef.current = null;
    };
    // Capture the element and credentials for this track. A timeupdate retries a
    // start deferred by restore/reconciliation without reporting optimistic progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackKey, playbackBookKey, currentUser.id, nativeAudio, playbackTransitions]);
  const bookIdsKey = useMemo(() => books.map((book) => book.id).join("|"), [books]);
  const downloadScanKey = useMemo(() => shelfDownloadScanKey(books), [books]);
  const booksRef = useRef<Book[]>(books);
  booksRef.current = books;
  const playbackTrackIdsKey = useMemo(
    () => playbackBook?.tracks.map((track) => track.id).join("|") ?? "",
    [playbackBook]
  );
  // Commit the currentTrack fallback resolution once per track-list change:
  // point the saved track id at the resolved track and queue its position as
  // a pending seek, so the remounted element restores it instead of starting
  // at 0:00. Only for a book already restored — while a restore is still
  // running it owns the track id and the pending seek.
  useEffect(() => {
    if (
      !playbackBook ||
      !currentTrackId ||
      restoredProgressBookId.current !== playbackBook.id ||
      playbackBook.tracks.some((track) => track.id === currentTrackId)
    ) {
      return;
    }
    const location = resolveProgressLocation(
      playbackBook.tracks,
      lastKnownProgressFor(playbackBook)
    );
    if (!location) return;
    const wasPlaying = nativeAudio ? nativePlaybackPlayingRef.current : isPlaying;
    setCurrentTrackId(location.trackId);
    setPendingSeek(location);
    setPosition(location.positionSeconds);
    setDuration(
      playbackBook.tracks.find((track) => track.id === location.trackId)?.durationSeconds ?? 0
    );
    playWhenTrackLoads.current = wasPlaying;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackBookKey, playbackTrackIdsKey, currentTrackId]);
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
  const scrubbedElapsed = scrubPreview ?? displayChapterElapsed;
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
  const activeCompanionUrl = activeCompanion && companionUrlReady ? readalongUrl(activeCompanion.url) : null;
  const companionFilesKey = JSON.stringify([...selectedCompanionList, ...selectedCompanionGroups.images].map((file) => [file.id, file.extension]));
  const companionScope = `${getServerStorageKey()}:${currentUser.id}:${selectedBook?.id ?? ""}:${companionFilesKey}`;
  const [localCompanions, setLocalCompanions] = useState<{ scope: string; urls: Record<string, string | null> } | null>(null);
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
    return (localCompanions?.scope === companionScope ? localCompanions.urls[file.id] : null) ?? readalongUrl(file.url);
  };
  const activeCompanionIsBook = !!activeCompanion && activeCompanion.id === selectedBook?.readingFile?.id;
  const selectedSyncMap = selectedBook ? syncMaps[selectedBook.id] ?? null : null;
  const selectedSyncFragments =
    isViewingPlayingBook && selectedSyncMap && selectedSyncMap.fragments.length > 0
      ? selectedSyncMap.fragments
      : null;
  const selectedSyncPrecision = syncMapPrecision(selectedSyncMap);
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

  function readReaderOpenFlag(bookId: string) {
    try {
      return window.localStorage.getItem(readerStorageKey(readerScope, bookId, "open")) === "1";
    } catch {
      return false;
    }
  }

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

  function closeReadalong() {
    // Removing the full-screen reader before the tab bar returns shows the
    // Reading page at full height, then again as the web view shrinks.
    if (immersiveEpub && nativeTabsReady) {
      setReaderClosing(true);
    } else {
      setReadalongOpen(false);
    }
    if (selectedBook) {
      writeReaderOpenFlag(selectedBook.id, false);
    }
  }

  /** Forget a book's loaded sync map so the next look at the reader refetches it. */
  function forgetSyncMap(bookId: string) {
    dispatchSyncMap({ type: "invalidate", bookId });
  }

  async function pinNarration(book: Book, fragment: { href: string; text: string }) {
    setSyncJobError(null);
    setSyncNotice(null);
    try {
      const summary = await addSyncAnchor(book.id, { ...fragment, seconds: bookPosition });
      forgetSyncMap(book.id);
      setSyncNotice(
        `Sync adjusted here. Sentences around this point are re-timed for everyone (${summary.anchorCount} ${summary.anchorCount === 1 ? "adjustment" : "adjustments"} on this book).`
      );
    } catch (error) {
      setSyncJobError(errorMessage(error, "Could not adjust the sync."));
    }
  }

  async function clearNarrationPins(book: Book) {
    setSyncJobError(null);
    setSyncNotice(null);
    try {
      await clearSyncAnchors(book.id);
      forgetSyncMap(book.id);
      setSyncNotice("Sync adjustments cleared. The estimate is back to the chapter list alone.");
    } catch (error) {
      setSyncJobError(errorMessage(error, "Could not clear the sync adjustments."));
    }
  }

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
      const isPlayingNow = nativeAudio
        ? nativePlaybackPlayingRef.current
        : !!audioRef.current && !audioRef.current.paused;
      setPlaybackBookId((existing) => {
        const preferred = existing ?? readStoredBookId(currentUser.id, "playbackBookId");
        const next = resolveActivePlaybackBookId(nextBooks, preferred, isPlayingNow);
        const preferredIsPresent = !!preferred && nextBooks.some((book) => book.id === preferred);
        // A device-only first paint may not contain the stored server book.
        // Wait for the cached/live shelf before deciding that session vanished.
        if (!next && preferred && !preferredIsPresent && !definitive) return existing;
        if (!startupNavigationResolved.current && (next || preferredIsPresent || definitive)) {
          startupNavigationResolved.current = true;
          if (native) {
            setNativeTab(next ? "reading" : "shelf");
            // The stored selection may be a book last browsed on the shelf.
            if (next) setSelectedBookId(next);
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
  }, [currentUser.id, isOperaLibre, localMode, native]);
  loadBooksRef.current = loadBooks;

  useEffect(
    () => () => {
      if (libraryRetryTimerRef.current !== null) {
        window.clearTimeout(libraryRetryTimerRef.current);
        libraryRetryTimerRef.current = null;
      }
      // Signing out unmounts the player with its session still held (the
      // attach cleanup keeps it for the next track); nothing follows now.
      if (nativeAudioAttachedRef.current) {
        nativeAudioAttachedRef.current = false;
        void releaseNativeAudioSession();
      }
    },
    []
  );

  useEffect(() => {
    if (!libationBooks.length) return;
    setBooks((current) => {
      const enriched = enrichBooksFromLibation(current, libationBooks);
      if (enriched !== current && Capacitor.isNativePlatform()) {
        void cacheLibrary(
          currentUser.id,
          enriched.filter((book) => book.source !== "device")
        );
      }
      return enriched;
    });
  }, [currentUser.id, libationBooks]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !books.length) return;
    void Promise.all(books.map(async (book) => [book.id, await isBookDownloaded(book)] as const))
      .then((states) => setDownloadedBookIds(new Set(states.filter(([, ready]) => ready).map(([id]) => id))));
    // Keyed on book ids and local-file identity: progress/metadata updates do
    // not re-stat every track, but removing a merged imported copy rechecks the
    // surviving server book even though its id stays the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadScanKey]);

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
  carEventHandlersRef.current = {
    playbackStarted: (bookId: string) => {
      // The driver started a book on the shared player. Claim it before any
      // state settles: the player teardown that follows checks this flag to
      // decide whether stopping the engine is this app's to do.
      setCarPlaybackOwner(bookId);
      void persistProgress();
      setCarPlaybackBookId(bookId);
      clearPlaybackSession();
    },
    sync: () => {
      void adoptCarPlaybackState();
    }
  };

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

  // Reattach the UI to persisted native jobs after a relaunch. Enqueueing is
  // idempotent, so this also supplies file metadata needed to recover jobs
  // created by older builds without duplicating their URLSession tasks.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !books.length) return;
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
    if (Capacitor.isNativePlatform() && playbackBook && currentTrack) {
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
    let cancelled = false;
    void (async () => {
      const stored = syncMapBook ? await getOfflineSyncMap(syncMapBook) : null;
      if (cancelled) return null;
      if (stored) dispatchSyncMap({ type: "loaded", bookId: syncMapBookId, map: stored });
      // Show the downloaded map immediately while checking for new alignment
      // or manual corrections in the background.
      return getSyncMap(syncMapBookId);
    })()
      .then((map) => {
        if (!cancelled) {
          dispatchSyncMap({ type: "loaded", bookId: syncMapBookId, map });
        }
      })
      .catch(async () => {
        // No server in reach: a downloaded book carries its own sync map.
        const stored = syncMapBook ? await getOfflineSyncMap(syncMapBook) : null;
        if (!cancelled) {
          dispatchSyncMap({ type: "loaded", bookId: syncMapBookId, map: stored });
        }
      });
    return () => {
      cancelled = true;
    };
    // Updating the visible map must not cancel its own background refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncMapBookId, syncMapRevision]);

  useEffect(() => {
    if (!syncJob || !["queued", "running"].includes(syncJob.status)) {
      return;
    }
    const timer = window.setInterval(() => {
      void getJob(syncJob.id)
        .then((job) => {
          setSyncJob(job);
          if (job.status === "completed") {
            dispatchSyncMap({ type: "reset" });
            setSyncNotice("Sync improved: the narration is now aligned sentence by sentence.");
            void loadBooks();
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [loadBooks, syncJob]);

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
      // Each attempt is capped well below the client's 30 s default: local
      // copies cover the wait, and no server checkpoint is queued until the
      // window closes, so a long one is listening that goes unsynced.
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
        // The listener already moved playback in this session; their live
        // position and its queued saves outrank whatever this late fetch
        // returned, and re-applying it would yank playback.
        return;
      }
      const lastKnownServer = server ?? listed;
      if (lastKnownServer) {
        acknowledgedServerPositionRef.current.set(
          playbackBook.id,
          lastKnownServer.bookPositionSeconds
        );
      }
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
    if (!nativeAudio) return;
    if (carPlaybackBookId) {
      // CarPlay is driving the shared player. Attaching would load this app's
      // book over the driver's, and the next detach would stop it outright.
      // The element stays muted so nothing here can be heard over the car.
      if (audio) audio.muted = true;
      nativeAudioAttachedRef.current = false;
      return;
    }
    if (!audio || !playbackBook || !currentTrack) {
      // The player closed. The attach cleanup keeps the audio session so a
      // track change does not hand audio to other apps between chapters;
      // nothing follows this time, so give the session up. Skipped on the
      // app's first render, where a WebView reload may have left native
      // audio playing that React is about to pick back up.
      if (nativeAudioAttachedRef.current) {
        nativeAudioAttachedRef.current = false;
        void releaseNativeAudioSession();
      }
      return;
    }
    nativeAudioAttachedRef.current = true;
    return attachNativeAudioPlayer(
      audio,
      (message) => setPlaybackError(message),
      () => setNativeAudioFailed(true),
      {
        scopeKey: nativeAudioRecoveryScope(currentUser.id, playbackBook.id),
        trackId: currentTrack.id,
        bookOffsetSeconds: trackOffsetSeconds(playbackBook, activeTrackIndex),
        queue: () => nativeAudioQueueRef.current,
        gain: () => playbackGainRef.current,
        sleepTimerSeconds: () => {
          const deadline = sleepDeadlineRef.current;
          if (deadline !== null) return Math.max(0, (deadline - Date.now()) / 1000);
          return sleepRemainingRef.current;
        }
      },
      (trackId, positionSeconds, _bookPositionSeconds, nativeIsPlaying) => {
        if (!playbackBook.tracks.some((track) => track.id === trackId)) return false;
        // getNativeAudioRecovery already participated in startup
        // reconciliation. A paused trackChanged event emitted while AVPlayer
        // rebuilds its queue is not a listener action and must not overwrite
        // the restored checkpoint or make the player oscillate.
        if (!shouldAcceptNativeTrackChange(startupViewReadyRef.current, nativeIsPlaying)) return false;
        markPlaybackTouched();
        nativePlaybackPlayingRef.current = nativeIsPlaying;
        playWhenTrackLoads.current = nativeIsPlaying;
        wantsAutoplayRef.current = nativeIsPlaying;
        setCurrentTrackId(trackId);
        setPendingSeek({ trackId, positionSeconds });
        setPosition(positionSeconds);
        setDuration(playbackBook.tracks.find((track) => track.id === trackId)?.durationSeconds ?? 0);
        scheduleStartupReveal();
        return true;
      },
      () => {
        // The native side has already moved the control clock to the seek.
        // While a pending seek is still queued for this track it would win
        // at loadedmetadata, so retarget it rather than let the lock-screen
        // seek be undone.
        const nativePosition = Math.max(0, audio.currentTime);
        markPlaybackTouched(
          true,
          undefined,
          true,
          trackOffsetSeconds(playbackBook, activeTrackIndex) + nativePosition
        );
        if (pendingSeekRef.current?.trackId === currentTrack.id) {
          setPendingSeek({ trackId: currentTrack.id, positionSeconds: nativePosition });
          setPosition(nativePosition);
        }
        void persistProgress();
      },
      () => {
        sleepDeadlineRef.current = null;
        setSleepMinutes(0);
        setSleepRemaining(0);
      },
      () => {
        foregroundProgressSyncRef.current?.nativeStateSynchronized();
      }
    );
  }, [carPlaybackBookId, currentTrackKey, currentUser.id, nativeAudio, playbackBookKey]);

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
  // local mirror alone. Only genuinely fresh server payloads take part: the
  // long-lived `books` state keeps whatever volumeGain it arrived with, and
  // re-merging it after a failed write released nothing would still be safe —
  // but merging it after every identity change (a progress tick, a pause) is
  // exactly what used to snap an offline adjustment back mid-chapter.
  function reconcileServerBookGains(payload: readonly Book[]) {
    setBookGains((existing) => {
      const merged = mergeServerBookGains(existing, payload, localGainWritesRef.current);
      if (!merged) return existing;
      writeStoredBookGains(currentUser.id, merged);
      return merged;
    });
    // The server just answered, so anything it missed while unreachable can
    // land now; a no-op whenever nothing is owed.
    gainSyncRef.current?.retry();
  }

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeChapter?.id,
    currentTrackChapterKey,
    currentTrackKey,
    mediaArtworkUrl,
    nativeAudio,
    playbackBookKey
  ]);

  // Lock-screen and hardware-key handlers are registered once and delegate
  // through this ref, which every render refreshes. Registering the handlers
  // themselves was keyed on the chapter and track, so between re-registrations
  // they held closures from an earlier render: "previous" saw a chapter
  // elapsed of 0 and never restarted the chapter, and "play" engaged the
  // gain chain with a stale gain.
  const mediaSessionHandlersRef = useRef({
    startPlayback,
    pausePlayback,
    seekBy,
    seekTo,
    seekBookPosition,
    restartOrPreviousChapter,
    nextChapter,
    activeChapter
  });
  mediaSessionHandlersRef.current = {
    startPlayback,
    pausePlayback,
    seekBy,
    seekTo,
    seekBookPosition,
    restartOrPreviousChapter,
    nextChapter,
    activeChapter
  };

  useEffect(() => {
    if (nativeAudio || !("mediaSession" in navigator)) return;
    const handlers = mediaSessionHandlersRef;
    const session = navigator.mediaSession;
    session.setActionHandler("play", () => handlers.current.startPlayback(audioRef.current));
    session.setActionHandler("pause", () => handlers.current.pausePlayback(audioRef.current));
    session.setActionHandler("seekbackward", () => handlers.current.seekBy(-15));
    session.setActionHandler("seekforward", () => handlers.current.seekBy(30));
    session.setActionHandler("previoustrack", () => handlers.current.restartOrPreviousChapter());
    session.setActionHandler("nexttrack", () => handlers.current.nextChapter());
    session.setActionHandler("seekto", (details) => {
      if (details.seekTime === undefined) return;
      const { activeChapter: chapter, seekBookPosition: seekBook, seekTo: seek } = handlers.current;
      if (chapter) {
        seekBook(chapter.startSeconds + details.seekTime);
      } else {
        seek(details.seekTime);
      }
    });
    return () => {
      for (const action of [
        "play", "pause", "seekbackward", "seekforward", "previoustrack", "nexttrack", "seekto"
      ] as MediaSessionAction[]) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // An action the browser does not know cannot have been registered.
        }
      }
    };
  }, [nativeAudio]);

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
    // The wall-clock deadline cannot see pauses that happen while the WebView
    // is suspended, so on the native path AVPlayer's playing-time countdown is
    // authoritative and this deadline only drives the displayed value.
    const syncFromNative = () => {
      void getNativeAudioSleepTimer().then((remaining) => {
        const next = Math.ceil(remaining);
        if (next > 0) {
          sleepDeadlineRef.current = Date.now() + next * 1000;
          setSleepRemaining(next);
        }
      }).catch(() => undefined);
    };
    if (nativeAudio) syncFromNative();
    const timer = window.setInterval(() => {
      const deadline = sleepDeadlineRef.current;
      if (deadline === null) return;
      const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (next === 0 && nativeAudio) {
        // Native owns expiry: it pauses AVPlayer and emits sleepTimerEnded,
        // which clears this state. Zeroing the native timer here would disarm
        // a countdown that may legitimately still hold minutes after a pause
        // this clock never saw.
        syncFromNative();
        return;
      }
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
      if (deadline === null) return;
      sleepDeadlineRef.current = null;
      // On the native path the countdown keeps its true value in AVPlayer and
      // re-syncs when the effect re-arms; recomputing from the wall clock here
      // could zero the UI while the native timer still holds minutes.
      if (nativeAudio) return;
      const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSleepRemaining(next);
      if (next === 0) setSleepMinutes(0);
    };
  }, [isPlaying, nativeAudio, sleepRemaining > 0]);

  function configureSleepTimer(minutes: number) {
    haptic("light");
    sleepDeadlineRef.current = isPlaying && minutes > 0
      ? Date.now() + minutes * 60 * 1000
      : null;
    setSleepMinutes(minutes);
    setSleepRemaining(minutes * 60);
    if (nativeAudio) {
      void setNativeAudioSleepTimer(minutes * 60).catch((error) => {
        // Nothing enforces the timer once the WebView is suspended, so
        // showing it armed after a failed native call would be a lie.
        sleepDeadlineRef.current = null;
        setSleepMinutes(0);
        setSleepRemaining(0);
        setPlaybackError(errorMessage(error, "The sleep timer could not be configured."));
      });
    }
    setSleepCustomOpen(false);
    setSleepCustomDraft("");
    setNativePlayerSheet(null);
  }

  /**
   * A duration the listener typed. It is remembered before being armed so it
   * stays one tap away tomorrow night, whether or not tonight's timer runs out.
   */
  function startCustomSleepTimer(event: React.FormEvent) {
    event.preventDefault();
    const minutes = normalizeSleepTimerMinutes(sleepCustomDraft);
    if (minutes === null) return;
    const remembered = mergeCustomSleepTimer(customSleepTimers, minutes);
    setCustomSleepTimers(remembered);
    writeStoredCustomSleepTimers(remembered);
    configureSleepTimer(minutes);
  }

  useEffect(() => {
    const sync = createForegroundProgressSync(
      nativeForegroundSyncGateRef.current,
      () => foregroundProgressActionsRef.current
    );
    foregroundProgressSyncRef.current = sync;
    return () => {
      sync.dispose();
      foregroundProgressSyncRef.current = null;
    };
  }, []);

  function persistProgress(): Promise<void> {
    if (
      !playbackBook ||
      restoredProgressBookId.current !== playbackBook.id ||
      !currentTrack ||
      !audioRef.current
    ) {
      return Promise.resolve();
    }
    // A shelf Resume plays the optimistic local copy while the server's is
    // still being fetched. Until that reconciliation settles, nothing goes
    // to the server: the position being played may be about to be replaced
    // by a fresher copy, and a push would make it look like the newest. The
    // local checkpoint is still kept — the window can span several retries
    // when the server is slow, and listening during it must survive a kill.
    // It does not advance progressMutationVersion, so the reconciled copy
    // still applies when it lands.
    const reconciling = resumeReconciliationBookIdRef.current === playbackBook.id;
    // Nothing moved playback since this book was restored: there is nothing
    // new to save, and writing the restored position back with a fresh
    // timestamp would let a device whose restore silently failed outrank —
    // and then erase — real progress recorded elsewhere. Opening a book and
    // closing it again must write nothing.
    if (!playbackTouchedRef.current) {
      return Promise.resolve();
    }

    // While a seek is queued the media element does not reflect the real
    // position yet — a restore or track jump reads currentTime 0 until
    // metadata loads. Persist the seek target instead; persisting element
    // time here would overwrite the real position everywhere, including the
    // server's only copy.
    const pending = pendingSeekRef.current;
    if (pending && pending.trackId !== currentTrack.id) {
      return Promise.resolve();
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
    if (!reconciling) progressMutationVersion.current += 1;
    writeProgressCheckpoint(window.localStorage, getServerStorageKey(), currentUser.id, localProgress);
    void cacheProgress(currentUser.id, localProgress).catch(() => undefined);
    if (playbackBook.deviceBookId) {
      const deviceBook = getDeviceBooks().find((book) => book.id === playbackBook.deviceBookId);
      const deviceTrack = deviceBook?.tracks[activeTrackIndex];
      if (deviceTrack) saveDeviceProgress(playbackBook.deviceBookId, { ...localProgress, bookId: playbackBook.deviceBookId, trackId: deviceTrack.id });
    }
    updateBookProgress(playbackBook.id, localProgress);
    if (playbackBook.source === "device" || reconciling) {
      return Promise.resolve();
    }

    const existingQueued = queuedProgressSaves.current.get(playbackBook.id);
    const intentionalSeekGeneration = Math.max(
      existingQueued?.intentionalSeekGeneration ?? 0,
      intentionalSeekGenerationRef.current.get(playbackBook.id) ?? 0
    );
    // Lifting the server's reset guard is decided by where the seek went,
    // not by the position being saved now: a +30 s tap must not turn a stale
    // near-zero clock persisted after it into the authoritative copy.
    const intentionalRegression =
      (existingQueued?.intentionalRegression ?? false) ||
      shouldFlagIntentionalRegression(
        intentionalSeekTargetRef.current.get(playbackBook.id),
        acknowledgedServerPositionRef.current.get(playbackBook.id)
      );
    queuedProgressSaves.current.set(playbackBook.id, {
      bookId: playbackBook.id,
      progress: localProgress,
      isPaused: nativeAudio ? !nativePlaybackPlayingRef.current : audioRef.current.paused,
      intentionalSeekGeneration,
      intentionalRegression
    });
    return flushProgressSaveQueue();
  }

  function flushProgressSaveQueue(): Promise<void> {
    const existingDrain = progressSaveDrainPromiseRef.current;
    if (existingDrain) {
      return existingDrain;
    }
    const drain = (async () => {
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
                entry.intentionalRegression
                && entry.intentionalSeekGeneration
                  > (acknowledgedSeekGenerationRef.current.get(entry.bookId) ?? 0),
              intentionalSeek:
                entry.intentionalSeekGeneration
                > (acknowledgedSeekGenerationRef.current.get(entry.bookId) ?? 0),
              signal: abortController.signal
            }
          );
          // Whatever the server answered is now its position — the copy a
          // later rewind is measured against.
          acknowledgedServerPositionRef.current.set(entry.bookId, saved.bookPositionSeconds);
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
    })().finally(() => {
      if (progressSaveDrainPromiseRef.current === drain) {
        progressSaveDrainPromiseRef.current = null;
        if (queuedProgressSaves.current.size > 0) {
          void flushProgressSaveQueue();
        }
      }
    });
    progressSaveDrainPromiseRef.current = drain;
    return drain;
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
      void cacheProgress(currentUser.id, progress).catch(() => undefined);
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

  function storeCanonicalServerProgress(book: Book, saved: Progress) {
    acknowledgedServerPositionRef.current.set(book.id, saved.bookPositionSeconds);
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

  /**
   * Returning to the foreground is the one moment another device's position
   * can be newer without any local signal — the restore effect runs once per
   * book and deliberately never re-fires. Adopt the server's copy only while
   * this session is provably idle: restore finished, playback paused, and no
   * local save queued or in flight. A moving or unsynced session is always
   * authoritative and is left completely alone.
   */
  async function adoptNewerServerProgress() {
    const book = playbackBook;
    const audio = audioRef.current;
    if (
      !book ||
      book.source === "device" ||
      !currentTrack ||
      !audio ||
      restoredProgressBookId.current !== book.id ||
      resumeReconciliationBookIdRef.current === book.id ||
      foregroundAdoptInFlightRef.current ||
      document.visibilityState !== "visible" ||
      (nativeAudio && nativeForegroundSyncGateRef.current.shouldDeferServerAdoption())
    ) {
      return;
    }
    const isPaused = nativeAudio ? !nativePlaybackPlayingRef.current : audio.paused;
    if (!isPaused || queuedProgressSaves.current.size > 0 || progressSaveDrainPromiseRef.current) {
      return;
    }
    const foregroundGeneration = nativeForegroundSyncGateRef.current.generation;
    const actionVersion = playbackActionVersionRef.current;
    const mutationVersion = progressMutationVersion.current;
    const sessionVersion = playbackSessionVersion.current;
    foregroundAdoptInFlightRef.current = true;
    try {
      const server = await getFreshProgress(book).catch(() => null);
      const cached = await getCachedProgress(currentUser.id, book.id).catch(() => null);
      if (
        !server ||
        document.visibilityState !== "visible" ||
        nativeForegroundSyncGateRef.current.generation !== foregroundGeneration ||
        (nativeAudio && nativeForegroundSyncGateRef.current.shouldDeferServerAdoption()) ||
        restoredProgressBookId.current !== book.id ||
        playbackActionVersionRef.current !== actionVersion ||
        progressMutationVersion.current !== mutationVersion ||
        playbackSessionVersion.current !== sessionVersion
      ) {
        return;
      }
      const checkpoint = readProgressCheckpoint(
        window.localStorage,
        getServerStorageKey(),
        currentUser.id,
        book.id
      );
      const adopted = adoptableServerProgress(freshestProgress(checkpoint, cached), server);
      if (!adopted) return;
      const location = resolveProgressLocation(book.tracks, adopted);
      if (!location) return;
      storeCanonicalServerProgress(book, adopted);
      setCurrentTrackId(location.trackId);
      setPendingSeek(location);
      setPosition(location.positionSeconds);
      setDuration(
        book.tracks.find((track) => track.id === location.trackId)?.durationSeconds ?? 0
      );
    } finally {
      foregroundAdoptInFlightRef.current = false;
      // A later resume may have tried while this obsolete request still held
      // the in-flight guard. Give that handoff a fresh read of the server.
      if (nativeForegroundSyncGateRef.current.generation !== foregroundGeneration) {
        void foregroundProgressActionsRef.current.adoptNewerServerProgress();
      }
    }
  }

  function clearPlaybackSession() {
    // Completion owns the durable final position. Prevent pause/teardown
    // events from following it with a stale media-element clock.
    playbackSessionVersion.current += 1;
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
      const closingActiveBook = playbackBookId === book.id && (finished || resetToUnplayed);
      const reporting = closingActiveBook ? playbackReportRef.current : null;
      if (closingActiveBook || resetToUnplayed) {
        // Freeze playback before any asynchronous reports. Otherwise a slow stop
        // could let a new progress write land after the deliberate completion/reset.
        if (closingActiveBook) {
          playbackTouchedRef.current = false;
          nativePlaybackPlayingRef.current = false;
          pausePlayback(audioRef.current);
          setIsPlaying(false);
        }
        queuedProgressSaves.current.delete(book.id);
        progressSaveAbortController.current?.abort();
        await progressSaveDrainPromiseRef.current;
        queuedProgressSaves.current.delete(book.id);
        // Drain the stop before changing completion. Teardown then has nothing
        // left to report and cannot restore an old media clock after a reset.
        await reporting?.stop();
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
        if (Capacitor.isNativePlatform()) {
          void cacheLibrary(
            currentUser.id,
            next.filter((candidate) => candidate.source !== "device")
          ).catch(() => undefined);
        }
        return next;
      });
      if (playbackBookIdRef.current === book.id && (finished || resetToUnplayed)) {
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
    haptic("light");
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
    if (!capabilities.downloads) return;
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
  //
  // A deliberate seek also records the whole-book position it aimed at, which
  // is what decides whether its saves may lift the server's reset guard.
  function markPlaybackTouched(
    deliberateSeek = false,
    seekBookId?: string,
    interruptRestore = true,
    seekTargetBookPosition?: number
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
      if (seekTargetBookPosition !== undefined && Number.isFinite(seekTargetBookPosition)) {
        intentionalSeekTargetRef.current.set(bookId, Math.max(0, seekTargetBookPosition));
      } else {
        intentionalSeekTargetRef.current.delete(bookId);
      }
    }
  }

  /** The whole-book position a track-relative seek on the playing book lands at. */
  function seekTargetInPlaybackBook(trackPosition: number) {
    if (!playbackBook) return undefined;
    return trackOffsetSeconds(playbackBook, activeTrackIndex) + Math.max(0, trackPosition);
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
  function engageGainChain(
    audio: HTMLAudioElement | null | undefined,
    // Read from the ref, not the render: this runs from lock-screen handlers
    // and media events whose closures can predate the current gain.
    gain = playbackGainRef.current
  ) {
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
    if (carPlaybackOwnsEngine()) {
      // Play, while the car holds the player, means take it back. The attach
      // effect is parked on that flag, so it has to be cleared first — and the
      // attach it then performs resumes from the checkpoint the car has been
      // keeping current. Starting playback waits for that attach.
      takeOverFromCar();
      window.setTimeout(() => startPlayback(audioRef.current, interruptRestore), 0);
      return;
    }
    markPlaybackTouched(false, undefined, interruptRestore);
    // Let the element's `play` event tell an automatic Shelf-Resume start
    // apart from a listener's tap. A rejected start clears it again so the
    // next play event — a real tap — counts as one.
    autoResumePlayEventPendingRef.current = !interruptRestore;
    engageGainChain(audio);
    if (!nativeAudio) {
      audio.play().catch(() => {
        autoResumePlayEventPendingRef.current = false;
      });
      return;
    }
    void playNativeAudio().catch((error) => {
      autoResumePlayEventPendingRef.current = false;
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
    // While the car owns the player, the element is all this app controls.
    // Pausing the native player here would stop the driver's book, and this
    // runs on teardown paths that are not a listener asking for a pause.
    if (!nativeAudio || carPlaybackOwnsEngine()) {
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
    // While a seek is still queued the element reads 0 (metadata pending);
    // the queued target is the real position, so move that instead.
    const pending = pendingSeekRef.current;
    const base = pending && pending.trackId === currentTrack?.id
      ? pending.positionSeconds
      : audio.currentTime;
    seekTo(base + delta);
  }

  function seekTo(value: number) {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const pending = pendingSeekRef.current;
    if (pending && currentTrack && pending.trackId === currentTrack.id) {
      const nextPosition = Math.max(
        0,
        Math.min(value, currentTrack.durationSeconds ?? value)
      );
      markPlaybackTouched(true, undefined, true, seekTargetInPlaybackBook(nextPosition));
      setPendingSeek({ trackId: currentTrack.id, positionSeconds: nextPosition });
      setPosition(nextPosition);
      void persistProgress();
      return;
    }
    const clamped = Math.max(0, Math.min(value, audio.duration || value));
    markPlaybackTouched(true, undefined, true, seekTargetInPlaybackBook(clamped));
    const nextPosition = setPlaybackPosition(audio, value);
    setPosition(nextPosition);
    void persistProgress();
  }

  function seekBookPositionInBook(book: Book, value: number, autoPlay = false) {
    const targetBookDuration = book.durationSeconds ?? durationFromTracks(book);
    const clampedValue = Math.max(0, Math.min(value, targetBookDuration || value));
    markPlaybackTouched(true, book.id, true, clampedValue);
    if (playbackBook?.id !== book.id) explicitSessionStartBookIdRef.current = book.id;
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

  function openNativePlayerSheet(sheet: Exclude<NativePlayerSheet, null>) {
    haptic("light");
    setNativePlayerSheet(sheet);
  }

  function closeNativePlayerSheet() {
    haptic("light");
    setNativePlayerSheet(null);
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
    const targetBook = selectedBook ?? playbackBook;
    markPlaybackTouched(
      true,
      targetBook?.id,
      true,
      targetBook
        ? trackOffsetSeconds(targetBook, targetBook.tracks.findIndex((candidate) => candidate.id === track.id))
        : undefined
    );
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
  async function playSelectedBook(book: Book) {
    haptic("medium");
    if (!shouldResumeSavedPosition(book.progress)) {
      // The listing summary can lag the server (a cached shelf, a session on
      // another device since the last refresh). Before "Begin this reading"
      // writes a near-zero position with a deliberate seek attached — which
      // the server would honour — ask for the live copy, briefly. Offline or
      // unanswered, the summary stands as before.
      const inProgressElsewhere = await freshProgressBeforeStartingOver(book);
      if (inProgressElsewhere) {
        updateBookProgress(book.id, inProgressElsewhere);
        resumeSelectedBook(book);
        return;
      }
      // "Read it again" on a finished book, or one never opened: track one.
      if (book.tracks[0]) selectTrack(book.tracks[0]);
      return;
    }
    resumeSelectedBook(book);
  }

  async function freshProgressBeforeStartingOver(book: Book): Promise<Progress | null> {
    if (
      book.source === "device" ||
      localMode ||
      isOffline ||
      book.progress?.status === "finished"
    ) {
      return null;
    }
    try {
      const server = await getFreshProgress(book, START_OVER_PROGRESS_CHECK_MS);
      if (!server) return null;
      const summary = summarizeBookProgress(book, server);
      return summary?.status === "inProgress"
        && server.bookPositionSeconds > PROGRESS_RESET_GUARD_SECONDS
        ? server
        : null;
    } catch {
      return null;
    }
  }

  function resumeSelectedBook(book: Book) {
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

    haptic("light");
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
    haptic("light");
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
      haptic("light");
      seekBookPositionInBook(playbackBook, target.startSeconds, true);
    }
  }

  function playNextTrack() {
    // `ended` also fires when a stream is cut short (a truncated response, a
    // proxy giving up). Advancing on that — or finishing the book on its last
    // track — would file unheard time as listened. Stop where the clock is.
    // Only the element's own duration is trusted here: the catalogue's tag
    // estimate can run minutes long and would stop every track "early".
    const endedAudio = audioRef.current;
    if (
      endedAudio &&
      currentTrack &&
      endedShortOfTrack(endedAudio.currentTime, endedAudio.duration)
    ) {
      playWhenTrackLoads.current = false;
      wantsAutoplayRef.current = false;
      pausePlayback(endedAudio);
      setIsPlaying(false);
      void persistProgress();
      setPlaybackError("Playback stopped early; the file may be incomplete.");
      return;
    }
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
    if (book.source !== "device") {
      // Guards the book against a library payload older than this adjustment,
      // and holds it until the server echoes the value back. Clearing the guard
      // when the PUT settles would be too early: a getBooks() issued before the
      // write can still answer after it, carrying the old gain. A write that
      // never landed keeps the guard and is re-sent once the server answers
      // again — see createBookGainSync.
      gainSyncRef.current?.write(book.id, gain);
    }
  }

  function showYourLibrary() {
    setLibrarySource("local");
  }

  function openNativeTab(tab: NativeTab) {
    if (tab === "games" && !gamesEnabled) return;
    haptic("light");
    // Re-tapping the active Shelf tab is an escape hatch from the Audible
    // catalogue back to the listener's own library.
    if (tab === "shelf" && nativeTab === "shelf" && librarySource !== "local") {
      showYourLibrary();
    }
    // Reading belongs to the playing book. A book browsed from the shelf stays
    // selected after its details page closes and must not follow into the tab.
    if (tab === "reading" && playbackBook) setSelectedBookId(playbackBook.id);
    setNativeTab(tab);
    if (tab === "reading" || tab === "shelf") setNativePlayerView("now");
  }

  function toggleGamesEnabled() {
    const enabled = !gamesEnabled;
    writeGamesEnabled(enabled);
    setGamesEnabled(enabled);
    if (!enabled && nativeTab === "games") setNativeTab("shelf");
  }

  function toggleReadalongEnabled() {
    const enabled = !readalongEnabled;
    writeReadalongEnabled(enabled);
    setReadalongEnabled(enabled);
    if (!enabled) {
      setReadalongOpen(false);
      if (selectedBook) writeReaderOpenFlag(selectedBook.id, false);
    }
  }

  function toggleFollowSyncEnabled() {
    const enabled = !followSyncEnabled;
    writeFollowSyncEnabled(enabled);
    setFollowSyncEnabled(enabled);
  }

  function updateFollowAggressiveness(value: FollowAggressiveness) {
    if (value === followAggressiveness) return;
    writeFollowAggressiveness(value);
    setFollowAggressiveness(value);
    selectionHaptic("change");
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
      reconcileServerBookGains(nextBooks);
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

  function chooseEbookUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null;
    const error = file && !file.name.toLowerCase().endsWith(".epub")
      ? "Choose an EPUB (.epub) file."
      : file && (file.size === 0 || file.size > 64 * 1024 * 1024)
        ? "Choose a non-empty EPUB up to 64 MiB." : null;
    setEbookUploadFile(error ? null : file);
    setEbookUploadError(error);
  }

  async function submitEbookUpload(event: React.FormEvent) {
    event.preventDefault();
    if (!ebookUploadBook || !ebookUploadFile || !ebookUploadFile.name.toLowerCase().endsWith(".epub")) {
      setEbookUploadError("Choose an EPUB (.epub) file.");
      return;
    }
    setEbookUploadBusy(true);
    setEbookUploadError(null);
    try {
      const nextBooks = await uploadEbook(ebookUploadBook.id, ebookUploadFile);
      const paired = nextBooks.find((book) => book.id === ebookUploadBook.id);
      if (!paired?.readingFile || paired.readingFile.extension !== "epub") {
        throw new Error("The server has not paired the EPUB yet. Refresh the library to check its status.");
      }
      // Upload responses may arrive after playback or device-library updates.
      // Adopt only the paired files; keep current progress and local books.
      setBooks((existing) => existing.map((book) => book.id === paired.id ? {
        ...book, readingFile: paired.readingFile, companions: paired.companions, syncFile: paired.syncFile
      } : book));
      setIsOffline(false);
      setError(null);
      setEbookUploadBook(null);
      setEbookUploadFile(null);
    } catch (error) {
      setEbookUploadError(errorMessage(error, "The EPUB could not be uploaded."));
    } finally {
      setEbookUploadBusy(false);
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
      reconcileServerBookGains([updatedBook]);
      setMetadataEditOpen(false);
      setMetadataForm(null);
    } catch (error) {
      setMetadataError(errorMessage(error, "Book info could not be saved."));
    } finally {
      setMetadataSaving(false);
    }
  }

  const showLedgerTab = native && capabilities.statistics;
  const iosTabs = nativeTabItems(gamesEnabled, showLedgerTab,
    currentUser.isAdmin ? brokenLibationAccounts.length : 0);
  const { ready: nativeTabsReady, shown: nativeTabsShown } = useNativeTabs({
    tabs: iosTabs,
    selected: nativeTabSelection(nativeTab, iosTabs),
    visible: !readalongOpen || readerClosing,
    appearance: appearanceMode
  }, openNativeTab);
  useEffect(() => {
    if (!readerClosing || (nativeTabsReady && !nativeTabsShown)) return;
    setReaderClosing(false);
    setReadalongOpen(false);
  }, [nativeTabsReady, nativeTabsShown, readerClosing]);

  const refreshShelf = useCallback(async () => {
    if (librarySource === "audible") {
      await loadLibationBooks();
    } else if (librarySource === "libro") {
      await refreshLibroAccount();
      setLibroRefreshKey(key => key + 1);
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
      {capabilities.statistics ? (
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
      {capabilities.administration ? (
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
      {capabilities.administration && brokenLibationAccounts.length > 0 ? (
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
      {capabilities.readingFiles ? (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={readalongEnabled}
          onClick={toggleReadalongEnabled}
        >
          <BookOpen size={14} /> Ebook reader: {readalongEnabled ? "On" : "Off"} (beta)
        </button>
      ) : null}
      {readalongEnabled && sentenceFollowAvailable ? (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={followSyncEnabled}
          onClick={toggleFollowSyncEnabled}
          title="Experimental: the highlight can drift and may move the page to match the audio."
        >
          <LocateFixed size={14} /> Follow narration: {followSyncEnabled ? "On" : "Off"} (experimental)
        </button>
      ) : null}
      {!native && readalongEnabled && sentenceFollowAvailable && followSyncEnabled ? (
        <div className="user-menu-follow-aggressiveness" role="group" aria-labelledby="menu-follow-aggressiveness-label">
          <div>
            <label id="menu-follow-aggressiveness-label" htmlFor="menu-follow-aggressiveness">
              Aggressiveness
            </label>
            <output htmlFor="menu-follow-aggressiveness">
              {FOLLOW_AGGRESSIVENESS_LABELS[followAggressiveness]}
            </output>
          </div>
          <input
            id="menu-follow-aggressiveness"
            type="range"
            min="0"
            max="2"
            step="1"
            value={followAggressiveness}
            style={{ "--scrub-progress": `${followAggressiveness * 50}%` } as CSSProperties}
            aria-valuetext={FOLLOW_AGGRESSIVENESS_LABELS[followAggressiveness]}
            onChange={(event) => updateFollowAggressiveness(Number(event.currentTarget.value) as FollowAggressiveness)}
          />
          <small>Current timing <span>A little ahead</span></small>
        </div>
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

  // Sync actions and notices, shared by the inline panel header and the
  // full-screen reader's appearance sheet.
  //
  // A job belongs to one book, so only that book's reader shows its progress;
  // the poll above keeps following it either way.
  const syncJobForBook =
    syncJob && selectedBook && syncJob.targetId === selectedBook.id ? syncJob : null;
  const syncJobRunning = !!syncJobForBook && ["queued", "running"].includes(syncJobForBook.status);
  const syncProgressPercent = (() => {
    const fraction = syncJobForBook?.progress?.fraction;
    return typeof fraction === "number" && Number.isFinite(fraction)
      ? Math.min(100, Math.max(0, Math.round(fraction * 100)))
      : null;
  })();
  const syncElapsedSeconds = (() => {
    if (syncJobForBook?.status !== "running") return null;
    const startedAt = Number(syncJobForBook.runningAt ?? syncJobForBook.startedAt);
    return Number.isFinite(startedAt) && startedAt > 0
      ? Math.max(0, (Date.now() - startedAt) / 1000)
      : null;
  })();
  // Alignment runs at a fairly steady pace, so what it has done so far
  // predicts the rest well enough to be worth saying — once there is enough of
  // both to divide by.
  const syncRemainingLabel = (() => {
    const fraction = syncJobForBook?.progress?.fraction ?? null;
    if (
      syncJobForBook?.status !== "running"
      || fraction === null
      || fraction < 0.05
      || syncElapsedSeconds === null
      || syncElapsedSeconds < 60
    ) {
      return null;
    }
    return formatDurationLabel((syncElapsedSeconds * (1 - fraction)) / fraction);
  })();
  const syncProgressNote = [
    syncElapsedSeconds !== null && syncElapsedSeconds >= 60
      ? `${formatDurationLabel(syncElapsedSeconds)} so far`
      : null,
    syncRemainingLabel ? `about ${syncRemainingLabel} left` : null,
    "keeps running if you close the reader"
  ]
    .filter(Boolean)
    .join(" · ");
  const readerSyncActions = selectedBook ? (
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
      {currentUser.isAdmin && activeCompanionIsBook && (selectedSyncMap?.manualAnchorCount ?? 0) > 0 ? (
        <button
          type="button"
          className="download-btn"
          onClick={() => void clearNarrationPins(selectedBook)}
          title="Forget every Sync here adjustment on this book"
        >
          <RotateCcw size={13} />
          <span>Clear adjustments</span>
        </button>
      ) : null}
    </>
  ) : null;
  const readerSyncMessages = (
    <>
      {canGenerateSync && activeCompanionIsBook && !syncJobRunning ? (
        <p className="readalong-synchint">
          {selectedSyncPrecise
            ? "This book is aligned sentence by sentence against its narration. Re-sync rebuilds that map from the audio and the text — worth doing when either file has been replaced."
            : "Following is estimated from the chapter list here, so the highlight drifts within a chapter. Improve sync listens to the narration on the server and matches it to the text sentence by sentence, so the highlight lands on the sentence being read. It runs in the background for everyone on this server and can take a long while on a full-length book."}
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
  const companionTabs =
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
    ) : null;
  const epubReaderElement =
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
        loadBytes={(companionUrl, signal) =>
          loadCompanionBytes(selectedBook, activeCompanion, companionUrl, signal)
        }
        syncTarget={
          readalongEnabled && activeCompanionIsBook && !(narrationFollowActive && selectedSyncFragments) && isViewingPlayingBook && activeChapter
            ? activeChapter
            : null
        }
        syncFragments={narrationFollowActive && activeCompanionIsBook ? selectedSyncFragments : null}
        precision={narrationFollowActive && activeCompanionIsBook ? selectedSyncPrecision : null}
        positionSeconds={narrationFollowActive && isViewingPlayingBook ? bookPosition : 0}
        followLeadSeconds={FOLLOW_AGGRESSIVENESS_LEAD_SECONDS[followAggressiveness]}
        onSeekTo={
          narrationFollowActive
            ? (seconds) => seekBookPositionInBook(selectedBook, seconds, true)
            : undefined
        }
        onPinNarration={
          narrationFollowActive && activeCompanionIsBook && isViewingPlayingBook && selectedSyncPrecision === "estimated"
            ? (fragment) => void pinNarration(selectedBook, fragment)
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
    ) : null;
  // The native ebook reader is a full-screen layer of its own; everything
  // else (extras, pictures, the web reader) lives in the inline panel.
  const immersiveEpub = native && !!epubReaderElement;

  const readalongPanelElement =
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
                  ? `${activeCompanionIsBook && selectedReadAlongMode ? `${READ_ALONG_MODE_LABELS[selectedReadAlongMode].title} · ` : ""}${describeCompanion(activeCompanion)}${
                      activeCompanionIsBook && selectedSyncMap?.manualAnchorCount
                        ? ` · ${selectedSyncMap.manualAnchorCount} sync ${selectedSyncMap.manualAnchorCount === 1 ? "adjustment" : "adjustments"}`
                        : ""
                    }`
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
    ) : null;

  return (
    <main
      ref={shellRef}
      className={
        native
          ? `shell native-shell tab-${nativeTab}${nativeTab === "shelf" && nativePlayerView === "details" ? " library-book-open" : ""}${hasMiniPlayer ? " has-mini-player" : ""}`
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
              ? isOperaLibre ? "This audio format is not supported on this device." : "This device cannot play the original Jellyfin audio file. Try an MP3 or AAC version; automatic conversion is not available."
              : code === MediaError.MEDIA_ERR_NETWORK
                ? "Playback lost its connection to the audiobook server."
                : "This audio track could not be loaded.";
          setIsPlaying(false);
          setPlaybackError(message);
          // The element keeps paused=false after a media error, so the
          // toggle read "playing" and needed two taps. On iOS the element is
          // only the control clock and its own errors say nothing about
          // AVPlayer, so it is left alone there.
          const failed = audioRef.current;
          if (!nativeAudio && failed && !failed.paused) {
            // If metadata never arrived the clock reads 0; stage the shown
            // position so the pause save carries something coherent.
            if (
              failed.readyState < HTMLMediaElement.HAVE_METADATA &&
              !pendingSeekRef.current &&
              currentTrackKey
            ) {
              setPendingSeek({ trackId: currentTrackKey, positionSeconds: position });
            }
            failed.pause();
          }
        }}
        onTimeUpdate={onTimeUpdate}
        onPlay={() => {
          // Playback can also start natively (lock screen, CarPlay) without
          // going through startPlayback; real listening must always count as
          // touched or its progress would never be persisted. Only the
          // automatic Shelf-Resume start (flagged by startPlayback) is kept
          // from counting as a listener action, so a /progress reply that
          // lands after loadedmetadata can still correct the position.
          const automaticResume = autoResumePlayEventPendingRef.current;
          autoResumePlayEventPendingRef.current = false;
          markPlaybackTouched(false, undefined, !automaticResume);
          engageGainChain(audioRef.current);
          if (nativeAudio) nativePlaybackPlayingRef.current = true;
          setPlaybackError(null);
          setIsPlaying(true);
        }}
        onPause={() => {
          // Anything that plays after a pause is a fresh action, never the
          // automatic resume that flag was armed for.
          autoResumePlayEventPendingRef.current = false;
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
            <h1>OperaLibre</h1>
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
            {capabilities.uploads ? (
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
              aria-label={capabilities.administration ? "Rescan library" : "Refresh library"}
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
          {isOperaLibre && !localMode && !demoMode ? (
            <>
              <div className="source-toggle shelf-navigation" role="group" aria-label="Library navigation">
                <button type="button" className={librarySource === "local" ? "selected" : ""} onClick={showYourLibrary} aria-pressed={librarySource === "local"}>
                  <Library size={16} /> Library
                </button>
                <button type="button" className={librarySource !== "local" ? "selected" : ""} onClick={() => setLibrarySource(lastPurchaseSource.current === "audible" && !canBrowseLibation ? "libro" : lastPurchaseSource.current)} aria-pressed={librarySource !== "local"}>
                  <Cloud size={16} /> Get books
                  {currentUser.isAdmin && brokenLibationAccounts.length > 0 ? <span className="source-health-badge" aria-label={`${brokenLibationAccounts.length} Audible accounts need attention`}>{brokenLibationAccounts.length}</span> : null}
                </button>
              </div>
              {librarySource !== "local" ? (
                <div className="purchase-source">
                  <label htmlFor="purchase-source">Browse purchases</label>
                  <select id="purchase-source" value={librarySource} onChange={event => setLibrarySource(event.currentTarget.value === "audible" ? "audible" : "libro")}>
                    {canBrowseLibation ? <option value="audible">Audible{brokenLibationAccounts.length > 0 ? " — needs attention" : ""}</option> : null}
                    <option value="libro">Libro.fm</option>
                  </select>
                </div>
              ) : null}
            </>
          ) : null}
          <div className="library-search-row">
            <div className="library-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                ref={shelfSearchRef}
                placeholder={librarySource === "local" ? "Search books, authors, tags…" : librarySource === "libro" ? "Search Libro.fm purchases…" : "Search Audible titles…"}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
                aria-label="Search library"
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="library-search-clear"
                  aria-label="Clear search"
                  onClick={() => { setSearchQuery(""); shelfSearchRef.current?.focus(); }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {showShelfFilters ? (
              <button
                type="button"
                ref={filterToggleRef}
                className={`library-filter-toggle ${filtersOpen ? "open" : ""} ${activeShelfFilterCount > 0 ? "engaged" : ""}`}
                onClick={() => setFiltersOpen(!filtersOpen)}
                aria-expanded={filtersOpen}
                aria-controls="library-filter-panel"
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
                <span>Filters</span>
                {activeShelfFilterCount > 0 ? <em>{activeShelfFilterCount}</em> : null}
              </button>
            ) : null}
          </div>

          <div className="library-controls">
            <label className="library-sort">
              <span>Sort by</span>
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
            <button
              type="button"
              className="library-sort-direction"
              onClick={reverseSort}
              aria-label={`Reverse sort order (currently ${sortOrderLabel})`}
              title={`Reverse sort order · ${sortOrderLabel}`}
              aria-pressed={sortReversed}
            >
              {sortReversed ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
            </button>
            {librarySource !== "libro" ? <div className="view-toggle" role="group" aria-label="View mode">
              {SHELF_VIEW_MODE_OPTIONS.map((option) => {
                const Icon = option.value === "list" ? List : option.value === "compact" ? Rows3 : LayoutGrid;
                return (
                  <button
                    key={option.value}
                    className={viewMode === option.value ? "selected" : ""}
                    onClick={() => selectViewMode(option.value)}
                    aria-label={option.label}
                    title={option.value === "compact" ? "Compact view · more books per screen" : option.label}
                    aria-pressed={viewMode === option.value}
                  >
                    <Icon size={14} />
                  </button>
                );
              })}
            </div> : null}
          </div>

          {showShelfFilters && filtersOpen ? (
            <section
              className="library-filters"
              id="library-filter-panel"
              aria-label="Library filters"
              onKeyDown={(event) => {
                if (event.key === "Escape") { event.stopPropagation(); closeShelfFilters(); }
              }}
            >
              <div className="library-filters-heading">
                <strong>Find your next listen</strong>
                <button type="button" className="library-clear-filters" onClick={closeShelfFilters}>Done</button>
              </div>
              <div className="library-filters-body">
                <div className="shelf-facet shelf-facet-status">
                  <div className="shelf-facet-heading">
                    <span className="shelf-facet-title">Progress</span>
                  </div>
                  <div className="shelf-status-row" role="group" aria-label="Filter by reading progress">
                    {SHELF_STATUS_OPTIONS.map((option) => {
                      const isSelected = shelfFilters.status === option.value;
                      const count = shelfFacets.statusCounts[option.value];
                      return (
                        <button
                          type="button"
                          key={option.value}
                          className={isSelected ? "selected" : ""}
                          aria-pressed={isSelected}
                          disabled={count === 0 && !isSelected}
                          onClick={() => setShelfFilters({ ...shelfFilters, status: option.value })}
                        >
                          <span>{option.label}</span>
                          <em>{count}</em>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="shelf-facet shelf-facet-availability">
                  <div className="shelf-facet-heading">
                    <span className="shelf-facet-title">Availability</span>
                  </div>
                  <div className="shelf-facet-chips" role="group" aria-label="Filter by availability">
                    <button
                      type="button"
                      className={`facet-chip ${shelfFilters.downloadedOnly ? "selected" : ""}`}
                      aria-pressed={shelfFilters.downloadedOnly}
                      disabled={shelfFacets.downloadedCount === 0 && !shelfFilters.downloadedOnly}
                      onClick={() => setShelfFilters({
                        ...shelfFilters,
                        downloadedOnly: !shelfFilters.downloadedOnly
                      })}
                    >
                      <span className="facet-chip-label">Downloaded on Device</span>
                      <em>{shelfFacets.downloadedCount}</em>
                    </button>
                  </div>
                </div>

                <div className="shelf-facet-groups">
                  <ShelfFacetGroup
                    title="Genres"
                    hint="No genres on this shelf yet. Add them when you edit a book’s details."
                    options={shelfFacets.genres}
                    selected={shelfFilters.genres}
                    onToggle={(key) => setShelfFilters(toggleShelfFacet(shelfFilters, "genres", key))}
                  />
                  <ShelfFacetGroup
                    title="Tags"
                    hint="No tags on this shelf yet. Tag books to gather a wider world or reading order."
                    options={shelfFacets.tags}
                    selected={shelfFilters.tags}
                    onToggle={(key) => setShelfFilters(toggleShelfFacet(shelfFilters, "tags", key))}
                  />
                </div>
                <p className="shelf-facet-hint">Choose any in each group. Combine groups to narrow your shelf.</p>
              </div>
            </section>
          ) : null}

          {showShelfFilters && activeShelfFilterCount > 0 ? (
            <div className="library-active-filters">
              <span className="library-active-filters-caption">Filtering</span>
              {activeShelfFilterChips.map((chip) => (
                <button
                  type="button"
                  key={chip.id}
                  className="active-filter-chip"
                  onClick={chip.clear}
                  aria-label={`Remove ${chip.caption.toLowerCase()} filter ${chip.label}`}
                >
                  <span className="active-filter-caption">{chip.caption}</span>
                  <span className="active-filter-label">{chip.label}</span>
                  <X size={11} strokeWidth={2.5} aria-hidden="true" />
                </button>
              ))}
              <button type="button" className="library-clear-filters" onClick={clearShelfFilters}>
                Clear all
              </button>
            </div>
          ) : null}

          <div className="library-results-summary" role="status" aria-live="polite" aria-atomic="true">
            <span>
              {librarySource === "local"
                ? isLoading ? "Loading books…" : `${visibleBooks.length} of ${books.length} books`
                : librarySource === "libro" ? "Libro.fm purchases" : libationLoading ? "Loading books…" : `${visibleLibationBooks.length} of ${libationBooks.length} books`}
            </span>
            <span>{sortOrderLabel}</span>
          </div>

        </div>

        {carPlaybackBook ? (
          <section className="carplay-banner">
            <div className="carplay-banner-copy">
              <strong>Audiobook playing</strong>
              <span>{carPlaybackBook.title}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                takeOverFromCar();
                resumeSelectedBook(carPlaybackBook);
              }}
            >
              Open player
            </button>
          </section>
        ) : null}

        {currentUser.isAdmin && librarySource === "audible" ? (
          <section className="libation-panel audible-compact">
            <div className="audible-toolbar">
              <div className="libation-account-toolbar">
                <label>
                  <span className="sr-only">Audible account</span>
                  <select value={audibleAccountFilter} onChange={(event) => setAudibleAccountFilter(event.currentTarget.value)}>
                    <option value="all">All accounts</option>
                    {libationStatus?.accounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.name || account.accountId}</option>
                    ))}
                  </select>
                </label>
              </div>

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
                  <span>{refreshLibationJob?.status === "queued" ? "Refresh queued" : isRefreshingAudible ? "Syncing" : "Refresh"}</span>
                </button>
              </div>
            </div>
            {libationMessage ? <p role="status">{libationMessage}</p> : null}
            {(libationStatus && (!libationStatus.enabled || !libationStatus.authenticated || brokenLibationAccounts.length > 0)) ? (
              <p className="audible-attention" role="status"><AlertCircle size={14} />
                {!libationStatus?.enabled ? "Audible is not configured." : brokenLibationAccounts.length > 0 ? `${brokenLibationAccounts.length} account${brokenLibationAccounts.length === 1 ? " needs" : "s need"} attention. Open Accounts & downloads to reconnect.` : "Sign in through Libation to connect your Audible account."}
              </p>
            ) : null}
            <details className="audible-management">
              <summary>Accounts &amp; downloads <ChevronDown size={15} /></summary>
              <div className="audible-management-body">
                <p>Add or reconnect accounts in Libation.</p>
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
                      </article>
                    ))}
                  </div>
                ) : null}

                <div className="libation-actions">
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
                <p>{libationStatus?.autoRefreshHours ? `Checks for new purchases automatically every ${libationStatus.autoRefreshHours} hours.` : "Refresh to check for new purchases."}</p>
              </div>
            </details>

            {displayedLibationJobs.map((job) => {
              const targetTitle = job.targetId
                ? libationBooks.find((book) => book.catalogId === job.targetId)?.title
                : null;
              return (
              <details key={job.id} className={`job-card audible-job ${job.status}`}>
                <summary className="job-card-head">
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
                  <strong>{targetTitle ?? (job.kind === "libation-sync" && job.status === "completed" ? "Library refreshed" : jobTitle(job))}</strong>
                  <ChevronDown size={15} />
                </summary>
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
              </details>
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

        {librarySource === "libro" ? (
          <LibroCatalog refreshKey={libroRefreshKey} searchQuery={searchQuery} sortMode={sortMode} reversed={sortReversed} onBooksChanged={applyAdminLibraryChange} onOpenBook={(id) => { showYourLibrary(); openBookDetails(id); }} />
        ) : librarySource === "local" ? (
          <>
            {localMode && !connectPromptDismissed && !hasUserConfiguredServer() ? (
              <section className="connect-server-card" aria-label="Connect a server">
                <span className="section-label"><Network size={13} /> Listening from this device</span>
                <p>
                  Everything here stays on this device — no server or account needed.
                  When your OperaLibre or Jellyfin server is ready, connect it to
                  stream a shared library and sync your progress.
                </p>
                <a
                  className="connect-server-guide"
                  href={SERVER_SETUP_GUIDE_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={12} aria-hidden="true" />
                  <span>New to OperaLibre? Read the server setup guide</span>
                </a>
                <div className="connect-server-actions">
                  <button
                    type="button"
                    className="download-btn"
                    onClick={() => {
                      pausePlayback(audioRef.current);
                      onConnectServer();
                    }}
                  >
                    <Network size={13} />
                    <span>Connect a server</span>
                  </button>
                  <button
                    type="button"
                    className="connect-server-dismiss"
                    onClick={() => {
                      writeStoredValue(CONNECT_PROMPT_DISMISSED_KEY, "true");
                      setConnectPromptDismissed(true);
                    }}
                  >
                    Maybe later
                  </button>
                </div>
              </section>
            ) : null}
            {isLoading ? <div className="empty-state">Loading library…</div> : null}
            {error ? <div className="empty-state error">{error}</div> : null}
            {!isLoading && !error && books.length === 0 ? (
              <div className="empty-state device-empty-state">
                <span>{localMode ? "Your shelf is ready. Pick audiobook files from this device to start listening." : !isOperaLibre ? "No audiobooks are available to this account. Add audiobooks to a Books library in Jellyfin and check this account’s library access. Music libraries are not included." : "No audiobooks found in the configured library folder."}</span>
                {native ? (
                  <button type="button" className="download-btn" onClick={() => void importFromDevice()}>
                    <FolderOpen size={14} /> Choose audiobook files
                  </button>
                ) : null}
              </div>
            ) : null}
            {!isLoading && !error && books.length > 0 && visibleBooks.length === 0 ? (
              <div className="empty-state shelf-empty-state">
                <span>
                  {searchQuery.trim()
                    ? `Nothing matches “${searchQuery.trim()}”${activeShelfFilterCount > 0 ? " under these filters" : ""}.`
                    : "No books match these filters."}
                </span>
                {activeShelfFilterCount > 0 ? (
                  <button type="button" className="library-clear-filters" onClick={clearShelfFilters}>
                    Clear filters
                  </button>
                ) : null}
                {searchQuery ? (
                  <button type="button" className="library-clear-filters" onClick={() => setSearchQuery("")}>
                    Clear search
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* Compact keeps the list layout and only tightens it, so it carries
                both classes rather than forking every row rule. */}
            <div className={`book-list ${viewMode === "grid" ? "is-grid" : viewMode === "compact" ? "is-list is-compact" : "is-list"}`}>
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
                const shared = isCompactView ? null : summarizeSharedProgress(book.sharedProgress);
                // Compact abbreviates the chip and drops it entirely for a book
                // nobody has opened; the full wording stays on the tooltip so
                // shortening it costs a screen reader nothing.
                const progressLabel = isCompactView ? compactProgressLabel(book) : bookProgressLabel(book);
                const compactProgressTitle = isCompactView ? bookProgressLabel(book) : undefined;
                const sortTag = tagForShelfSort(book, shelfFilters.tags);
                const sortGroup = bookSortGroupLabel(book, sortMode, shelfFilters.tags);
                const previousSortGroup = index > 0
                  ? bookSortGroupLabel(visibleBooks[index - 1], sortMode, shelfFilters.tags)
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
                      className={`book-row ${book.id === selectedBook?.id ? "active" : ""} ${book.id === playbackBook?.id ? "playing" : ""} ${unavailableOffline ? "offline-unavailable" : ""}`}
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
                      {/* Compact drops the badge row — runtime, shared readers,
                          series position — and keeps title, byline and progress.
                          Those tags are what a browsing row is for; a row you are
                          scanning past a hundred of is not. Read along survives as
                          a bare glyph: unlike the rest it has no other home on the
                          shelf, so dropping it would make "does this one have the
                          text?" unanswerable without opening every book. */}
                      <span className="book-text">
                        <strong>{book.title}</strong>
                        <span>{bookSubtitle(book) || `${book.trackCount} track${book.trackCount === 1 ? "" : "s"}`}</span>
                        {!isCompactView && sortMode === "series" && book.metadata.seriesPosition ? (
                          <span className="book-sort-context">Book {book.metadata.seriesPosition} in series</span>
                        ) : null}
                        {!isCompactView && sortMode === "tag" && sortTag?.position ? (
                          <span className="book-sort-context">
                            Book {sortTag.position} in {sortTag.name}
                          </span>
                        ) : null}
                        {!isCompactView && formatDurationLabel(book.durationSeconds ?? durationFromTracks(book)) ? (
                          <span className="book-runtime-tag">
                            <Timer size={11} strokeWidth={1.5} />
                            {formatDurationLabel(book.durationSeconds ?? durationFromTracks(book))}
                          </span>
                        ) : null}
                        {readalongEnabled && book.readingFile ? (
                          <span
                            className={`book-readalong-tag ${isCompactView ? "is-glyph" : ""}`}
                            title="Ebook included: read along while you listen"
                            aria-label={isCompactView ? "Ebook included: read along while you listen" : undefined}
                          >
                            <BookOpen size={11} strokeWidth={1.6} />
                            {isCompactView ? null : "Read along"}
                          </span>
                        ) : readalongEnabled && hasExtras(book) ? (
                          <span
                            className={`book-readalong-tag extras ${isCompactView ? "is-glyph" : ""}`}
                            title="Pictures or a supplement are included"
                            aria-label={isCompactView ? "Pictures or a supplement are included" : undefined}
                          >
                            <Images size={11} strokeWidth={1.6} />
                            {isCompactView ? null : "Extras"}
                          </span>
                        ) : null}
                        {progressLabel ? (
                          <span
                            className={`book-progress ${book.progress?.status ?? "notStarted"}`}
                            title={compactProgressTitle}
                            aria-label={compactProgressTitle}
                          >
                            <em>{progressLabel}</em>
                            {book.progress?.status === "inProgress" && book.progress.percentComplete !== null ? (
                              <i style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }} />
                            ) : null}
                          </span>
                        ) : null}
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
        } ${showReaderInNowView ? "has-reader" : ""}`}
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
                <h2>{selectedBook.title}</h2>
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
              {tagsForBook(selectedBook).map((tag) => (
                <span className="metadata-custom-tag" key={tag.name}>
                  {tag.name}{tag.position ? ` · #${tag.position}` : ""}
                </span>
              ))}
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
              onPreview={setScrubPreview}
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
                ? `${formatTime(scrubbedElapsed)} / ${formatTime(chapterDuration)}`
                : `${formatTime(scrubbedElapsed)} / ${formatTime(sliderMax)}`}
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

      {syncConfirmationBook ? (
        <div className="modal-scrim unplayed-confirm-scrim" role="presentation">
          <section
            className="modal-card unplayed-confirm-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sync-confirm-title"
            aria-describedby="sync-confirm-description"
            onKeyDown={(event) => {
              if (event.key === "Escape") setSyncConfirmationBook(null);
            }}
          >
            <div className="modal-head">
              <div>
                <span className="eyebrow"><Sparkles size={13} /> Follow along</span>
                <h2 id="sync-confirm-title">Re-sync this book?</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Cancel re-sync"
                onClick={() => setSyncConfirmationBook(null)}
              >
                <X size={18} />
              </button>
            </div>
            <p id="sync-confirm-description" className="unplayed-confirm-copy">
              <strong>{syncConfirmationBook.title}</strong> already has sentence-by-sentence
              narration sync. Rebuilding it can take a long time. Start only if the audio or text
              changed, or the current sync needs replacing.
            </p>
            <div className="unplayed-confirm-actions">
              <button
                type="button"
                className="unplayed-confirm-cancel"
                autoFocus
                onClick={() => setSyncConfirmationBook(null)}
              >
                Not now
              </button>
              <button
                type="button"
                className="unplayed-confirm-submit"
                onClick={() => {
                  const book = syncConfirmationBook;
                  setSyncConfirmationBook(null);
                  void startSyncGeneration(book);
                }}
              >
                <Sparkles size={15} /> Start re-sync
              </button>
            </div>
          </section>
        </div>
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
                  haptic("light");
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
                  haptic("light");
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
              <button type="button" className="icon-button" aria-label="Close" onClick={closeNativePlayerSheet}>
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
                  haptic("light");
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
              <button type="button" className="icon-button" aria-label="Close" onClick={closeNativePlayerSheet}>
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
              <button type="button" className="icon-button" aria-label="Close" onClick={closeNativePlayerSheet}>
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
              <button type="button" className="icon-button" aria-label="Close" onClick={closeNativePlayerSheet}>
                <X size={18} />
              </button>
            </header>
            <p className="sleep-sheet-hint">The timer only runs while your book is playing.</p>
            <div className="sleep-options">
              {!sleepCustomOpen && sleepChoices.map((minutes) => (
                <button
                  type="button"
                  key={minutes}
                  className={sleepMinutes === minutes && sleepRemaining > 0 ? "selected" : ""}
                  onClick={() => configureSleepTimer(minutes)}
                >
                  <span>{formatSleepTimerMinutes(minutes)}</span>
                  {sleepMinutes === minutes && sleepRemaining > 0 ? (
                    <em>{formatTime(sleepRemaining)} left</em>
                  ) : (
                    <ChevronRight size={17} />
                  )}
                </button>
              ))}
              <button
                type="button"
                aria-expanded={sleepCustomOpen}
                aria-controls="sleep-custom-editor"
                onClick={() => {
                  haptic("light");
                  setSleepCustomOpen((open) => !open);
                }}
              >
                <span>Custom duration</span>
                {sleepCustomOpen ? <X size={17} /> : <ChevronRight size={17} />}
              </button>
              {!sleepCustomOpen && <button
                type="button"
                className={`sleep-off ${sleepRemaining === 0 ? "selected" : ""}`}
                onClick={() => configureSleepTimer(0)}
              >
                <span>Off</span>
                {sleepRemaining === 0 ? <em>Selected</em> : <X size={17} />}
              </button>}
            </div>
            {sleepCustomOpen ? (
              <form id="sleep-custom-editor" className="sleep-custom-editor" onSubmit={startCustomSleepTimer}>
                <label className="eyebrow" htmlFor="sleep-custom-minutes">Duration in minutes</label>
                <div className="sleep-custom sleep-custom-row">
                  <input
                    id="sleep-custom-minutes"
                    autoFocus
                    aria-describedby="sleep-custom-hint"
                    type="number"
                    inputMode="numeric"
                    enterKeyHint="done"
                    min={SLEEP_TIMER_MIN_MINUTES}
                    max={SLEEP_TIMER_MAX_MINUTES}
                    step={1}
                    placeholder="Minutes"
                    value={sleepCustomDraft}
                    onChange={(event) => setSleepCustomDraft(event.currentTarget.value)}
                  />
                  <span className="sleep-custom-unit">min</span>
                </div>
                <p id="sleep-custom-hint" className="sleep-sheet-hint">
                  {SLEEP_TIMER_MIN_MINUTES}–{SLEEP_TIMER_MAX_MINUTES} minutes · Saved for next time
                </p>
                <button className="speed-sheet-done" type="submit" disabled={sleepCustomMinutes === null}>Start timer</button>
              </form>
            ) : null}
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
              <div className="wide metadata-tags-field">
                <div className="metadata-tags-heading">
                  <span>Tags</span>
                  <button
                    type="button"
                    onClick={() => setMetadataForm({
                      ...metadataForm,
                      tags: [...metadataForm.tags, { name: "", position: "" }]
                    })}
                  >
                    <Plus size={13} /> Add tag
                  </button>
                </div>
                <p>Use tags for wider worlds or reading orders beyond the book’s immediate series.</p>
                {metadataForm.tags.map((tag, index) => (
                  <div className="metadata-tag-row" key={index}>
                    <input
                      type="text"
                      value={tag.name}
                      aria-label={`Tag ${index + 1} name`}
                      onChange={(event) => setMetadataForm({
                        ...metadataForm,
                        tags: metadataForm.tags.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, name: event.currentTarget.value }
                            : candidate
                        )
                      })}
                      placeholder="Cosmere"
                    />
                    <input
                      className="metadata-tag-position"
                      type="text"
                      value={tag.position}
                      aria-label={`Tag ${index + 1} book number`}
                      onChange={(event) => setMetadataForm({
                        ...metadataForm,
                        tags: metadataForm.tags.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, position: event.currentTarget.value }
                            : candidate
                        )
                      })}
                      placeholder="Book # (optional)"
                    />
                    <button
                      type="button"
                      className="metadata-tag-remove"
                      aria-label={`Remove ${tag.name || `tag ${index + 1}`}`}
                      onClick={() => setMetadataForm({
                        ...metadataForm,
                        tags: metadataForm.tags.filter((_, candidateIndex) => candidateIndex !== index)
                      })}
                    >
                      <X size={15} />
                    </button>
                  </div>
                ))}
              </div>
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

      {capabilities.statistics && profileOpen ? (
        <ProfilePage
          books={books}
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
          deviceOnly={localMode}
        />
      ) : null}

      {capabilities.administration && !native && usersModalOpen ? (
        <AdminPanel
          currentUser={currentUser}
          books={administrableBooks}
          onClose={() => setUsersModalOpen(false)}
          onUpload={() => {
            setUsersModalOpen(false);
            setUploadModalOpen(true);
          }}
          onRescan={refreshLibrary}
          onBeforeLibraryMutation={prepareForAdminLibraryMutation}
          onBooksChanged={applyAdminLibraryChange}
          onAlignmentChanged={updateAlignmentStatus}
          onOpenBook={(bookId) => {
            openBookDetails(bookId);
            setUsersModalOpen(false);
          }}
        />
      ) : null}

      {capabilities.uploads && uploadModalOpen ? (
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

      {capabilities.uploads && ebookUploadBook ? (
        <div className="modal-scrim" role="presentation">
          <form
            className="modal-card upload-audiobook-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="upload-ebook-title"
            onSubmit={submitEbookUpload}
          >
            <div className="modal-head">
              <div>
                <span className="eyebrow"><BookOpen size={13} /> Pair with this audiobook</span>
                <h2 id="upload-ebook-title">Add matching EPUB</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close ebook upload"
                disabled={ebookUploadBusy}
                onClick={() => setEbookUploadBook(null)}
              >
                <X size={16} />
              </button>
            </div>
            <p className="upload-audiobook-hint">
              Upload the EPUB for <strong>{ebookUploadBook.title}</strong>. It stays beside this audiobook and becomes its reading copy.
            </p>
            <label className="upload-file-picker">
              <BookOpen size={22} />
              <strong>{ebookUploadFile ? ebookUploadFile.name : "Choose EPUB file"}</strong>
              <span>Unencrypted EPUB · up to 64 MiB</span>
              <input
                type="file"
                accept={native ? undefined : EPUB_FILE_ACCEPT}
                required
                disabled={ebookUploadBusy}
                onChange={chooseEbookUpload}
              />
            </label>
            {ebookUploadError ? <p className="metadata-edit-error">{ebookUploadError}</p> : null}
            <div className="metadata-edit-actions">
              <button type="button" disabled={ebookUploadBusy} onClick={() => setEbookUploadBook(null)}>Cancel</button>
              <button type="submit" disabled={ebookUploadBusy || !ebookUploadFile}>
                {ebookUploadBusy ? <LoaderCircle size={15} className="spin-icon" /> : <Upload size={15} />}
                {ebookUploadBusy ? "Uploading…" : "Add EPUB"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {showLedgerTab && nativeTab === "ledger" ? (
        <ProfilePage
          books={books}
          user={currentUser}
          onClose={() => openNativeTab("reading")}
          onOpenBook={(bookId) => {
            openBookDetails(bookId);
          }}
          onUserChanged={onCurrentUserChanged}
          onSharingChanged={() => void loadBooks()}
          sharingAvailable={sharedProgressAvailable && !native}
          deviceOnly={localMode}
        />
      ) : null}

      {native && gamesEnabled && nativeTab === "games" ? <GamesPage /> : null}

      {native && nativeTab === "settings" ? (
        <section className="settings-shell" aria-label="Settings">
          <header className="settings-head">
            <div className="settings-heading">
              <span className="eyebrow"><Settings size={13} /> The Study</span>
              <h1>Settings</h1>
            </div>
            {capabilities.administration ? (
              <button type="button" className="settings-admin-button" onClick={() => openNativeTab("admin")}>
                <UserCog size={18} strokeWidth={1.6} />
                <span>Administration</span>
                <ChevronRight size={15} />
              </button>
            ) : null}
          </header>

          <section className="settings-card">
            <span className="section-label"><Gauge size={13} /> Playback</span>
            <div className="settings-field">
              <span className="settings-label">Cadence</span>
              <PlaybackSpeedControl value={speed} onChange={updateSpeed} rotary />
              <p className="settings-hint">Applies to every book and is remembered on this device.</p>
            </div>
          </section>

          {ios || rotationLockAvailable ? <section className="settings-card">
            <span className="section-label"><Smartphone size={13} /> Display</span>
            {ios ? <div className="settings-toggle-row settings-appearance-row">
              <span>
                <strong><Moon size={15} aria-hidden="true" /> Appearance</strong>
                <small>System follows your device's light or dark theme.</small>
              </span>
              <div className="settings-mode-toggle" role="radiogroup" aria-label="Appearance">
                {(["light", "dark", "system"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={appearanceMode === mode}
                    className={appearanceMode === mode ? "selected" : undefined}
                    onClick={() => updateAppearanceMode(mode)}
                  >
                    {mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System"}
                  </button>
                ))}
              </div>
            </div> : null}
            {rotationLockAvailable ? <div className="settings-toggle-row">
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
            </div> : null}
            {rotationLockError ? <p className="settings-hint settings-error">{rotationLockError}</p> : null}
          </section> : null}

          <section className="settings-card">
            <span className="section-label"><Gamepad2 size={13} /> Extras</span>
            <div className="settings-toggle-row">
              <span>
                <strong>Games tab</strong>
                <small>Shows optional, on-device games in the bottom navigation.</small>
              </span>
              <button
                type="button"
                className="settings-switch"
                role="switch"
                aria-checked={gamesEnabled}
                aria-label="Games tab"
                onClick={toggleGamesEnabled}
              >
                <span aria-hidden="true" />
              </button>
            </div>
            <div className="settings-toggle-row">
              <span>
                <strong>Ebook reader (beta)</strong>
                <small>Read the included ebook and extras while you listen. Still in development, so it is off by default.</small>
              </span>
              <button
                type="button"
                className="settings-switch"
                role="switch"
                aria-checked={readalongEnabled}
                aria-label="Ebook reader"
                onClick={toggleReadalongEnabled}
              >
                <span aria-hidden="true" />
              </button>
            </div>
            {readalongEnabled && sentenceFollowAvailable ? (
              <div className="settings-subrow settings-follow-group">
                <div className="settings-toggle-row">
                  <span>
                    <strong>Follow the narration</strong>
                    <small>Highlights the sentence being read and turns the page with the audio.</small>
                    <small className="settings-warning">
                      Experimental: the highlight can drift, and turning it on may move the page to match
                      the audio while you read.
                    </small>
                  </span>
                  <button
                    type="button"
                    className="settings-switch"
                    role="switch"
                    aria-checked={followSyncEnabled}
                    aria-label="Follow the narration"
                    onClick={toggleFollowSyncEnabled}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>
                {followSyncEnabled ? (
                  <div className="follow-aggressiveness">
                    <div className="follow-aggressiveness-heading">
                      <label htmlFor="follow-aggressiveness">Aggressiveness</label>
                      <output htmlFor="follow-aggressiveness" aria-live="polite">
                        {FOLLOW_AGGRESSIVENESS_LABELS[followAggressiveness]}
                      </output>
                    </div>
                    <input
                      id="follow-aggressiveness"
                      type="range"
                      min="0"
                      max="2"
                      step="1"
                      value={followAggressiveness}
                      style={{ "--scrub-progress": `${followAggressiveness * 50}%` } as CSSProperties}
                      aria-valuetext={FOLLOW_AGGRESSIVENESS_LABELS[followAggressiveness]}
                      onChange={(event) => updateFollowAggressiveness(Number(event.currentTarget.value) as FollowAggressiveness)}
                    />
                    <div className="follow-aggressiveness-labels" aria-hidden="true">
                      <span>Current timing</span>
                      <span>A little ahead</span>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

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
              {capabilities.administration ? (
                <>
                  <button type="button" className="download-btn" onClick={() => setUploadModalOpen(true)}>
                    <Upload size={13} />
                    <span>Upload audiobook</span>
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

      {native && capabilities.administration && nativeTab === "admin" ? (
        <AdminPanel
          onBack={() => openNativeTab("settings")}
          currentUser={currentUser}
          books={administrableBooks}
          onUpload={() => setUploadModalOpen(true)}
          onRescan={refreshLibrary}
          onBeforeLibraryMutation={prepareForAdminLibraryMutation}
          onBooksChanged={applyAdminLibraryChange}
          onAlignmentChanged={updateAlignmentStatus}
          onOpenBook={(bookId) => {
            openBookDetails(bookId);
            openNativeTab("shelf");
          }}
        />
      ) : null}

      {native && !nativeTabsReady ? (
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
          {gamesEnabled ? <button
            type="button"
            className={`spine-tab ${nativeTab === "games" ? "active" : ""}`}
            aria-current={nativeTab === "games" ? "page" : undefined}
            onClick={() => openNativeTab("games")}
          >
            <Gamepad2 size={20} strokeWidth={1.6} />
            <span>Games</span>
          </button> : null}
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
          <button
            type="button"
            className={`spine-tab ${(nativeTab === "settings" || nativeTab === "admin") ? "active" : ""}`}
            aria-current={(nativeTab === "settings" || nativeTab === "admin") ? "page" : undefined}
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
