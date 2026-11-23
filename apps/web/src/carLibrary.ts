import { buildChapterSegments } from "./chapters.ts";
import type { Book, Track } from "./types.ts";

export class CarLibraryAccess {
  private scope: string | null = null;

  begin(scope: string) { this.scope = scope; }
  end() { this.scope = null; }
  allows(scope: string) { return this.scope !== null && this.scope === scope; }
}


type CarLibraryTrack = {
  id: string;
  title: string;
  // Empty when this phone cannot play the track. The track stays in the
  // snapshot so the car stops before it instead of skipping ahead.
  url: string;
  durationSeconds?: number;
  bookOffsetSeconds: number;
};

type CarLibraryChapter = {
  title: string;
  startSeconds: number;
  durationSeconds: number;
  trackId?: string;
};

type CarLibraryBook = {
  id: string;
  title: string;
  author?: string;
  artworkUrl?: string;
  durationSeconds?: number;
  positionSeconds: number;
  status: "notStarted" | "inProgress" | "finished";
  downloaded: boolean;
  volumeGain?: number;
  tracks: CarLibraryTrack[];
  chapters: CarLibraryChapter[];
  serverRevision?: string;
};

export type CarLibrarySnapshot = {
  scopePrefix: string;
  playbackRate: number;
  updatedAt: number;
  books: CarLibraryBook[];
};

export type CarPlaybackSession = {
  bookId: string;
  trackId: string;
  positionSeconds: number;
  bookPositionSeconds: number;
  durationSeconds?: number;
  updatedAt: number;
  finished: boolean;
  intentionalRegression: boolean;
  /** The server revision native recorded the session against. */
  baseUpdatedAt?: string;
};

export function parseCarSessions(raw: unknown): CarPlaybackSession[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is CarPlaybackSession =>
    !!entry
    && typeof entry === "object"
    && typeof (entry as CarPlaybackSession).bookId === "string"
    && typeof (entry as CarPlaybackSession).trackId === "string"
    && Number.isFinite((entry as CarPlaybackSession).bookPositionSeconds)
    && Number.isFinite((entry as CarPlaybackSession).updatedAt));
}

export async function buildCarLibrarySnapshot(options: {
  scopePrefix: string;
  playbackRate: number;
  books: Book[];
  downloadedBookIds: ReadonlySet<string>;
  bookGains: Readonly<Record<string, number>>;
  coverUrl: (book: Book) => Promise<string | null>;
  resolveTrackUrl: (book: Book, track: Track) => Promise<string | null>;
  now?: () => number;
}): Promise<CarLibrarySnapshot> {
  const books = await Promise.all(
    options.books.map((book) => carBook(book, options))
  );
  return {
    scopePrefix: options.scopePrefix,
    playbackRate: options.playbackRate,
    updatedAt: (options.now ?? Date.now)(),
    books: books.filter((book): book is CarLibraryBook => book !== null)
  };
}

async function carBook(
  book: Book,
  options: {
    downloadedBookIds: ReadonlySet<string>;
    bookGains: Readonly<Record<string, number>>;
    coverUrl: (book: Book) => Promise<string | null>;
    resolveTrackUrl: (book: Book, track: Track) => Promise<string | null>;
  }
): Promise<CarLibraryBook | null> {
  const downloaded = options.downloadedBookIds.has(book.id) || book.source === "device";
  const tracks = await Promise.all(
    book.tracks.map(async (track, index) => {
      const url = await options.resolveTrackUrl(book, track).catch(() => null);
      return {
        id: track.id,
        title: track.title,
        url: url ?? "",
        ...(Number.isFinite(track.durationSeconds ?? NaN)
          ? { durationSeconds: track.durationSeconds as number }
          : {}),
        bookOffsetSeconds: trackOffsetSeconds(book, index)
      } satisfies CarLibraryTrack;
    })
  );
  if (!tracks.some((track) => track.url !== "")) return null;

  const durationSeconds = book.durationSeconds
    ?? book.progress?.durationSeconds
    ?? durationFromTracks(book);
  const chapters = buildChapterSegments(book.chapters, durationSeconds ?? 0).map((chapter) => ({
    title: chapter.title,
    startSeconds: chapter.startSeconds,
    durationSeconds: chapter.durationSeconds,
    trackId: chapter.trackId
  }));
  const status = book.progress?.status;
  // A summary built on the phone keeps its revision in serverUpdatedAt; one
  // from the server has none, and its updatedAt is the revision. A server book
  // listed without progress has none yet: the empty base lets the server take
  // a first save and refuse it once any other copy exists. A phone summary
  // without a revision leaves the server's state unknown.
  const summary = book.progress;
  const serverRevision = book.source === "device" ? undefined
    : !summary ? ""
    : "serverUpdatedAt" in summary ? summary.serverUpdatedAt ?? undefined : summary.updatedAt;
  const artworkUrl = await options.coverUrl(book).catch(() => null);
  return {
    id: book.id,
    title: book.title,
    ...(book.author ? { author: book.author } : {}),
    ...(artworkUrl ? { artworkUrl } : {}),
    ...(durationSeconds && durationSeconds > 0 ? { durationSeconds } : {}),
    positionSeconds: Math.max(0, book.progress?.bookPositionSeconds ?? 0),
    status: status === "inProgress" || status === "finished" ? status : "notStarted",
    downloaded,
    ...(Number.isFinite(options.bookGains[book.id] ?? NaN)
      ? { volumeGain: options.bookGains[book.id] }
      : {}),
    tracks,
    chapters,
    ...(serverRevision !== undefined ? { serverRevision } : {})
  };
}

function trackOffsetSeconds(book: Book, trackIndex: number) {
  return book.tracks
    .slice(0, Math.max(0, trackIndex))
    .reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
}

function durationFromTracks(book: Book) {
  const total = book.tracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
  return total > 0 ? total : null;
}

export function carSessionIsWorthSaving(
  session: CarPlaybackSession,
  book: Pick<Book, "progress">
): boolean {
  if (!Number.isFinite(session.bookPositionSeconds)) return false;
  const known = book.progress?.bookPositionSeconds ?? 0;
  return Math.abs(session.bookPositionSeconds - known) >= 1;
}
