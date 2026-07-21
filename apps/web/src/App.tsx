import {
  AlertCircle,
  ArrowUp,
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
  Settings,
  SkipBack,
  SkipForward,
  Sparkles,
  Timer,
  Trash2,
  Upload,
  ScrollText,
  UserCog,
  Volume2,
  X
} from "lucide-react";
import type { Book as EpubBook, Contents, EpubCFI, Location, NavItem, Rendition } from "epubjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  freshestProgress,
  progressFromBookSummary,
  progressTimestamp,
  readProgressCheckpoint,
  resolveBookId,
  resolveProgressLocation,
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
import { isLibationAdding } from "./libationState";
import { displayBookDescription, enrichBooksFromLibation } from "./bookMetadata";
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
  getMe,
  getProgress,
  getServerStorageKey,
  getServerAliases,
  getServerIdentityUrl,
  getServerUrl,
  getServerType,
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
  setStoredToken,
  setUnauthorizedHandler,
  syncLibationLibrary,
  uploadAudiobook,
  updateBookMetadata
} from "./api";
import type { ServerAlias } from "./api";
import {
  cacheLibrary,
  cacheOfflineUser,
  cacheProgress,
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
import { haptic, selectionHaptic } from "./native";
import {
  attachNativeAudioPlayer,
  getNativeAudioRecovery,
  pauseNativeAudio,
  playNativeAudio,
  seekNativeAudio,
  updateNativeAudioNowPlaying,
  usesNativeAudioPlayer
} from "./nativeAudio";
import { DEMO_USER, enterDemoMode, exitDemoMode, isDemoMode } from "./demo";
import {
  DEVICE_USER,
  getDeviceBooks,
  getDeviceProgress,
  importAudiobookFromDevice,
  mergeDeviceAndServerBooks,
  removeDeviceBook,
  saveDeviceProgress
} from "./localLibrary";
import { AuthGate, ServerSetup } from "./Auth";
import { AdminPanel } from "./Admin";
import { ProfilePage } from "./Profile";
import type {
  AlignmentStatus,
  AuthUser,
  Book,
  BookMetadataUpdate,
  Chapter,
  JobStatus,
  LibationBook,
  LibationDownloadRequest,
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
type NativePlayerSheet = "speed" | "sleep" | "chapters" | null;
type DeviceDownloadActivity = {
  bookId: string;
  fraction: number | null;
  state: "queued" | "running";
  queuedAt: number;
};
type DeviceNotice = { message: string; bookId?: string };
type PendingSeek = { trackId: string; positionSeconds: number };
type QueuedProgressSave = { bookId: string; progress: Progress; isPaused: boolean };

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
                  Math.max(0, drag.startIndex + (drag.startX - event.clientX) / 42)
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
                      "--speed-x": `${offset * 42}px`,
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

type SortMode = "title" | "author" | "duration" | "tracks";
type ViewMode = "list" | "grid";
type LibrarySource = "local" | "audible";
type ReaderTheme = "paper" | "sepia" | "night";
type MetadataEditorState = {
  title: string;
  author: string;
  narrator: string;
  publisher: string;
  publishedDate: string;
  genres: string;
  asin: string;
  description: string;
};

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "title", label: "Title" },
  { value: "author", label: "Author" },
  { value: "duration", label: "Length" },
  { value: "tracks", label: "Tracks" }
];

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
  if (!book.progress) {
    return "Not started";
  }
  if (book.progress.status === "finished") {
    return "Finished";
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
  }, [focusMode, url]);

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
  return focusMode ? createPortal(reader, document.body) : reader;
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
      value={dragValue ?? value}
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
  if (book.coverArtUrl && !loadFailed) {
    return (
      <img
        className={className}
        src={offlineCoverUrl ?? mediaUrl(book.coverArtUrl)}
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
  | { phase: "setup" }
  | { phase: "login" }
  | { phase: "ready"; user: AuthUser };

function initialAuthState(): AuthState {
  if (isDemoMode()) return { phase: "ready", user: DEMO_USER };
  if (isLocalMode()) return { phase: "ready", user: DEVICE_USER };
  if (!hasUserConfiguredServer()) return { phase: "server" };

  // A native launch should not sit behind a network timeout. This is the same
  // cached identity used for offline mode; checkAuth validates it in the
  // background and still returns to login if the server rejects the session.
  const cachedUser = isNativeApp() && getStoredToken() ? getOfflineUser() : null;
  return cachedUser
    ? { phase: "ready", user: cachedUser }
    : { phase: "loading" };
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
        setAuthState({ phase: "setup" });
        return;
      }
      if (status.user) {
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
        onAuthenticated={(token, user) => {
          setStoredToken(token);
          cacheOfflineUser(user);
          setAuthState({ phase: "ready", user });
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
  const [nativeTab, setNativeTab] = useState<NativeTab>("reading");
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
  const [nativePlayerView, setNativePlayerView] = useState<"now" | "details" | "chapters">("now");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playerPaneRef = useRef<HTMLElement | null>(null);
  const saveStartedAt = useRef(0);
  const playWhenTrackLoads = useRef(false);
  const progressSaveInFlight = useRef(false);
  const queuedProgressSaves = useRef<Map<string, QueuedProgressSave>>(new Map());
  const progressMutationVersion = useRef(0);
  const restoredProgressBookId = useRef<string | null>(null);
  const initialLibraryHydrated = useRef(false);
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
  const [sortMode, setSortMode] = useState<SortMode>("title");
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
  const libationMessage = formatLibationMessage(libationStatus);
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
  const nativeAudio = usesNativeAudioPlayer();
  const [downloadedBookIds, setDownloadedBookIds] = useState<Set<string>>(new Set());
  const [downloadStatus, setDownloadStatus] = useState<DeviceNotice | null>(null);
  // Native jobs are persisted and serialized by iOS; this map only mirrors
  // their current queue/progress for the UI.
  const [activeDownloads, setActiveDownloads] = useState<Record<string, DeviceDownloadActivity>>({});
  const activeDownloadIdsRef = useRef<Set<string>>(new Set());
  const [deviceImport, setDeviceImport] = useState<{ completed: number; total: number } | null>(null);

  const visibleBooks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = query
      ? books.filter((book) =>
          [book.title, book.author, book.narrator]
            .filter(Boolean)
            .some((field) => field!.toLowerCase().includes(query))
        )
      : books;

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortMode) {
        case "author":
          return (a.author ?? "").localeCompare(b.author ?? "") || a.title.localeCompare(b.title);
        case "duration":
          return (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0);
        case "tracks":
          return b.trackCount - a.trackCount;
        case "title":
        default:
          return a.title.localeCompare(b.title);
      }
    });
    return sorted;
  }, [books, searchQuery, sortMode]);

  const visibleLibationBooks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = query
      ? libationBooks.filter((book) =>
          [book.title, book.subtitle, book.authors, book.narrators]
            .filter(Boolean)
            .some((field) => field!.toLowerCase().includes(query))
        )
      : libationBooks;

    return [...filtered].sort((a, b) => a.title.localeCompare(b.title));
  }, [libationBooks, searchQuery]);

  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedBookId) ?? books[0] ?? null,
    [books, selectedBookId]
  );
  const selectedDescription = selectedBook ? displayBookDescription(selectedBook) : null;
  const descriptionCanExpand = (selectedDescription?.length ?? 0) > 260;
  const selectedDownload = selectedBook ? activeDownloads[selectedBook.id] : undefined;
  const deviceDownloadQueue = useMemo(
    () => Object.values(activeDownloads).sort((a, b) => a.queuedAt - b.queuedAt),
    [activeDownloads]
  );

  const playbackBook = useMemo(
    () =>
      books.find((book) => book.id === playbackBookId) ??
      selectedBook ??
      books[0] ??
      null,
    [books, playbackBookId, selectedBook]
  );
  const nowPlayingBook = playbackBook ?? selectedBook;

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

    return playbackBook.chapters.map((chapter, index) => {
      const nextChapter = playbackBook.chapters[index + 1];
      const endSeconds = chapter.endSeconds ?? nextChapter?.startSeconds ?? bookDuration;
      return {
        ...chapter,
        chapterNumber: index + 1,
        endSeconds: Math.max(chapter.startSeconds, Math.min(endSeconds, bookDuration)),
        durationSeconds: Math.max(1, Math.min(endSeconds, bookDuration) - chapter.startSeconds)
      };
    });
  }, [bookDuration, playbackBook]);
  const activeChapter =
    chapterSegments.find(
      (chapter) => bookPosition >= chapter.startSeconds && bookPosition < chapter.endSeconds
    ) ?? chapterSegments[chapterSegments.length - 1] ?? null;
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
  const hasPreviousChapter = activeChapterIndex > 0 || chapterElapsed > 5;
  const hasNextChapter = activeChapterIndex >= 0 && activeChapterIndex < chapterSegments.length - 1;
  const isViewingPlayingBook = !!selectedBook && !!playbackBook && selectedBook.id === playbackBook.id;
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
    setIsLoading(true);
    setError(null);
    const deviceBooks = native ? getDeviceBooks() : [];
    const applyLoadedBooks = (nextBooks: Book[]) => {
      setBooks(nextBooks);
      setSelectedBookId((existing) =>
        resolveBookId(nextBooks, existing ?? readStoredBookId(currentUser.id, "selectedBookId"))
      );
      setPlaybackBookId((existing) =>
        resolveBookId(
          nextBooks,
          existing ?? readStoredBookId(currentUser.id, "playbackBookId"),
          readStoredBookId(currentUser.id, "selectedBookId")
        )
      );
    };
    if (localMode) {
      applyLoadedBooks(deviceBooks);
      setIsOffline(false);
      setIsLoading(false);
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
      hydratedServerBooks = await getCachedLibrary(currentUser.id).catch(() => []);
      const hydratedBooks = mergeDeviceAndServerBooks(hydratedServerBooks, deviceBooks);
      if (hydratedBooks.length) {
        applyLoadedBooks(hydratedBooks);
        setIsOffline(false);
        setIsLoading(false);
      }
    }

    try {
      const liveLibrary = await liveLibraryRequest;
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
        await saveProgress(book.id, {
          ...local,
          trackId: location.trackId,
          positionSeconds: location.positionSeconds
        }, { isPaused: true }).catch(() => undefined);
      })).catch(() => undefined);
      applyLoadedBooks(nextBooks);
      setIsOffline(false);
      void cacheLibrary(currentUser.id, serverBooks);
      if (isOperaLibre) {
        // Audio tags commonly omit the publisher blurb. Libation already has
        // the correct Audible description and returns its matched local book
        // id, so enrich in the background without delaying the shelf.
        void getLibationBooks()
          .then((catalog) => {
            setLibationBooks(catalog);
            setLibationBooksLoaded(true);
          })
          .catch(() => undefined);
      }
    } catch {
      const cachedServer = hydratedServerBooks.length
        ? hydratedServerBooks
        : await getCachedLibrary(currentUser.id);
      const cached = mergeDeviceAndServerBooks(cachedServer, deviceBooks);
      setIsOffline(true);
      if (cached.length) {
        applyLoadedBooks(cached);
        setError("Offline mode — showing downloaded books and cached library.");
      } else {
        setError("The audiobook server is not reachable.");
      }
    } finally {
      setIsLoading(false);
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
          message: access.enabled ? null : "Libation is not configured on this server."
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
      const confirmedAsins = new Set(nextBooks.filter((book) => !!book.localBookId).map((book) => book.asin));
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
                .map((request) => request.asin)
            : [];
          libationDownloadRequestsRef.current = ownRequests;
          libationRequestsLoadedRef.current = true;
          setLibationDownloadRequests(ownRequests);
          const approvedAsins = ownRequests
            .filter((request) => request.status === "approved" && request.jobId)
            .map((request) => request.asin);
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
  }, [currentUser.id, currentUser.libationAccess, librarySource]);

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
      void listJobs()
        .then((jobs) => {
          if (cancelled || generation !== libationJobsGenerationRef.current) {
            return;
          }
          const previous = libationJobsRef.current;
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
                return libationBooks.filter((book) => !book.localBookId).map((book) => book.asin);
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
  }, [libationJobs, loadBooks, loadLibationBooks]);

  useEffect(() => {
    if (libationJobs.some(isPendingJob)) {
      return;
    }
    const remainingAsins = new Set(
      [...libationFinalizingAsins].filter(
        (asin) =>
          !libationFinalizationFailures.has(asin) &&
          !libationBooks.some((book) => book.asin === asin && !!book.localBookId)
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
          const localBook = nextBooks.find((book) => book.asin === asin && !!book.localBookId);
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
            `${failedTitle ?? "The title"} never appeared in the local library. Decryption or import may have failed.`
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
    const restoreVersion = progressMutationVersion.current;
    const applyProgress = (progress: Progress | null) => {
      if (cancelled || progressMutationVersion.current !== restoreVersion) {
        return;
      }
      const location = resolveProgressLocation(playbackBook.tracks, progress);
      setCurrentTrackId(location?.trackId ?? null);
      setPendingSeek(location);
      // Show the restored time immediately; the media element seeks to it
      // once metadata loads.
      setPosition(location?.positionSeconds ?? 0);
      restoredProgressBookId.current = playbackBook.id;
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
      // network timeout whenever the server was unreachable.
      const optimistic = freshestProgress(freshestLocal, listed);
      if (optimistic) {
        applyProgress(optimistic);
      }
      let server: Progress | null = null;
      let serverReachable = true;
      try {
        server = await getProgress(playbackBook.id);
      } catch {
        serverReachable = false;
      }
      if (cancelled) {
        return;
      }
      const lastKnownServer = server ?? listed;
      const localIsNewer = !!freshestLocal && (!lastKnownServer || progressTimestamp(freshestLocal.updatedAt) > progressTimestamp(lastKnownServer.updatedAt));
      if (localIsNewer) {
        updateBookProgress(playbackBook.id, freshestLocal);
        if (serverReachable) {
          void saveProgress(playbackBook.id, freshestLocal, { isPaused: true }).catch(() => undefined);
        }
      }
      const target = localIsNewer ? freshestLocal : lastKnownServer ?? freshestLocal;
      // Re-seek only when the reconciled copy is genuinely fresher than what
      // was already applied; re-applying an equal copy would yank playback.
      if (
        !optimistic ||
        (target && progressTimestamp(target.updatedAt) > progressTimestamp(optimistic.updatedAt))
      ) {
        applyProgress(target);
      }
    })();

    return () => {
      cancelled = true;
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
      {
        scopeKey: nativeAudioRecoveryScope(currentUser.id, playbackBook.id),
        trackId: currentTrack.id,
        bookOffsetSeconds: trackOffsetSeconds(playbackBook, activeTrackIndex)
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
  }, [currentTrackKey, pendingSeek, streamUrl]);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    let active = true;
    if (!playbackBook?.coverArtUrl) {
      setMediaArtworkUrl(null);
      return;
    }
    const networkArtwork = mediaUrl(playbackBook.coverArtUrl);
    if (!native) {
      setMediaArtworkUrl(networkArtwork);
      return;
    }
    void getOfflineCoverUrl(playbackBook).then((localArtwork) => {
      if (active) setMediaArtworkUrl(localArtwork ?? networkArtwork);
    });
    return () => {
      active = false;
    };
  }, [native, playbackBookKey, playbackBook?.coverArtUrl]);

  useEffect(() => {
    if (!playbackBook || !currentTrack) {
      return;
    }

    const nowPlaying = {
      title: activeChapter?.title ?? currentTrack.title,
      artist: playbackBook.author ?? "Audiobook",
      album: playbackBook.title,
      artworkUrl: mediaArtworkUrl ?? undefined
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
  }, [activeChapter?.id, currentTrackKey, mediaArtworkUrl, nativeAudio, playbackBookKey]);

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
      !audioRef.current
    ) {
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
      updatedAt: new Date().toISOString()
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

    queuedProgressSaves.current.set(playbackBook.id, {
      bookId: playbackBook.id,
      progress: localProgress,
      isPaused: nativeAudio ? !nativePlaybackPlayingRef.current : audioRef.current.paused
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
            { isPaused: entry.isPaused }
          );
          const local = readProgressCheckpoint(
            window.localStorage,
            getServerStorageKey(),
            currentUser.id,
            entry.bookId
          );
          if (!local || progressTimestamp(saved.updatedAt) >= progressTimestamp(local.updatedAt)) {
            updateBookProgress(entry.bookId, saved);
          }
        } catch {
          // The synchronous checkpoint and IndexedDB copy already contain the
          // position. A later playback tick or reconnect will retry the server.
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
        const durationSeconds = book.durationSeconds ?? durationFromTracks(book);
        const remainingSeconds =
          durationSeconds > 0
            ? Math.max(0, durationSeconds - saved.bookPositionSeconds)
            : null;
        const percentComplete =
          durationSeconds > 0
            ? Math.min(100, Math.max(0, (saved.bookPositionSeconds / durationSeconds) * 100))
            : null;
        const status =
          durationSeconds > 0 && remainingSeconds !== null && (remainingSeconds <= 30 || percentComplete! >= 99.5)
            ? "finished"
            : saved.bookPositionSeconds > 0
              ? "inProgress"
              : "notStarted";
        return {
          ...book,
          progress: {
            status,
            bookPositionSeconds: saved.bookPositionSeconds,
            durationSeconds: durationSeconds > 0 ? durationSeconds : null,
            remainingSeconds,
            percentComplete,
            updatedAt: saved.updatedAt
          }
        };
      })
    );
  }

  async function downloadForOffline(book: Book) {
    if (activeDownloadIdsRef.current.has(book.id)) return;
    activeDownloadIdsRef.current.add(book.id);
    if (playbackBook?.id === book.id) {
      persistProgress();
    }
    setDownloadStatus(null);
    setActiveDownloads((existing) => ({
      ...existing,
      [book.id]: { bookId: book.id, fraction: null, state: "queued", queuedAt: Date.now() }
    }));
    try {
      await downloadBookForOffline(book, mediaUrl, (done, total, percent, state) => {
        const fraction = total > 0 ? Math.min(1, (done + (percent ?? 0) / 100) / total) : null;
        setActiveDownloads((existing) => ({
          ...existing,
          [book.id]: {
            bookId: book.id,
            fraction,
            state: state === "queued" ? "queued" : "running",
            queuedAt: existing[book.id]?.queuedAt ?? Date.now()
          }
        }));
      });
      setDownloadedBookIds((existing) => new Set(existing).add(book.id));
      setDownloadStatus({ bookId: book.id, message: `${book.title} is available offline` });
    } catch (downloadError) {
      setDownloadStatus({
        bookId: book.id,
        message: `${book.title}: ${errorMessage(downloadError, "Download failed.")}`
      });
    } finally {
      activeDownloadIdsRef.current.delete(book.id);
      setActiveDownloads((existing) => {
        const next = { ...existing };
        delete next[book.id];
        return next;
      });
    }
  }

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
    if (playbackBook?.deviceBookId === deviceBookId || playbackBook?.id === deviceBookId) {
      persistProgress();
    }
    if (playbackBook?.deviceBookId === deviceBookId || playbackBook?.id === deviceBookId) pausePlayback(audioRef.current);
    await removeDeviceBook(deviceBookId);
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
    setPosition(audio.currentTime);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);

    const now = Date.now();
    if (now - saveStartedAt.current >= PROGRESS_SAVE_INTERVAL_MS) {
      saveStartedAt.current = now;
      void persistProgress();
    }
  }

  function startPlayback(audio: HTMLAudioElement | null | undefined) {
    if (!audio) return;
    if (!nativeAudio) {
      safePlay(audio);
      return;
    }
    nativePlaybackPlayingRef.current = true;
    setIsPlaying(true);
    void playNativeAudio().catch((error) => {
      nativePlaybackPlayingRef.current = false;
      setIsPlaying(false);
      setPlaybackError(errorMessage(error, "Native audio playback failed."));
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
      setPlaybackError(errorMessage(error, "Native audio playback could not be paused."));
    });
  }

  function setPlaybackPosition(audio: HTMLAudioElement, value: number) {
    const nextPosition = Math.max(0, Math.min(value, audio.duration || value));
    audio.currentTime = nextPosition;
    if (nativeAudio) {
      void seekNativeAudio(nextPosition).catch((error) => {
        setPlaybackError(errorMessage(error, "Native audio could not seek."));
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
    audio.volume = volume;
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
      startPlayback(audio);
    }
  }

  function seekBy(delta: number) {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    haptic("light");
    const nextPosition = setPlaybackPosition(audio, audio.currentTime + delta);
    setPosition(nextPosition);
    void persistProgress();
  }

  function seekTo(value: number) {
    if (!audioRef.current) {
      return;
    }
    const nextPosition = setPlaybackPosition(audioRef.current, value);
    setPosition(nextPosition);
    void persistProgress();
  }

  function seekBookPositionInBook(book: Book, value: number, autoPlay = false) {
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
    if (autoPlay) {
      window.setTimeout(playWhenReady, 0);
    }
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
    if (native) {
      setNativeTab("reading");
      setNativePlayerView("now");
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
    if (autoPlay) {
      window.setTimeout(playWhenReady, 0);
    }
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
    void persistProgress();
    if (!playbackBook || activeTrackIndex >= playbackBook.tracks.length - 1) {
      playWhenTrackLoads.current = false;
      setIsPlaying(false);
      return;
    }
    playWhenTrackLoads.current = true;
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

  function openNativeTab(tab: NativeTab) {
    haptic("light");
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
      setBooks(nextBooks);
      setIsOffline(false);
      setSelectedBookId((existing) =>
        resolveBookId(nextBooks, existing ?? readStoredBookId(currentUser.id, "selectedBookId"))
      );
      setPlaybackBookId((existing) =>
        resolveBookId(
          nextBooks,
          existing ?? readStoredBookId(currentUser.id, "playbackBookId"),
          readStoredBookId(currentUser.id, "selectedBookId")
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
    const availableIds = new Set(nextBooks.map((book) => book.id));
    setBooks(nextBooks);
    setSelectedBookId((existing) => resolveBookId(nextBooks, existing));
    setPlaybackBookId((existing) => {
      if (existing && !availableIds.has(existing)) {
        pausePlayback(audioRef.current);
        setCurrentTrackId(null);
        setPosition(0);
        return resolveBookId(nextBooks, null);
      }
      return existing;
    });
    if (libationBooksLoaded) void loadLibationBooks();
  }

  function chooseUploadFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    setUploadFiles(files);
    setUploadError(null);
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
    libationFinalizationStartedRef.current.delete(book.asin);
    setLibationFinalizingAsins((current) => {
      const next = new Set(current);
      next.delete(book.asin);
      return next;
    });
    setLibationFinalizationFailures((current) => {
      const next = new Set(current);
      next.delete(book.asin);
      return next;
    });
    setLibationRequests((current) => new Set(current).add(book.asin));
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
        const request = await requestLibationBook(book.asin, book.title);
        setLibationDownloadRequests((current) => {
          const next = [request, ...current.filter((item) => item.id !== request.id)];
          libationDownloadRequestsRef.current = next;
          libationRequestsLoadedRef.current = true;
          return next;
        });
        return;
      }
      const created = await liberateLibationBook(book.asin);
      if (actingUser.isAdmin) {
        trackLibationJob({
          id: created.jobId,
          kind: "libation-liberate",
          targetId: book.asin,
          status: "queued",
          startedAt: new Date().toISOString(),
          finishedAt: null,
          exitCode: null,
          output: `Starting liberation for ${book.title}.`,
          error: null
        });
      } else {
        libationFinalizationStartedRef.current.set(book.asin, Date.now());
        setLibationFinalizingAsins((current) => new Set([...current, book.asin]));
      }
    } catch (error) {
      setLibationError(errorMessage(error, `The download could not be started for ${book.title}.`));
    } finally {
      setLibationRequests((current) => {
        const next = new Set(current);
        next.delete(book.asin);
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
      className={
        native
          ? `shell native-shell tab-${nativeTab}${nativeTab === "shelf" && nativePlayerView === "details" ? " library-book-open" : ""}`
          : "shell"
      }
    >
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
                onChange={(event) => setSortMode(event.currentTarget.value as SortMode)}
                aria-label="Sort library by"
              >
                {SORT_OPTIONS.map((option) => (
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
            <div className="source-toggle" role="group" aria-label="Library source">
              <button
                type="button"
                className={librarySource === "local" ? "selected" : ""}
                onClick={() => setLibrarySource("local")}
                aria-pressed={librarySource === "local"}
              >
                <Library size={13} />
                <span>Local</span>
              </button>
              <button
                type="button"
                className={librarySource === "audible" ? "selected" : ""}
                onClick={() => setLibrarySource("audible")}
                aria-pressed={librarySource === "audible"}
              >
                <Cloud size={13} />
                <span>Audible</span>
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

            {libationStatus?.accounts.length ? (
              <div className="account-list">
                {libationStatus.accounts.map((account) => (
                  <span key={`${account.accountId}-${account.locale}`} className={account.authenticated ? "ok" : "warn"}>
                    <KeyRound size={12} />
                    {account.name || account.accountId} · {account.locale}
                  </span>
                ))}
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

            <p className="libation-help">{currentUser.libationAccess === "direct" ? "Refresh checks Audible for new purchases. Download adds a title to this OperaLibre library." : "You can browse Audible, but each download requires approval from another authorized administrator or owner."}</p>

            {displayedLibationJobs.map((job) => {
              const targetTitle = job.targetId
                ? libationBooks.find((book) => book.asin === job.targetId)?.title
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
            <p>
              {currentUser.libationAccess === "direct"
                ? "Your administrator allows you to add titles directly to the shared library."
                : "Choose Request on a title. An administrator must approve it before Libation downloads it."}
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
                const unavailableOffline = isOffline && !downloadedBookIds.has(book.id);
                return (
                  <button
                    key={book.id}
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
                    <span className="book-text">
                      <strong>{book.title}</strong>
                      <span>{bookSubtitle(book) || `${book.trackCount} track${book.trackCount === 1 ? "" : "s"}`}</span>
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
                    </span>
                  </button>
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
                  (request) => request.asin === book.asin && request.status !== "rejected"
                );
                const isAwaitingApproval = downloadRequest?.status === "pending";
                const isApprovedRequest = downloadRequest?.status === "approved" && !!downloadRequest.jobId;
                const pendingDownloadJob =
                  pendingLibationJobs.find(
                    (job) => job.kind === "libation-liberate" && job.targetId === book.asin
                  ) ?? downloadAllLibationJob;
                const latestBookJob = libationJobs.find(
                  (job) => job.kind === "libation-liberate" && job.targetId === book.asin
                );
                const isStarting = libationAllPending || libationRequests.has(book.asin);
                const isQueued = pendingDownloadJob?.status === "queued";
                const isDownloading = pendingDownloadJob?.status === "running";
                const finalizationFailed = libationFinalizationFailures.has(book.asin);
                const isFinalizing = isLibationAdding({
                  isLocal,
                  confirmationPending: libationFinalizingAsins.has(book.asin),
                  confirmationFailed: finalizationFailed
                });
                const didFail = latestBookJob?.status === "failed" || finalizationFailed;
                const metaParts = [
                  book.authors,
                  formatMinutes(book.lengthMinutes),
                  isLocal ? "In library" : book.bookStatus
                ].filter(Boolean);
                return (
                  <div key={book.asin} className={`audible-row ${isLocal ? "is-local" : ""}`}>
                    <LibationCoverArt book={book} />
                    <div className="audible-copy">
                      <strong>{book.title}</strong>
                      <span>{metaParts.join(" · ")}</span>
                    </div>
                    {isLocal ? (
                      <button
                        type="button"
                        className="local-marker"
                        aria-label={`Open ${book.title} from the local library`}
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
        className={`player-pane ${
          native
            ? `native-player-view-${nativePlayerView} ${selectedBook && currentTrack ? "has-native-player" : ""}`
            : ""
        }`}
        ref={playerPaneRef}
        onScroll={handlePlayerPaneScroll}
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
        {selectedBook && currentTrack ? (
          <>
            {native && nowPlayingBook ? (
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
                  <button type="button" onClick={() => openPlaybackView("details")}>
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
              </section>
            ) : null}
            {native && nativePlayerView !== "now" ? (
              <button
                type="button"
                className="native-player-return"
                onClick={() => {
                  if (nativeTab === "shelf") {
                    haptic("light");
                    setNativePlayerView("now");
                    return;
                  }
                  openPlaybackView("now");
                }}
              >
                {nativeTab === "shelf" ? (
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
                          void (downloadedBookIds.has(selectedBook.id)
                            ? removeOfflineDownload(selectedBook)
                            : downloadForOffline(selectedBook))
                        }
                        disabled={!!selectedDownload}
                        aria-label={
                          downloadedBookIds.has(selectedBook.id)
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
                            ? selectedDownload.state === "queued"
                              ? "Queued"
                              : selectedDownload.fraction !== null
                                ? `${Math.round(selectedDownload.fraction * 100)}%`
                                : "Preparing…"
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
              {selectedBook.publishedDate ? <span>{selectedBook.publishedDate}</span> : null}
              {selectedBook.metadata.publisher ? <span>{selectedBook.metadata.publisher}</span> : null}
              {selectedBook.genres.slice(0, native ? 2 : 3).map((genre) => <span key={genre}>{genre}</span>)}
            </div>

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
                    onClick={() => selectedBook.tracks[0] && selectTrack(selectedBook.tracks[0])}
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
                      onClick={() => selectedBook.tracks[0] && selectTrack(selectedBook.tracks[0])}
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
            </div>
            ) : null}

            {selectedBook.chapters.length > 0 ? (
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
                    <ListMusic size={13} /> {selectedBook.chapters.length} Markers
                    <ChevronDown size={14} className={`toggle-chevron ${chaptersOpen ? "open" : ""}`} />
                  </span>
                </button>
                {chaptersOpen ? (
                  <div className="track-list" ref={chaptersListRef}>
                    {selectedBook.chapters.map((chapter, index) => (
                      <button
                        key={chapter.id}
                        data-chapter-id={chapter.id}
                        className={`track-row ${isViewingPlayingBook && chapter.id === activeChapter?.id ? "active" : ""}`}
                        onClick={() => jumpToChapter(chapter)}
                      >
                        <span className="num">{String(index + 1).padStart(2, "0")}</span>
                        <strong>{chapter.title}</strong>
                        <em>{formatTime(chapter.startSeconds)}</em>
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
            <h2>An empty <em>shelf</em></h2>
            <p>Start the server with OPERALIBRE_LIBRARY pointed at your files.</p>
          </div>
        )}
      </section>

      {playbackBook && currentTrack ? (
        <aside className="mini-player" aria-label="Mini player">
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

      {native && nativePlayerSheet === "speed" ? (
        <div className="sleep-sheet-layer" role="presentation">
          <button
            type="button"
            className="sleep-sheet-scrim"
            aria-label="Close playback speed"
            onClick={() => setNativePlayerSheet(null)}
          />
          <section className="sleep-sheet" role="dialog" aria-modal="true" aria-labelledby="speed-sheet-title">
            <div className="sleep-sheet-grabber" aria-hidden="true" />
            <header>
              <div>
                <span className="eyebrow"><Gauge size={13} /> Cadence</span>
                <h2 id="speed-sheet-title">Playback Speed</h2>
              </div>
              <button type="button" className="icon-button" aria-label="Close" onClick={() => setNativePlayerSheet(null)}>
                <X size={18} />
              </button>
            </header>
            <p className="sleep-sheet-hint">Fine-tune the pace in 0.05× steps or jump to a familiar preset.</p>
            <PlaybackSpeedControl value={speed} onChange={updateSpeed} rotary />
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

      {native && nativePlayerSheet === "chapters" && playbackBook ? (
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
              {playbackBook.chapters.map((chapter, index) => (
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
                  {activeChapter?.id === chapter.id ? <em>Playing</em> : <span className="chapter-sheet-time">{formatTime(chapter.startSeconds)}</span>}
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {native && nativePlayerSheet === "sleep" ? (
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
        />
      ) : null}

      {isOperaLibre && currentUser.isAdmin && !native && usersModalOpen ? (
        <AdminPanel
          currentUser={currentUser}
          books={books}
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
                accept=".aac,.aiff,.flac,.m4a,.m4b,.mp3,.mp4,.ogg,.opus,.wav,audio/*"
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
                      const book = books.find((candidate) => candidate.id === activity.bookId);
                      return (
                        <div key={activity.bookId} className="settings-download-row">
                          <strong>{book?.title ?? "Audiobook"}</strong>
                          <span className="download-status">
                            {activity.state === "queued"
                              ? `Queued${index > 0 ? ` · ${index + 1}` : ""}`
                              : activity.fraction === null
                                ? "Starting…"
                                : `${Math.round(activity.fraction * 100)}%`}
                          </span>
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
          books={books}
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
