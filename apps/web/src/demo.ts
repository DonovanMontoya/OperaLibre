import type { AuthUser, Book, MetadataSummary, ProfileStats, Progress } from "./types";
import { summarizeBookProgress } from "./reliability.ts";

const DEMO_MODE_STORAGE_KEY = "operalibre.demoMode";
const DEMO_PROGRESS_STORAGE_PREFIX = "operalibre.demoProgress";
const DEMO_MEDIA_PREFIX = "/demo/";

export const DEMO_USER: AuthUser = {
  id: "operalibre-on-device-demo",
  username: "Demo Reader",
  isAdmin: false,
  isOwner: false,
  canApproveLibationRequests: false,
  allowedBookIds: null,
  libationAccess: "approval",
  createdAt: "1735689600"
};

const metadata = (
  album: string,
  publisher: string,
  description: string,
  genres: string[]
): MetadataSummary => ({
  album,
  subtitle: null,
  publisher,
  publishedDate: "1865",
  description,
  language: "en",
  series: null,
  seriesPosition: null,
  genres,
  rawFields: []
});

const aliceTitle = "Alice’s Adventures in Wonderland";
const aliceDescription =
  "Down the Rabbit-Hole from Lewis Carroll’s Alice’s Adventures in Wonderland. " +
  "This demo pairs a two-minute excerpt read by Kristen McQuillin for LibriVox " +
  "with the full Project Gutenberg EPUB and a precomputed sentence timing map. " +
  "The audio and ebook are public domain in the USA; copyright status elsewhere can differ. The unmodified EPUB retains the Project Gutenberg license and credits.";
const aliceMetadata = metadata(aliceTitle, "LibriVox / Project Gutenberg", aliceDescription, ["Classics", "Fantasy"]);
const aliceReadingFile = {
  id: "demo-alice-epub",
  fileName: "Alice’s Adventures in Wonderland.epub",
  extension: "epub",
  contentType: "application/epub+zip",
  url: "/demo/alice/alice.epub"
};

const DEMO_BOOKS: Book[] = [
  {
    id: "demo-alice-wonderland",
    title: aliceTitle,
    author: "Lewis Carroll",
    narrator: "Kristen McQuillin",
    durationSeconds: 127.2,
    trackCount: 1,
    coverArtUrl: "/demo/alice/cover.svg",
    coverArtContentType: "image/svg+xml",
    description: aliceDescription,
    genres: ["Classics", "Fantasy"],
    tags: [],
    publishedDate: "1865",
    asin: null,
    addedAt: "2026-10-03T00:00:00.000Z",
    readingFile: aliceReadingFile,
    companions: [{ ...aliceReadingFile, kind: "book", sizeBytes: 189249 }],
    syncFile: { fileName: "alice.sync.json", source: "sidecar", url: "/demo/alice/alice.sync.json" },
    chapters: [
      { id: "demo-alice-c1", title: "Down the Rabbit-Hole", trackId: "demo-alice-t1", trackIndex: 0, startSeconds: 0, endSeconds: 127.2, source: "demo" }
    ],
    metadata: aliceMetadata,
    tracks: [
      {
        id: "demo-alice-t1",
        title: "Down the Rabbit-Hole — excerpt",
        fileName: "alice-demo.mp3",
        index: 0,
        durationSeconds: 127.2,
        streamUrl: "/demo/alice/alice-demo.mp3",
        chapters: [],
        metadata: aliceMetadata
      }
    ],
    progress: null
  }
];

const fallbackProgress = new Map<string, Progress>();

function storageAvailable() {
  return typeof window !== "undefined" && !!window.localStorage;
}

export function isDemoMode() {
  return storageAvailable() && window.localStorage.getItem(DEMO_MODE_STORAGE_KEY) === "true";
}

export function enterDemoMode() {
  if (storageAvailable()) window.localStorage.setItem(DEMO_MODE_STORAGE_KEY, "true");
}

export function exitDemoMode() {
  if (storageAvailable()) window.localStorage.removeItem(DEMO_MODE_STORAGE_KEY);
}

function progressKey(bookId: string) {
  return `${DEMO_PROGRESS_STORAGE_PREFIX}.${bookId}`;
}

export function getDemoProgress(bookId: string): Progress | null {
  if (storageAvailable()) {
    try {
      return JSON.parse(window.localStorage.getItem(progressKey(bookId)) ?? "null") as Progress | null;
    } catch {
      return null;
    }
  }
  return fallbackProgress.get(bookId) ?? null;
}

