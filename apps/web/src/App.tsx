import {
  AlertCircle,
  Bookmark,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
import { progressTimestamp } from "./reliability";
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
  listJobs,
  logout as apiLogout,
  mediaUrl,
  pingServer,
  readalongUrl,
  reconnectUsingServerAliases,
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
import { haptic } from "./native";
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
  LibationStatus,
  SyncFragment,
  SyncMap,
  Progress,
  Track
} from "./types";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEP_OPTIONS = [5, 15, 30, 45, 60];
const APP_STATE_STORAGE_PREFIX = "operalibre.appState";
const SPEED_STORAGE_KEY = "operalibre.playbackSpeed";

type NativeTab = "shelf" | "reading" | "ledger" | "admin" | "settings";

function readStoredSpeed() {
  try {
    const stored = Number(window.localStorage.getItem(SPEED_STORAGE_KEY));
    return SPEEDS.includes(stored) ? stored : 1;
  } catch {
    return 1;
  }
}

function writeStoredSpeed(value: number) {
  try {
    window.localStorage.setItem(SPEED_STORAGE_KEY, String(value));
  } catch {
    // ignore storage failures
  }
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

/**
 * Some rips carry a chapter or track name in the comment/description tag;
 * rendering that as the book blurb reads as a glitch. Only show a
 * description that says something the page doesn't already.
 */
function displayBookDescription(book: Book) {
  const description = book.description?.trim();
  if (!description) {
    return null;
  }
  const echoes = (value: string) => value.trim().toLowerCase() === description.toLowerCase();
  if (
    echoes(book.title) ||
    book.tracks.some((track) => echoes(track.title)) ||
    book.chapters.some((chapter) => echoes(chapter.title))
  ) {
    return null;
  }
  return description;
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
  const start = Number(new Date(startedAt));
  const end = finishedAt ? Number(new Date(finishedAt)) : Date.now();
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

function mostRecentlyListenedBookId(books: Book[]) {
  return books
    .filter((book) => book.progress?.updatedAt)
    .sort(
      (a, b) =>
        Number(new Date(b.progress!.updatedAt)) - Number(new Date(a.progress!.updatedAt))
    )[0]?.id ?? null;
}

function resolveBookId(books: Book[], preferredId: string | null, fallbackId: string | null = null) {
  if (preferredId && books.some((book) => book.id === preferredId)) {
    return preferredId;
  }
  if (fallbackId && books.some((book) => book.id === fallbackId)) {
    return fallbackId;
  }
  return mostRecentlyListenedBookId(books) ?? books[0]?.id ?? null;
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

export default function App() {
  const [authState, setAuthState] = useState<
    { phase: "loading" }
    | { phase: "server"; returnToLocal?: boolean }
    | { phase: "setup" }
    | { phase: "login" }
    | { phase: "ready"; user: AuthUser }
  >({ phase: "loading" });

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
  onLogout,
  onConnectServer
}: {
  currentUser: AuthUser;
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
  const [books, setBooks] = useState<Book[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(() =>
    readStoredBookId(currentUser.id, "selectedBookId")
  );
  const [playbackBookId, setPlaybackBookId] = useState<string | null>(() =>
    readStoredBookId(currentUser.id, "playbackBookId")
  );
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(readStoredSpeed);
  const [volume, setVolume] = useState(0.9);
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const sleepDeadlineRef = useRef<number | null>(null);
  const [sleepSheetOpen, setSleepSheetOpen] = useState(false);
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
  const [libationLoading, setLibationLoading] = useState(false);
  const [libationBooksLoaded, setLibationBooksLoaded] = useState(false);
  const [libationError, setLibationError] = useState<string | null>(null);
  const [downloadingLibationBookAsin, setDownloadingLibationBookAsin] = useState<string | null>(null);
  const [libationRefreshPending, setLibationRefreshPending] = useState(false);
  const libationMessage = formatLibationMessage(libationStatus);
  const [activeJob, setActiveJob] = useState<JobStatus | null>(null);
  const isRefreshingAudible = libationRefreshPending || (activeJob?.kind === "libation-sync" && activeJob.status === "running");
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
  const [metadataForm, setMetadataForm] = useState<MetadataEditorState | null>(null);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  // null while the disk lookup for the current track is in flight; url null
  // means the track is not downloaded and should stream.
  const [offlineSource, setOfflineSource] = useState<{ trackId: string; url: string | null } | null>(null);
  const [mediaArtworkUrl, setMediaArtworkUrl] = useState<string | null>(null);
  const chaptersListRef = useRef<HTMLDivElement | null>(null);
  const wantsAutoplayRef = useRef(false);
  const [downloadedBookIds, setDownloadedBookIds] = useState<Set<string>>(new Set());
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  // fraction is 0–1 across the whole book; null means size not yet known.
  const [activeDownload, setActiveDownload] = useState<{ bookId: string; fraction: number | null } | null>(null);
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
    if (localMode) {
      setBooks(deviceBooks);
      setIsOffline(false);
      setSelectedBookId((existing) => resolveBookId(deviceBooks, existing));
      setPlaybackBookId((existing) => resolveBookId(deviceBooks, existing));
      setIsLoading(false);
      return;
    }
    try {
      const serverBooks = await getBooks();
      const nextBooks = mergeDeviceAndServerBooks(serverBooks, deviceBooks);
      for (const book of nextBooks) {
        if (book.source !== "server" || !book.deviceBookId) continue;
        const deviceProgress = getDeviceProgress(book.deviceBookId);
        const deviceBook = deviceBooks.find((candidate) => candidate.id === book.deviceBookId);
        const trackIndex = deviceBook?.tracks.findIndex((track) => track.id === deviceProgress?.trackId) ?? -1;
        const serverTrack = trackIndex >= 0 ? book.tracks[trackIndex] : null;
        const serverBook = serverBooks.find((candidate) => candidate.id === book.id);
        if (
          deviceProgress && serverTrack &&
          (!serverBook?.progress || progressTimestamp(deviceProgress.updatedAt) > progressTimestamp(serverBook.progress.updatedAt))
        ) {
          void saveProgress(book.id, {
            ...deviceProgress,
            trackId: serverTrack.id
          }, { isPaused: true }).catch(() => undefined);
        }
      }
      setBooks(nextBooks);
      setIsOffline(false);
      if (isNativeApp()) void cacheLibrary(currentUser.id, serverBooks);
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
    } catch {
      const cachedServer = isNativeApp() ? await getCachedLibrary(currentUser.id) : [];
      const cached = mergeDeviceAndServerBooks(cachedServer, deviceBooks);
      setIsOffline(true);
      if (cached.length) {
        setBooks(cached);
        setError("Offline mode — showing downloaded books and cached library.");
      } else {
        setError("The audiobook server is not reachable.");
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentUser.id, localMode, native]);

  useEffect(() => {
    if (!isNativeApp() || !books.length) return;
    void Promise.all(books.map(async (book) => [book.id, await isBookDownloaded(book)] as const))
      .then((states) => setDownloadedBookIds(new Set(states.filter(([, ready]) => ready).map(([id]) => id))));
    // Keyed on ids: re-statting every downloaded file each time a progress
    // save rebuilds `books` kept the iOS filesystem busy for no reason.
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
    window.setTimeout(() => safePlay(audioRef.current), 0);
  }, [streamUrl]);

  useEffect(() => {
    void loadBooks();
  }, [loadBooks]);

  useEffect(() => {
    writeStoredBookId(currentUser.id, "selectedBookId", selectedBookId);
  }, [currentUser.id, selectedBookId]);

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
    if (!isOperaLibre || !currentUser.isAdmin) {
      setLibationStatus(null);
      return;
    }
    try {
      const status = await getLibationStatus();
      setLibationStatus(status);
    } catch {
      setLibationStatus(null);
    }
  }, [currentUser.isAdmin, isOperaLibre]);

  const loadLibationBooks = useCallback(async () => {
    setLibationLoading(true);
    setLibationError(null);
    try {
      const nextBooks = await getLibationBooks();
      setLibationBooks(nextBooks);
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
    if (currentUser.isAdmin) {
      void loadLibationStatus();
    }
  }, [currentUser.isAdmin, loadLibationStatus]);

  useEffect(() => {
    if (!currentUser.isAdmin) {
      return;
    }
    void listJobs()
      .then((jobs) => {
        const running = jobs.find((job) => job.status === "running");
        if (running) {
          setActiveJob((existing) => existing ?? running);
        }
      })
      .catch(() => undefined);
  }, [currentUser.isAdmin]);

  useEffect(() => {
    if (librarySource === "audible" && libationStatus?.enabled && !libationBooksLoaded && !libationLoading) {
      void loadLibationBooks();
    }
  }, [libationBooksLoaded, libationLoading, libationStatus?.enabled, librarySource, loadLibationBooks]);

  useEffect(() => {
    if (!activeJob || activeJob.status !== "running") {
      return;
    }

    const timer = window.setInterval(() => {
      void getJob(activeJob.id)
        .then((job) => {
          setActiveJob(job);
          if (job.status !== "running") {
            setDownloadingLibationBookAsin(null);
            void loadLibationStatus();
            void loadLibationBooks();
            void loadBooks();
          }
        })
        .catch(() => undefined);
    }, 1800);

    return () => window.clearInterval(timer);
  }, [activeJob, loadBooks, loadLibationBooks, loadLibationStatus]);

  useEffect(() => {
    if (!playbackBook) {
      return;
    }

    let cancelled = false;
    const applyProgress = (progress: Progress | null) => {
      if (cancelled) {
        return;
      }
      const savedTrack = playbackBook.tracks.find((track) => track.id === progress?.trackId);
      setCurrentTrackId(savedTrack?.id ?? playbackBook.tracks[0]?.id ?? null);
      setPendingSeek(savedTrack ? progress?.positionSeconds ?? 0 : 0);
    };

    void (async () => {
      const deviceBookId = playbackBook.deviceBookId;
      const device = deviceBookId ? getDeviceProgress(deviceBookId) : null;
      if (playbackBook.source === "device") {
        applyProgress(device);
        return;
      }
      const cached = isNativeApp()
        ? await getCachedProgress(currentUser.id, playbackBook.id).catch(() => null)
        : null;
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
      const deviceBook = deviceBookId ? getDeviceBooks().find((book) => book.id === deviceBookId) : null;
      const deviceTrackIndex = deviceBook?.tracks.findIndex((track) => track.id === device?.trackId) ?? -1;
      const mappedServerTrack = deviceTrackIndex >= 0 ? playbackBook.tracks[deviceTrackIndex] : null;
      const mappedDevice = device && mappedServerTrack
        ? { ...device, bookId: playbackBook.id, trackId: mappedServerTrack.id }
        : null;
      // Progress saved on the device or while disconnected can be newer than
      // the server. Resume from the freshest copy and converge the server.
      const freshestLocal = [mappedDevice, cached]
        .filter((value): value is Progress => !!value)
        .sort((a, b) => progressTimestamp(b.updatedAt) - progressTimestamp(a.updatedAt))[0] ?? null;
      const localIsNewer = !!freshestLocal && (!server || progressTimestamp(freshestLocal.updatedAt) > progressTimestamp(server.updatedAt));
      if (localIsNewer) {
        applyProgress(freshestLocal);
        if (serverReachable) {
          void saveProgress(playbackBook.id, freshestLocal, { isPaused: true }).catch(() => undefined);
        }
        return;
      }
      applyProgress(server ?? freshestLocal);
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
    if (!playbackBook || !currentTrack || !("mediaSession" in navigator)) {
      return;
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: activeChapter?.title ?? currentTrack.title,
      artist: playbackBook.author ?? "Audiobook",
      album: playbackBook.title,
      artwork: mediaArtworkUrl
        ? [
            { src: mediaArtworkUrl, sizes: "512x512", type: playbackBook.coverArtContentType ?? "image/jpeg" }
          ]
        : undefined
    });
    navigator.mediaSession.setActionHandler("play", () => safePlay(audioRef.current));
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
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
  }, [activeChapter?.id, currentTrackKey, mediaArtworkUrl, playbackBookKey]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !currentTrack) return;
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
  }, [activeChapter?.id, chapterDuration, chapterElapsed, currentTrackKey, position, sliderMax, speed]);

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
        audioRef.current?.pause();
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
    setSleepSheetOpen(false);
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

  async function persistProgress() {
    if (!playbackBook || !currentTrack || !audioRef.current) {
      return;
    }

    const localProgress = {
      bookId: playbackBook.id,
      trackId: currentTrack.id,
      positionSeconds: audioRef.current.currentTime,
      bookPositionSeconds: trackOffsetSeconds(playbackBook, activeTrackIndex) + audioRef.current.currentTime,
      durationSeconds: Number.isFinite(audioRef.current.duration) ? audioRef.current.duration : currentTrack.durationSeconds,
      updatedAt: new Date().toISOString()
    };
    if (playbackBook.deviceBookId) {
      const deviceBook = getDeviceBooks().find((book) => book.id === playbackBook.deviceBookId);
      const deviceTrack = deviceBook?.tracks[activeTrackIndex];
      if (deviceTrack) saveDeviceProgress(playbackBook.deviceBookId, { ...localProgress, bookId: playbackBook.deviceBookId, trackId: deviceTrack.id });
    }
    if (isNativeApp()) void cacheProgress(currentUser.id, localProgress);
    if (playbackBook.source === "device") {
      updateBookProgress(localProgress);
      return;
    }
    if (progressSaveInFlight.current) {
      return;
    }
    progressSaveInFlight.current = true;
    const saved = await saveProgress(
      playbackBook.id,
      {
        trackId: localProgress.trackId,
        positionSeconds: localProgress.positionSeconds,
        bookPositionSeconds: localProgress.bookPositionSeconds,
        durationSeconds: localProgress.durationSeconds,
        updatedAt: localProgress.updatedAt
      },
      { isPaused: audioRef.current.paused }
      // Offline the save fails, but the position was cached above — keep the
      // shelf's progress display moving from the local copy.
    )
      .catch(() => (isNativeApp() ? localProgress : undefined))
      .finally(() => {
        progressSaveInFlight.current = false;
      });
    if (!saved) {
      return;
    }

    updateBookProgress(saved);
  }

  function updateBookProgress(saved: Progress) {
    setBooks((existing) =>
      existing.map((book) => {
        if (book.id !== playbackBook.id) {
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
    setDownloadStatus(null);
    setActiveDownload({ bookId: book.id, fraction: null });
    try {
      await downloadBookForOffline(book, mediaUrl, (done, total, percent) => {
        const fraction = total > 0 ? Math.min(1, (done + (percent ?? 0) / 100) / total) : null;
        setActiveDownload({ bookId: book.id, fraction });
      });
      setDownloadedBookIds((existing) => new Set(existing).add(book.id));
      setDownloadStatus("Available offline");
    } catch (downloadError) {
      setDownloadStatus(errorMessage(downloadError, "Download failed."));
    } finally {
      setActiveDownload(null);
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
      setDownloadStatus(`${book.title} added from this device`);
      setNativeTab("shelf");
    } catch (error) {
      const message = errorMessage(error, "The audiobook could not be imported.");
      if (!/cancel/i.test(message)) setDownloadStatus(message);
    } finally {
      setDeviceImport(null);
    }
  }

  async function deleteDeviceBook(book: Book) {
    const deviceBookId = book.deviceBookId ?? book.id;
    if (!window.confirm(`Remove ${book.title} and its listening progress from this device?`)) return;
    if (playbackBook?.deviceBookId === deviceBookId || playbackBook?.id === deviceBookId) audioRef.current?.pause();
    await removeDeviceBook(deviceBookId);
    await loadBooks();
    setDownloadStatus("Device copy removed");
  }

  async function removeOfflineDownload(book: Book) {
    await removeBookDownload(book);
    setDownloadedBookIds((existing) => {
      const next = new Set(existing);
      next.delete(book.id);
      return next;
    });
    if (playbackBook?.id === book.id) {
      setOfflineSource(currentTrack ? { trackId: currentTrack.id, url: null } : null);
    }
    setDownloadStatus("Download removed");
  }

  function onTimeUpdate() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    setPosition(audio.currentTime);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);

    const now = Date.now();
    if (now - saveStartedAt.current > 5000) {
      saveStartedAt.current = now;
      void persistProgress();
    }
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

    if (pendingSeek !== null) {
      audio.currentTime = Math.min(pendingSeek, audio.duration || pendingSeek);
      setPosition(audio.currentTime);
      setPendingSeek(null);
    } else {
      setPosition(0);
    }
    if (playWhenTrackLoads.current) {
      playWhenTrackLoads.current = false;
      safePlay(audio);
    }
  }

  function seekBy(delta: number) {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    haptic("light");
    audio.currentTime = Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + delta));
    setPosition(audio.currentTime);
    void persistProgress();
  }

  function seekTo(value: number) {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.currentTime = value;
    setPosition(value);
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
      audioRef.current.currentTime = trackPosition;
      setPosition(trackPosition);
      void persistProgress();
      if (autoPlay) {
        safePlay(audioRef.current);
      }
      return;
    }

    setCurrentTrackId(targetTrack.id);
    setPendingSeek(trackPosition);
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
      safePlay(audio);
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
    if (audio.paused) {
      safePlay(audio);
    } else {
      audio.pause();
    }
  }

  function selectBook(book: Book) {
    setSelectedBookId(book.id);
    if (native) {
      setNativeTab("shelf");
      setNativePlayerView("details");
      playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function openBookDetails(bookId: string) {
    setSelectedBookId(bookId);
    if (native) {
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
      audioRef.current.currentTime = 0;
      setPosition(0);
      if (autoPlay) {
        safePlay(audioRef.current);
      }
      return;
    }
    if (selectedBook) {
      setPlaybackBookId(selectedBook.id);
    }
    setCurrentTrackId(track.id);
    setPendingSeek(0);
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
    setPendingSeek(0);
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

  function updateSpeed(value: number) {
    setSpeed(value);
    writeStoredSpeed(value);
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
        audioRef.current?.pause();
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

  async function startLibationSync() {
    setLibationError(null);
    setLibationRefreshPending(true);
    try {
      const created = await syncLibationLibrary();
      setActiveJob({
        id: created.jobId,
        kind: "libation-sync",
        status: "running",
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
    setDownloadingLibationBookAsin(book.asin);
    try {
      const created = await liberateLibationBook(book.asin);
      setActiveJob({
        id: created.jobId,
        kind: "libation-liberate",
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        output: `Starting liberation for ${book.title}.`,
        error: null
      });
    } catch (error) {
      setDownloadingLibationBookAsin(null);
      setLibationError(errorMessage(error, `The download could not be started for ${book.title}.`));
    }
  }

  async function startAllLiberation() {
    setLibationError(null);
    try {
      const created = await liberateAllLibationBooks();
      setActiveJob({
        id: created.jobId,
        kind: "libation-liberate-all",
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        output: "Starting Audible library sync and download for all books.",
        error: null
      });
    } catch (error) {
      setLibationError(errorMessage(error, "Libation download-all could not be started."));
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
            ? localMode ? "On-device library" : demoMode ? "On-device demo" : currentUser.isAdmin ? "Administrator" : "Reader"
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
          if (localMode) audioRef.current?.pause();
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
        ref={audioRef}
        src={streamUrl || undefined}
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
          setPlaybackError(null);
          setIsPlaying(true);
          if (currentTrack && audioRef.current && playbackBook?.source !== "device") {
            void reportPlaybackStarted(currentTrack.id, audioRef.current.currentTime);
          }
        }}
        onPause={() => {
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

          {isOperaLibre && currentUser.isAdmin ? (
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
                disabled={!libationStatus?.enabled || libationLoading || libationRefreshPending || downloadingLibationBookAsin !== null || activeJob?.status === "running"}
              >
                {isRefreshingAudible ? (
                  <LoaderCircle size={13} className="spin-icon" />
                ) : (
                  <RefreshCcw size={13} />
                )}
                <span>{isRefreshingAudible ? "Refreshing" : "Refresh Audible"}</span>
              </button>
              <button
                type="button"
                onClick={() => void startAllLiberation()}
                disabled={!libationStatus?.enabled || libationLoading || libationRefreshPending || downloadingLibationBookAsin !== null || activeJob?.status === "running"}
              >
                <Download size={13} />
                <span>Download all</span>
              </button>
            </div>

            <p className="libation-help">Refresh checks Audible for new purchases. Download adds a title to this OperaLibre library.</p>

            {activeJob ? (
              <div className={`job-card ${activeJob.status}`}>
                <div className="job-card-head">
                  <span className="job-state">
                    {activeJob.status === "running" ? (
                      <LoaderCircle size={13} />
                    ) : activeJob.status === "failed" ? (
                      <AlertCircle size={13} />
                    ) : (
                      <CloudDownload size={13} />
                    )}
                    {activeJob.status === "running" ? "Running" : activeJob.status}
                  </span>
                  <strong>{jobTitle(activeJob)}</strong>
                </div>
                <p>{jobSummary(activeJob)}</p>
                <dl className="job-meta">
                  <div>
                    <dt>Elapsed</dt>
                    <dd>{formatElapsed(activeJob.startedAt, activeJob.finishedAt) ?? "Starting"}</dd>
                  </div>
                  {activeJob.exitCode !== null ? (
                    <div>
                      <dt>Exit</dt>
                      <dd>{activeJob.exitCode}</dd>
                    </div>
                  ) : null}
                </dl>
                {activeJob.status !== "running" || activeJob.error ? (
                  <pre className="job-output">{jobDetailLines(activeJob).join("\n")}</pre>
                ) : null}
              </div>
            ) : null}
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
                const isDownloading = downloadingLibationBookAsin === book.asin;
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
                        <Library size={14} />
                        <span>In library</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={isDownloading ? "is-downloading" : undefined}
                        aria-label={`${isDownloading ? "Downloading" : "Download"} ${book.title}`}
                        aria-busy={isDownloading}
                        disabled={downloadingLibationBookAsin !== null || activeJob?.status === "running"}
                        onClick={() => void startLiberation(book)}
                      >
                        {isDownloading ? <LoaderCircle size={14} className="spin-icon" /> : <CloudDownload size={14} />}
                        <span>{isDownloading ? "Downloading" : "Download"}</span>
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
                    <span>{activeChapter ? formatTime(chapterElapsed) : formatTime(position)}</span>
                    <span>
                      {activeChapter
                        ? `−${formatTime(Math.max(0, chapterDuration - chapterElapsed))}`
                        : `−${formatTime(Math.max(0, sliderMax - position))}`}
                    </span>
                  </div>
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
                    onClick={() => updateSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
                  >
                    <Gauge size={16} /> {speed}×
                  </button>
                  <button type="button" onClick={() => setSleepSheetOpen(true)}>
                    <Timer size={16} /> {sleepRemaining > 0 ? `${Math.ceil(sleepRemaining / 60)}m left` : "Sleep timer"}
                  </button>
                  <button type="button" onClick={() => openPlaybackView("details")}>
                    <Bookmark size={16} /> Details
                  </button>
                  <button
                    type="button"
                    onClick={() => openPlaybackView("chapters")}
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
                      <span className="download-btn active" aria-label="Imported from this device">
                        <FolderOpen size={13} />
                        <span>On device</span>
                      </span>
                    ) : demoMode ? (
                      <span className="download-btn active" aria-label="Included with the on-device demo">
                        <CloudDownload size={13} />
                        <span>On device</span>
                      </span>
                    ) : isNativeApp() ? (
                      <button
                        className={`download-btn ${downloadedBookIds.has(selectedBook.id) ? "active" : ""} ${
                          activeDownload?.bookId === selectedBook.id ? "downloading" : ""
                        }`}
                        type="button"
                        onClick={() =>
                          void (downloadedBookIds.has(selectedBook.id)
                            ? removeOfflineDownload(selectedBook)
                            : downloadForOffline(selectedBook))
                        }
                        disabled={activeDownload !== null}
                        aria-label={
                          downloadedBookIds.has(selectedBook.id)
                            ? `Remove downloaded copy of ${selectedBook.title}`
                            : `Download ${selectedBook.title} for offline playback`
                        }
                      >
                        {activeDownload?.bookId === selectedBook.id ? (
                          <DownloadRing fraction={activeDownload.fraction} />
                        ) : (
                          <Download size={13} />
                        )}
                        <span>
                          {activeDownload?.bookId === selectedBook.id
                            ? activeDownload.fraction !== null
                              ? `${Math.round(activeDownload.fraction * 100)}%`
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
                    {isNativeApp() && downloadStatus ? <span className="download-status">{downloadStatus}</span> : null}
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
                <p>{bookSubtitle(selectedBook) || `${selectedBook.trackCount} tracks`}</p>
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

            {displayBookDescription(selectedBook) ? (
              <p className="book-description">{displayBookDescription(selectedBook)}</p>
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
                    <span>{formatTime(bookPosition)}</span>
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
                  <button
                    className="round-button secondary transport-skip"
                    aria-label={activeChapter
                      ? chapterElapsed > 5 ? "Restart chapter" : "Previous chapter"
                      : "Skip back 15 seconds"}
                    onClick={restartOrPreviousChapter}
                    disabled={!!activeChapter && chapterElapsed <= 5 && !hasPreviousChapter}
                  >
                    <SkipBack size={22} strokeWidth={1.7} />
                    <small>{activeChapter ? chapterElapsed > 5 ? "Restart" : "Previous" : "15s"}</small>
                  </button>
                  <button className="round-button primary" aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlayback}>
                    {isPlaying ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
                  </button>
                  <button
                    className="round-button secondary transport-skip"
                    aria-label={activeChapter ? "Next chapter" : "Skip forward 30 seconds"}
                    onClick={nextChapter}
                    disabled={!!activeChapter && !hasNextChapter}
                  >
                    <SkipForward size={22} strokeWidth={1.7} />
                    <small>{activeChapter ? "Next" : "30s"}</small>
                  </button>
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
                      {activeChapter ? formatTime(chapterElapsed) : formatTime(position)}
                    </span>
                    <span>
                      {activeChapter ? formatTime(chapterDuration) : formatTime(sliderMax)}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <div className="book-preview-actions">
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
                {playbackBook && playbackBook.id !== selectedBook.id ? (
                  <button type="button" className="preview-return" onClick={scrollToPlayer}>
                    Still playing · <em>{playbackBook.title}</em>
                  </button>
                ) : null}
              </div>
            )}

            {isViewingPlayingBook ? (
            <div className="controls-grid">
              <section className="control-section">
                <div className="section-label"><Gauge size={13} /> Cadence</div>
                <div className="segmented">
                  {SPEEDS.map((option) => (
                    <button
                      key={option}
                      className={speed === option ? "selected" : ""}
                      onClick={() => updateSpeed(option)}
                    >
                      {option}×
                    </button>
                  ))}
                </div>
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
              <section className="track-list-section">
                <button
                  type="button"
                  className="track-list-header track-list-toggle"
                  aria-expanded={chaptersOpen}
                  onClick={() => setChaptersOpen((open) => !open)}
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
                ? `${formatTime(chapterElapsed)} / ${formatTime(chapterDuration)}`
                : `${formatTime(position)} / ${formatTime(sliderMax)}`}
            </span>
          </div>

          <div className="mini-actions">
            <button
              type="button"
              aria-label={activeChapter ? chapterElapsed > 5 ? "Restart chapter" : "Previous chapter" : "Skip back 15 seconds"}
              onClick={restartOrPreviousChapter}
              disabled={!!activeChapter && chapterElapsed <= 5 && !hasPreviousChapter}
            >
              <SkipBack size={17} />
            </button>
            <button type="button" className="mini-play" aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlayback}>
              {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
            <button
              type="button"
              aria-label={activeChapter ? "Next chapter" : "Skip forward 30 seconds"}
              onClick={nextChapter}
              disabled={!!activeChapter && !hasNextChapter}
            >
              <SkipForward size={17} />
            </button>
          </div>
        </aside>
      ) : null}

      {native && sleepSheetOpen ? (
        <div className="sleep-sheet-layer" role="presentation">
          <button
            type="button"
            className="sleep-sheet-scrim"
            aria-label="Close sleep timer"
            onClick={() => setSleepSheetOpen(false)}
          />
          <section className="sleep-sheet" role="dialog" aria-modal="true" aria-labelledby="sleep-sheet-title">
            <div className="sleep-sheet-grabber" aria-hidden="true" />
            <header>
              <div>
                <span className="eyebrow"><Timer size={13} /> Nightfall</span>
                <h2 id="sleep-sheet-title">Sleep Timer</h2>
              </div>
              <button type="button" className="icon-button" aria-label="Close" onClick={() => setSleepSheetOpen(false)}>
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
              <div className="segmented">
                {SPEEDS.map((option) => (
                  <button
                    key={option}
                    className={speed === option ? "selected" : ""}
                    onClick={() => updateSpeed(option)}
                  >
                    {option}×
                  </button>
                ))}
              </div>
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
            {downloadStatus ? <p className="settings-hint">{downloadStatus}</p> : null}
          </section>

          {!localMode ? <section className="settings-card">
            <span className="section-label"><Download size={13} /> Server downloads</span>
            {demoMode ? (
              <p className="settings-hint">Demo books and their procedural audio are included on this device.</p>
            ) : books.some((book) => downloadedBookIds.has(book.id) && !book.deviceBookId) ? (
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
            ) : (
              <p className="settings-hint">No books are downloaded for offline listening yet.</p>
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
                {currentUser.username} · {localMode ? "No account required" : demoMode ? "Demo reader" : currentUser.isAdmin ? "Administrator" : "Reader"}
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
                  audioRef.current?.pause();
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
                audioRef.current?.pause();
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
