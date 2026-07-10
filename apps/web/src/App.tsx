import {
  AlertCircle,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudDownload,
  Download,
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
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  RotateCw,
  Search,
  ServerOff,
  Sparkles,
  Timer,
  ScrollText,
  UserCog,
  Volume2,
  X
} from "lucide-react";
import type { Book as EpubBook, Contents, EpubCFI, Location, NavItem, Rendition } from "epubjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  bookDownloadUrl,
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
  getStoredToken,
  hasUserConfiguredServer,
  liberateAllLibationBooks,
  liberateLibationBook,
  listJobs,
  logout as apiLogout,
  mediaUrl,
  readalongUrl,
  rescanLibrary,
  saveProgress,
  setStoredToken,
  setUnauthorizedHandler,
  syncLibationLibrary,
  updateBookMetadata
} from "./api";
import { AuthGate, ServerSetup, UserManagementModal } from "./Auth";
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
  Track
} from "./types";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEP_OPTIONS = [0, 15, 30, 45, 60];
const APP_STATE_STORAGE_PREFIX = "operalibre.appState";

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
  const start = Number(new Date(startedAt));
  const end = finishedAt ? Number(new Date(finishedAt)) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return formatDurationLabel((end - start) / 1000);
}

function jobTitle(job: JobStatus) {
  if (job.kind === "libation-sync") {
    return "Audible library sync";
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

function isLiberatedStatus(status: string | null | undefined) {
  const normalized = status?.toLowerCase() ?? "";
  return normalized.includes("liberated") || normalized.includes("downloaded");
}

function canPreviewReadalong(book: Book) {
  const extension = book.readingFile?.extension.toLowerCase();
  return extension === "epub" || extension === "pdf" || extension === "txt" || extension === "html" || extension === "htm";
}

function storedStateKey(userId: string, field: "selectedBookId" | "playbackBookId") {
  return `${APP_STATE_STORAGE_PREFIX}.${userId}.${field}`;
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
  return best >= 0 && seconds < fragments[best].endSeconds ? best : -1;
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
      { fill: "#d9a441", "fill-opacity": "0.32", "mix-blend-mode": "multiply" }
    );
    highlightCfiRef.current = cfi;

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
  }, [follow, fragmentIndex, isReady, location, onSeekTo, syncFragments]);

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

function CoverArt({ book, size }: { book: Book; size: "small" | "large" }) {
  const className = size === "small" ? "cover-mark" : "large-cover";
  if (book.coverArtUrl) {
    return <img className={className} src={mediaUrl(book.coverArtUrl)} alt="" />;
  }
  return (
    <span className={className} aria-hidden="true">
      <Headphones size={size === "small" ? 22 : 42} strokeWidth={1.25} />
    </span>
  );
}

