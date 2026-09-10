import { buildChapterSegments } from "./chapters.ts";
import type { Book, Track } from "./types.ts";

/** Stops late snapshot work from republishing a library after sign-out. */
export class CarLibraryAccess {
  private scope: string | null = null;

  begin(scope: string) { this.scope = scope; }
  end() { this.scope = null; }
  allows(scope: string) { return this.scope !== null && this.scope === scope; }
}

/**
 * The library as the car sees it, and the progress a drive leaves behind.
 *
 * The car screen cannot run the app: connecting to a car may launch the process
 * with a CarPlay scene and nothing else — no WebView, no session, no network.
 * So the app writes this snapshot to the native side whenever the library
 * changes, and the car reads it from disk.
 *
 * Progress travels the other way. The car deliberately writes nothing itself;
 * every guard against a bad position — the staleness check, the suspect-reset
 * rule, the retry before reconciling — lives in the app and the server, and a
 * second writer that skipped them is the exact failure those guards exist for.
 * A drive therefore leaves a session record behind, and the app saves it
 * through its usual path the next time it runs.
 */

export type CarLibraryTrack = {
  id: string;
  title: string;
  url: string;
  durationSeconds?: number;
  bookOffsetSeconds: number;
};

export type CarLibraryChapter = {
  title: string;
  startSeconds: number;
  durationSeconds: number;
  trackId?: string;
};

export type CarLibraryBook = {
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
};

export type CarLibrarySnapshot = {
  /** `serverStorageKey:userId` — the recovery scope key without its book. */
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
  /** The listener jumped rather than listened on; the server needs to be told. */
  intentionalRegression: boolean;
};

/** Tolerates anything the bridge hands back rather than losing a whole drive. */
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

/**
 * What the car should be told about the library.
 *
 * `resolveTrackUrl` is injected because a downloaded book plays from a file on
 * the device and a streamed one from the server with a media token, and only
 * the caller can tell which is which.
 */
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
    // A book with nothing playable would be a dead end on the car screen.
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
  const resolved = await Promise.all(
    book.tracks.map(async (track, index) => {
      const url = await options.resolveTrackUrl(book, track).catch(() => null);
      return url === null ? null : {
        id: track.id,
        title: track.title,
        url,
        ...(Number.isFinite(track.durationSeconds ?? NaN)
          ? { durationSeconds: track.durationSeconds as number }
          : {}),
        bookOffsetSeconds: trackOffsetSeconds(book, index)
      } satisfies CarLibraryTrack;
    })
  );
  const tracks = resolved.filter((track): track is CarLibraryTrack => track !== null);
  if (tracks.length === 0) return null;

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
    chapters
  };
}

/**
 * A track's offset into the whole book. The car needs it for the same reason
 * the player does: the position it stores is a whole-book one, and every track
 * is played from its own zero.
 */
function trackOffsetSeconds(book: Book, trackIndex: number) {
  return book.tracks
    .slice(0, Math.max(0, trackIndex))
    .reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
}

function durationFromTracks(book: Book) {
  const total = book.tracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
  return total > 0 ? total : null;
}

/**
 * Whether a car session is worth saving over what the app already has.
 *
 * A drive that ended where the book already was writes nothing: the position is
 * unchanged, and a redundant write is one more chance to get progress wrong.
 */
export function carSessionIsWorthSaving(
  session: CarPlaybackSession,
  book: Pick<Book, "progress">
): boolean {
  if (!Number.isFinite(session.bookPositionSeconds)) return false;
  const known = book.progress?.bookPositionSeconds ?? 0;
  return Math.abs(session.bookPositionSeconds - known) >= 1;
}