export function saveDemoProgress(
  bookId: string,
  progress: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">
    & Partial<Pick<Progress, "updatedAt" | "finishedOverride">>
): Progress {
  const existing = getDemoProgress(bookId);
  const saved: Progress = {
    bookId,
    trackId: progress.trackId,
    positionSeconds: progress.positionSeconds,
    bookPositionSeconds: progress.bookPositionSeconds,
    durationSeconds: progress.durationSeconds,
    updatedAt: progress.updatedAt ?? new Date().toISOString(),
    finishedOverride: progress.finishedOverride ?? existing?.finishedOverride ?? null
  };
  fallbackProgress.set(bookId, saved);
  if (storageAvailable()) window.localStorage.setItem(progressKey(bookId), JSON.stringify(saved));
  return saved;
}

export function setDemoBookCompletion(
  book: Book,
  finished: boolean,
  finalProgress?: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">
) {
  const existing = getDemoProgress(book.id);
  const firstTrack = book.tracks[0];
  if (!firstTrack) {
    throw new Error("This book has no playable tracks.");
  }
  const progress = saveDemoProgress(book.id, {
    trackId: finalProgress?.trackId ?? existing?.trackId ?? firstTrack.id,
    positionSeconds: finalProgress?.positionSeconds ?? existing?.positionSeconds ?? 0,
    bookPositionSeconds: finalProgress?.bookPositionSeconds ?? existing?.bookPositionSeconds ?? 0,
    durationSeconds: finalProgress?.durationSeconds ?? existing?.durationSeconds ?? firstTrack.durationSeconds,
    updatedAt: finalProgress ? new Date().toISOString() : existing?.updatedAt,
    finishedOverride: finished
  });
  return summarizeBookProgress(book, progress)!;
}

export function getDemoBooks(): Book[] {
  return DEMO_BOOKS.map((book) => ({
    ...book,
    metadata: { ...book.metadata, genres: [...book.metadata.genres], rawFields: [] },
    genres: [...book.genres],
    chapters: book.chapters.map((chapter) => ({ ...chapter })),
    tracks: book.tracks.map((track) => ({
      ...track,
      chapters: track.chapters.map((chapter) => ({ ...chapter })),
      metadata: { ...track.metadata, genres: [...track.metadata.genres], rawFields: [] }
    })),
    progress: summarizeBookProgress(book, getDemoProgress(book.id))
  }));
}

export function isDemoMediaPath(path: string) {
  return path.startsWith(DEMO_MEDIA_PREFIX);
}

export function demoMediaUrl(path: string): string {
  // Resolve against the bundled frontend, including native and nested web installs.
  const relativePath = path.replace(/^\//, "");
  return typeof document === "undefined" ? `./${relativePath}` : new URL(relativePath, document.baseURI).href;
}

export function getDemoProfileStats(): ProfileStats {
  const books = getDemoBooks();
  const today = new Date();
  // Eight whole weeks ending with the current one, starting on a Monday, to
  // match the real endpoint's grid and the client's weekday label column.
  const mondayOffset = (today.getDay() + 6) % 7;
  const streakCalendar = Array.from({ length: 56 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - mondayOffset - 49 + index);
    return { date: date.toISOString().slice(0, 10), minutes: index > 48 && index % 2 === 0 ? 12 : 0 };
  });
  // Measured listening, matching the real endpoint: the sum of the calendar,
  // not how far into each book the demo reader has got.
  const measuredMinutes = streakCalendar.reduce((total, day) => total + day.minutes, 0);
  const firstMeasuredDay = streakCalendar.find((day) => day.minutes > 0)?.date ?? null;
  return {
    totalHoursRead: measuredMinutes / 60,
    booksFinished: books.filter((book) => book.progress?.status === "finished").length,
    totalTracksCompleted: 0,
    currentStreakDays: 1,
    longestStreakDays: 3,
    avgDailyMinutes: 12,
    lastListenedAt: String(Math.floor(Date.now() / 1000)),
    favoriteNarrator: "Kristen McQuillin",
    favoriteGenre: "Classics",
    daysActive: 4,
    memberSince: DEMO_USER.createdAt,
    measuringSince: firstMeasuredDay,
    streakCalendar,
    recentBooks: books.map((book) => ({
      id: book.id,
      title: book.title,
      coverArtUrl: book.coverArtUrl,
      hoursRead: (book.progress?.bookPositionSeconds ?? 0) / 3600,
      finished: book.progress?.status === "finished",
      updatedAt: book.progress?.updatedAt ?? String(Math.floor(Date.now() / 1000))
    }))
  };
}