export default function App() {
  const [authState, setAuthState] = useState<
    { phase: "loading" }
    | { phase: "server" }
    | { phase: "setup" }
    | { phase: "login" }
    | { phase: "ready"; user: AuthUser }
  >({ phase: "loading" });

  const checkAuth = useCallback(async () => {
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
        setAuthState({ phase: "ready", user });
      } catch {
        setStoredToken(null);
        setAuthState({ phase: "login" });
      }
    } catch {
      setAuthState({ phase: "login" });
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
      <main className="auth-shell">
        <div className="auth-card">
          <p>Loading…</p>
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
      />
    );
  }

  if (authState.phase === "setup" || authState.phase === "login") {
    return (
      <AuthGate
        mode={authState.phase}
        onAuthenticated={(token, user) => {
          setStoredToken(token);
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
      onLogout={async () => {
        try {
          await apiLogout();
        } catch {
          // ignore
        }
        setStoredToken(null);
        setAuthState({ phase: "login" });
      }}
    />
  );
}

function MainApp({
  currentUser,
  onLogout
}: {
  currentUser: AuthUser;
  onLogout: () => void | Promise<void>;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playerPaneRef = useRef<HTMLElement | null>(null);
  const saveStartedAt = useRef(0);
  const playWhenTrackLoads = useRef(false);
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
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(0.9);
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [sleepEndsAt, setSleepEndsAt] = useState<number | null>(null);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
  const [activeJob, setActiveJob] = useState<JobStatus | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [metadataEditOpen, setMetadataEditOpen] = useState(false);
  const [metadataForm, setMetadataForm] = useState<MetadataEditorState | null>(null);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);

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
  const streamUrl = currentTrack ? mediaUrl(currentTrack.streamUrl) : "";
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
    try {
      const nextBooks = await getBooks();
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
    } catch {
      setError("The audiobook server is not reachable.");
    } finally {
      setIsLoading(false);
    }
  }, [currentUser.id]);

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
    try {
      const status = await getLibationStatus();
      setLibationStatus(status);
    } catch {
      setLibationStatus(null);
    }
  }, []);

  const loadLibationBooks = useCallback(async () => {
    setLibationLoading(true);
    setLibationError(null);
    try {
      const nextBooks = await getLibationBooks();
      setLibationBooks(nextBooks);
      setLibationBooksLoaded(true);
    } catch {
      setLibationError("Libation books could not be loaded.");
      setLibationBooksLoaded(true);
    } finally {
      setLibationLoading(false);
    }
  }, []);

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
    void getProgress(playbackBook.id)
      .then((progress) => {
        if (cancelled) {
          return;
        }
        const savedTrack = playbackBook.tracks.find((track) => track.id === progress?.trackId);
        setCurrentTrackId(savedTrack?.id ?? playbackBook.tracks[0]?.id ?? null);
        setPendingSeek(savedTrack ? progress?.positionSeconds ?? 0 : 0);
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentTrackId(playbackBook.tracks[0]?.id ?? null);
          setPendingSeek(0);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [playbackBook]);

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
    if (!playbackBook || !currentTrack || !("mediaSession" in navigator)) {
      return;
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: playbackBook.author ?? "Audiobook",
      album: playbackBook.title
    });
    navigator.mediaSession.setActionHandler("play", () => void audioRef.current?.play());
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
    navigator.mediaSession.setActionHandler("seekbackward", () => seekBy(-15));
    navigator.mediaSession.setActionHandler("seekforward", () => seekBy(30));
  }, [currentTrack, playbackBook]);

  useEffect(() => {
    if (sleepMinutes <= 0) {
      setSleepEndsAt(null);
      setSleepRemaining(0);
      return;
    }
    setSleepEndsAt(Date.now() + sleepMinutes * 60 * 1000);
  }, [sleepMinutes]);

  useEffect(() => {
    if (!sleepEndsAt) {
      return;
    }

    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((sleepEndsAt - Date.now()) / 1000));
      setSleepRemaining(remaining);
      if (remaining === 0) {
        audioRef.current?.pause();
        setSleepMinutes(0);
        setSleepEndsAt(null);
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [sleepEndsAt]);

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

    const saved = await saveProgress(playbackBook.id, {
      trackId: currentTrack.id,
      positionSeconds: audioRef.current.currentTime,
      bookPositionSeconds:
        trackOffsetSeconds(playbackBook, activeTrackIndex) + audioRef.current.currentTime,
      durationSeconds: Number.isFinite(audioRef.current.duration)
        ? audioRef.current.duration
        : currentTrack.durationSeconds
    }).catch(() => undefined);
    if (!saved) {
      return;
    }

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
      void audio.play();
    }
  }

  function seekBy(delta: number) {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
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
        void audioRef.current.play();
      }
      return;
    }

    setCurrentTrackId(targetTrack.id);
    setPendingSeek(trackPosition);
    setPosition(trackPosition);
    playWhenTrackLoads.current = autoPlay;
  }

  function seekBookPosition(value: number, autoPlay = false) {
    if (!playbackBook) {
      return;
    }

    seekBookPositionInBook(playbackBook, value, autoPlay);
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  }

  function selectBook(book: Book) {
    setSelectedBookId(book.id);
  }

  function selectTrack(track: Track, autoPlay = true) {
    void persistProgress();
    if (
      selectedBook?.id === playbackBook?.id &&
      track.id === currentTrack?.id &&
      audioRef.current
    ) {
      audioRef.current.currentTime = 0;
      setPosition(0);
      if (autoPlay) {
        void audioRef.current.play();
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
  }

  function jumpToChapter(chapter: Chapter) {
    if (!selectedBook) {
      return;
    }

    void persistProgress();
    seekBookPositionInBook(selectedBook, chapter.startSeconds, true);
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
    if (playbackBook) {
      setSelectedBookId(playbackBook.id);
    }
    playerPaneRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function refreshLibrary() {
    setIsLoading(true);
    try {
      const nextBooks = await rescanLibrary();
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
      setError(null);
    } catch {
      setError("Library rescan failed.");
    } finally {
      setIsLoading(false);
    }
  }

  async function startLibationSync() {
    setLibationError(null);
    setLibationBooksLoaded(false);
    try {
      const created = await syncLibationLibrary();
      setActiveJob({
        id: created.jobId,
        kind: "libation-sync",
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        output: "Starting Libation library scan.",
        error: null
      });
    } catch (error) {
      setLibationError(errorMessage(error, "Libation sync could not be started."));
    }
  }

  async function startLiberation(book: LibationBook) {
    setLibationError(null);
    setLibationBooksLoaded(false);
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
      setLibationError(errorMessage(error, `Liberation could not be started for ${book.title}.`));
    }
  }

  async function startAllLiberation() {
    setLibationError(null);
    setLibationBooksLoaded(false);
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

  return (
    <main className="shell">
      <audio
        ref={audioRef}
        src={streamUrl}
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onPlay={() => setIsPlaying(true)}
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

      <aside className={`library-pane ${libraryOpen ? "open" : ""}`}>
        <div className="pane-title">
          <div>
            <span className="eyebrow"><Library size={13} /> The Collection</span>
            <h1>Audio <span className="amp">&amp;</span> Books</h1>
          </div>
          <div className="pane-actions">
            {currentUser.isAdmin ? (
              <button className="icon-button" aria-label="Rescan library" onClick={() => void refreshLibrary()}>
                <RefreshCcw size={16} />
              </button>
            ) : null}
            <div className="user-menu-wrap">
              <button
                className="icon-button"
                aria-label="Account menu"
                aria-expanded={userMenuOpen}
                onClick={() => setUserMenuOpen((open) => !open)}
              >
                <span className="user-avatar">{currentUser.username.slice(0, 1).toUpperCase()}</span>
              </button>
              {userMenuOpen ? (
                <div className="user-menu" role="menu">
                  <div className="user-menu-head">
                    <strong>{currentUser.username}</strong>
                    <span>{currentUser.isAdmin ? "Administrator" : "Reader"}</span>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setUserMenuOpen(false);
                      setProfileOpen(true);
                    }}
                  >
                    <ScrollText size={14} /> Reader's ledger
                  </button>
                  {currentUser.isAdmin ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        setUsersModalOpen(true);
                      }}
                    >
                      <UserCog size={14} /> Manage readers
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setUserMenuOpen(false);
                      void onLogout();
                    }}
                  >
                    <LogOut size={14} /> Sign out
                  </button>
                </div>
              ) : null}
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

          {currentUser.isAdmin ? (
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

            {libationStatus?.message ? <p>{libationStatus.message}</p> : null}

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
                onClick={() => void loadLibationBooks()}
                disabled={!libationStatus?.enabled || libationLoading || activeJob?.status === "running"}
              >
                <RefreshCcw size={13} />
                <span>{libationLoading ? "Loading" : "Load"}</span>
              </button>
              <button
                type="button"
                onClick={() => void startLibationSync()}
                disabled={!libationStatus?.enabled || libationLoading || activeJob?.status === "running"}
              >
                <CloudDownload size={13} />
                <span>Sync</span>
              </button>
              <button
                type="button"
                onClick={() => void startAllLiberation()}
                disabled={!libationStatus?.enabled || libationLoading || activeJob?.status === "running"}
              >
                <Download size={13} />
                <span>Download all</span>
              </button>
            </div>

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
              <div className="empty-state">No audiobooks found in the configured library folder.</div>
            ) : null}
            {!isLoading && !error && books.length > 0 && visibleBooks.length === 0 ? (
              <div className="empty-state">Nothing matches “{searchQuery}”.</div>
            ) : null}

            <div className={`book-list ${viewMode === "grid" ? "is-grid" : "is-list"}`}>
              {visibleBooks.map((book, index) => {
                const progressPercent = book.progress?.percentComplete ?? 0;
                return (
                  <button
                    key={book.id}
                    className={`book-row ${book.id === selectedBook?.id ? "active" : ""}`}
                    onClick={() => {
                      selectBook(book);
                      setLibraryOpen(false);
                    }}
                  >
                    {viewMode === "grid" || book.coverArtUrl ? (
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
                const metaParts = [
                  book.authors,
                  formatMinutes(book.lengthMinutes),
                  isLocal ? "In library" : book.bookStatus
                ].filter(Boolean);
                return (
                  <div key={book.asin} className={`audible-row ${isLocal ? "is-local" : ""}`}>
                    <div>
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
                          setSelectedBookId(book.localBookId);
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
                        aria-label={`${isLiberatedStatus(book.bookStatus) ? "Sync" : "Liberate"} ${book.title}`}
                        disabled={activeJob?.status === "running"}
                        onClick={() => void startLiberation(book)}
                      >
                        <CloudDownload size={14} />
                        <span>{isLiberatedStatus(book.bookStatus) ? "Sync" : "Liberate"}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </aside>

      <section className="player-pane" ref={playerPaneRef}>
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
            <div className="folio">
              <span>Vol. I <span className="dot">·</span> The Reading Room</span>
              <span>Folio {String(activeTrackIndex + 1).padStart(3, "0")} / {String(selectedBook.tracks.length).padStart(3, "0")}</span>
            </div>

            <div className="book-heading">
              <CoverArt book={selectedBook} size="large" />
              <div className="meta">
                <div className="heading-top">
                  <span className="eyebrow"><Bookmark size={13} /> Now Reading</span>
                  <div className="heading-actions">
                    {currentUser.isAdmin ? (
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
                    <a
                      className="download-btn"
                      href={bookDownloadUrl(selectedBook.id)}
                      download
                      aria-label={`Download ${selectedBook.title} as zip`}
                    >
                      <Download size={13} />
                      <span>Download</span>
                    </a>
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
              {selectedBook.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
              {selectedBook.chapters.length > 0 ? <span>{selectedBook.chapters.length} chapters</span> : null}
            </div>

            {selectedBook.description ? <p className="book-description">{selectedBook.description}</p> : null}

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
                    onSeekTo={(seconds) => seekBookPosition(seconds, true)}
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

                <div className="timeline">
                  {activeChapter && chapterSegments.length > 1 ? (
                    <>
                      <div className="chapter-now">
                        <span>{activeChapter.title}</span>
                        <span>
                          Chapter {activeChapter.chapterNumber} / {chapterSegments.length}
                        </span>
                      </div>
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

                          return (
                            <button
                              key={chapter.id}
                              className={`chapter-segment ${isActive ? "active" : ""} ${isComplete ? "complete" : ""}`}
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
                      <input
                        aria-label={`Playback position in ${activeChapter.title}`}
                        type="range"
                        min="0"
                        max={chapterDuration}
                        step="1"
                        value={Math.min(chapterElapsed, chapterDuration)}
                        onChange={(event) =>
                          seekBookPosition(activeChapter.startSeconds + Number(event.currentTarget.value))
                        }
                      />
                    </>
                  ) : (
                    <input
                      aria-label="Playback position"
                      type="range"
                      min="0"
                      max={Math.max(1, sliderMax)}
                      step="1"
                      value={Math.min(position, Math.max(1, sliderMax))}
                      onChange={(event) => seekTo(Number(event.currentTarget.value))}
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

                <div className="transport">
                  <button className="round-button secondary" aria-label="Skip back 15 seconds" onClick={() => seekBy(-15)}>
                    <RotateCcw size={22} strokeWidth={1.5} />
                    <small>15s</small>
                  </button>
                  <button className="round-button primary" aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlayback}>
                    {isPlaying ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
                  </button>
                  <button className="round-button secondary" aria-label="Skip forward 30 seconds" onClick={() => seekBy(30)}>
                    <RotateCw size={22} strokeWidth={1.5} />
                    <small>30s</small>
                  </button>
                </div>
              </>
            ) : (
              <div className="book-preview-actions">
                <span>
                  {playbackBook ? (
                    <>Still playing <em>{playbackBook.title}</em></>
                  ) : (
                    <>Begin a new reading</>
                  )}
                </span>
                <button
                  type="button"
                  className="round-button primary"
                  aria-label={`Play ${selectedBook.title}`}
                  onClick={() => selectedBook.tracks[0] && selectTrack(selectedBook.tracks[0])}
                >
                  <Play size={30} fill="currentColor" />
                </button>
              </div>
            )}

            <div className="controls-grid">
              <section className="control-section">
                <div className="section-label"><Gauge size={13} /> Cadence</div>
                <div className="segmented">
                  {SPEEDS.map((option) => (
                    <button
                      key={option}
                      className={speed === option ? "selected" : ""}
                      onClick={() => setSpeed(option)}
                    >
                      {option}×
                    </button>
                  ))}
                </div>
              </section>

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

              <section className="control-section">
                <label className="section-label" htmlFor="sleep"><Timer size={13} /> Nightfall</label>
                <select
                  id="sleep"
                  value={sleepMinutes}
                  onChange={(event) => setSleepMinutes(Number(event.currentTarget.value))}
                >
                  {SLEEP_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option === 0 ? "—" : `${option} minutes`}
                    </option>
                  ))}
                </select>
                {sleepRemaining > 0 ? <span className="sleep-copy">{formatTime(sleepRemaining)} remaining</span> : null}
              </section>
            </div>

            {selectedBook.chapters.length > 0 ? (
              <section className="track-list-section">
                <div className="track-list-header">
                  <span className="title-of-contents">Embedded Chapters</span>
                  <span className="section-label"><ListMusic size={13} /> {selectedBook.chapters.length} Markers</span>
                </div>
                <div className="track-list">
                  {selectedBook.chapters.map((chapter, index) => (
                    <button
                      key={chapter.id}
                      className={`track-row ${isViewingPlayingBook && chapter.trackId === currentTrack.id && Math.abs(chapter.startSeconds - bookPosition) < 2 ? "active" : ""}`}
                      onClick={() => jumpToChapter(chapter)}
                    >
                      <span className="num">{String(index + 1).padStart(2, "0")}</span>
                      <strong>{chapter.title}</strong>
                      <em>{formatTime(chapter.startSeconds)}</em>
                    </button>
                  ))}
                </div>
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
            <input
              aria-label="Mini player progress"
              type="range"
              min="0"
              max={activeChapter ? chapterDuration : Math.max(1, sliderMax)}
              step="1"
              value={activeChapter ? Math.min(chapterElapsed, chapterDuration) : Math.min(position, Math.max(1, sliderMax))}
              onChange={(event) => {
                const nextValue = Number(event.currentTarget.value);
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
            <button type="button" aria-label="Skip back 15 seconds" onClick={() => seekBy(-15)}>
              <RotateCcw size={17} />
            </button>
            <button type="button" className="mini-play" aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlayback}>
              {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
            <button type="button" aria-label="Skip forward 30 seconds" onClick={() => seekBy(30)}>
              <RotateCw size={17} />
            </button>
          </div>
        </aside>
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

      {profileOpen ? (
        <ProfilePage
          user={currentUser}
          onClose={() => setProfileOpen(false)}
          onOpenBook={(bookId) => {
            setSelectedBookId(bookId);
            setProfileOpen(false);
            setLibraryOpen(false);
          }}
        />
      ) : null}

      {usersModalOpen ? (
        <UserManagementModal
          currentUser={currentUser}
          onClose={() => setUsersModalOpen(false)}
        />
      ) : null}
    </main>
  );
}
