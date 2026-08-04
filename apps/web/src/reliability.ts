import type { BookProgress, Progress } from "./types";

const PROGRESS_CHECKPOINT_PREFIX = "operalibre.progressCheckpoint.v1";

export type ProgressStorage = Pick<Storage, "getItem" | "setItem">;

export function serverStorageKey(serverType: string, serverUrl: string): string {
  const value = `${serverType}:${serverUrl.toLowerCase()}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${serverType}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function progressTimestamp(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Offset from UTC in minutes, east positive — the negation of the sign
 * JavaScript uses. The server buckets listening activity by calendar day, and
 * without this an evening session west of UTC is filed under tomorrow.
 */
export function tzOffsetMinutes(now: Date = new Date()): number {
  const offset = -now.getTimezoneOffset();
  return Number.isFinite(offset) ? offset : 0;
}

function progressCheckpointKey(serverKey: string, userId: string, bookId: string): string {
  return [PROGRESS_CHECKPOINT_PREFIX, serverKey, userId, bookId]
    .map((part) => encodeURIComponent(part))
    .join(".");
}

function isProgress(value: unknown): value is Progress {
  if (!value || typeof value !== "object") return false;
  const progress = value as Partial<Progress>;
  return typeof progress.bookId === "string"
    && typeof progress.trackId === "string"
    && Number.isFinite(progress.positionSeconds)
    && Number.isFinite(progress.bookPositionSeconds)
    && (progress.durationSeconds === null || Number.isFinite(progress.durationSeconds))
    && typeof progress.updatedAt === "string"
    && (
      progress.finishedOverride === undefined
      || progress.finishedOverride === null
      || typeof progress.finishedOverride === "boolean"
    );
}

/**
 * A synchronous, media-independent playback checkpoint. IndexedDB and the
 * server remain the long-term copies; this small journal survives a page being
 * killed before either asynchronous write finishes.
 */
export function writeProgressCheckpoint(
  storage: ProgressStorage,
  serverKey: string,
  userId: string,
  progress: Progress
): void {
  try {
    storage.setItem(
      progressCheckpointKey(serverKey, userId, progress.bookId),
      JSON.stringify(progress)
    );
  } catch {
    // Storage can be unavailable in private browsing or under quota pressure.
  }
}

export function readProgressCheckpoint(
  storage: ProgressStorage,
  serverKey: string,
  userId: string,
  bookId: string
): Progress | null {
  try {
    const parsed = JSON.parse(
      storage.getItem(progressCheckpointKey(serverKey, userId, bookId)) ?? "null"
    ) as unknown;
    return isProgress(parsed) && parsed.bookId === bookId ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Which book the shelf should reopen on. Progress timestamps arrive as epoch
 * seconds as well as ISO strings, so they must go through progressTimestamp —
 * `new Date("1783894082")` is Invalid Date, and a NaN comparator leaves the
 * list in library order, handing the play bar whichever book sorts first.
 */
export function mostRecentlyListenedBookId(
  books: Array<{ id: string; progress?: { updatedAt: string } | null }>
): string | null {
  return books
    .filter((book) => book.progress?.updatedAt)
    .sort(
      (a, b) =>
        progressTimestamp(b.progress!.updatedAt) - progressTimestamp(a.progress!.updatedAt)
    )[0]?.id ?? null;
}

export function resolveBookId(
  books: Array<{ id: string; progress?: { updatedAt: string } | null }>,
  preferredId: string | null,
  fallbackId: string | null = null
): string | null {
  if (preferredId && books.some((book) => book.id === preferredId)) {
    return preferredId;
  }
  if (fallbackId && books.some((book) => book.id === fallbackId)) {
    return fallbackId;
  }
  return mostRecentlyListenedBookId(books) ?? books[0]?.id ?? null;
}

/**
 * Restore only a real, unfinished playback session. Library selection and
 * playback ownership are intentionally separate: a finished or removed book
 * may remain selected on the shelf without occupying the Reading tab.
 */
export function resolveActivePlaybackBookId(
  books: Array<{
    id: string;
    tracks: Array<unknown>;
    progress?: { status: string } | null;
  }>,
  preferredId: string | null
): string | null {
  if (!preferredId) return null;
  const book = books.find((candidate) => candidate.id === preferredId);
  return book && book.tracks.length > 0 && book.progress?.status !== "finished"
    ? book.id
    : null;
}

/**
 * The library listing embeds each book's server-side progress summary. It has
 * no track id, but resolveProgressLocation can map the whole-book offset, so
 * it works as a resume point when `/progress` itself cannot be fetched — the
 * exact state of a reinstalled app whose local copies were wiped.
 */
export function progressFromBookSummary(
  bookId: string,
  summary:
    | { status: string; bookPositionSeconds: number; durationSeconds: number | null; updatedAt: string }
    | null
    | undefined
): Progress | null {
  if (!summary || summary.status === "notStarted") return null;
  return {
    bookId,
    trackId: "",
    positionSeconds: 0,
    bookPositionSeconds: Math.max(0, summary.bookPositionSeconds),
    durationSeconds: summary.durationSeconds,
    updatedAt: summary.updatedAt
  };
}

export function freshestProgress(
  ...candidates: Array<Progress | null | undefined>
): Progress | null {
  return candidates
    .filter((value): value is Progress => !!value)
    .sort((a, b) => progressTimestamp(b.updatedAt) - progressTimestamp(a.updatedAt))[0] ?? null;
}

/** Mirrors the server's PROGRESS_NEAR_ZERO_SECONDS. */
export const NEAR_ZERO_PROGRESS_SECONDS = 60;
/** Mirrors the server's PROGRESS_BACKUP_REGRESSION_SECONDS. */
export const PROGRESS_RESET_GUARD_SECONDS = 300;

function isSameProgressRevision(left: Progress, right: Progress): boolean {
  return left.updatedAt === right.updatedAt
    && left.trackId === right.trackId
    && left.positionSeconds === right.positionSeconds
    && left.bookPositionSeconds === right.bookPositionSeconds;
}

/**
 * Reconcile an asynchronous save response with the synchronous checkpoint.
 * If the checkpoint still matches the request, the response is authoritative
 * even when its timestamp is older: the server may have rejected a stale or
 * regressive write, or capped a future-skewed device clock. A genuinely newer
 * local checkpoint still wins while the request is in flight.
 */
export function progressAfterSave(
  local: Progress | null,
  attempted: Progress,
  saved: Progress
): Progress {
  if (!local || isSameProgressRevision(local, attempted)) return saved;
  // A different synchronous checkpoint was created after this request was
  // queued. Request completion time is not mutation order, so even a newer
  // server-issued revision must not replace that later local position.
  return local;
}

/**
 * A local copy at the very start of the book that outranks substantial server
 * progress by timestamp alone is the signature of a device that once failed
 * to restore and then persisted near-zero. A listener who deliberately
 * started over synced that restart to the server too, so the two copies
 * agree and this never fires. Preferring the server's position here can only
 * discard a restart-to-zero — never real listening.
 */
export function isSuspectProgressReset(
  local: Progress | null | undefined,
  reference: Progress | null | undefined
): boolean {
  return (
    !!local &&
    !!reference &&
    local.bookPositionSeconds < NEAR_ZERO_PROGRESS_SECONDS &&
    reference.bookPositionSeconds - local.bookPositionSeconds > PROGRESS_RESET_GUARD_SECONDS
  );
}

/** Recover from a changed/missing track id using the durable whole-book offset. */
export function resolveProgressLocation(
  tracks: Array<{ id: string; durationSeconds: number | null }>,
  progress: Progress | null
): { trackId: string; positionSeconds: number } | null {
  if (!tracks.length) return null;
  if (!progress) return { trackId: tracks[0].id, positionSeconds: 0 };

  const savedTrack = tracks.find((track) => track.id === progress.trackId);
  if (savedTrack) {
    const upperBound = savedTrack.durationSeconds ?? progress.positionSeconds;
    return {
      trackId: savedTrack.id,
      positionSeconds: Math.max(0, Math.min(progress.positionSeconds, upperBound))
    };
  }

  const bookPosition = Math.max(0, progress.bookPositionSeconds);
  let offset = 0;
  for (const [index, track] of tracks.entries()) {
    const duration = Math.max(0, track.durationSeconds ?? 0);
    const isLast = index === tracks.length - 1;
    if (isLast || (duration > 0 && bookPosition < offset + duration)) {
      return {
        trackId: track.id,
        positionSeconds: Math.max(0, Math.min(bookPosition - offset, duration || bookPosition))
      };
    }
    offset += duration;
  }

  return { trackId: tracks[0].id, positionSeconds: 0 };
}

export function summarizeBookProgress(
  book: {
    durationSeconds: number | null;
    tracks: Array<{ durationSeconds: number | null }>;
  },
  progress: Progress | null
): BookProgress | null {
  if (!progress) return null;
  const allTrackDurationsKnown = book.tracks.length > 0
    && book.tracks.every(
      (track) => track.durationSeconds !== null && track.durationSeconds > 0
    );
  const trackDuration = allTrackDurationsKnown
    ? book.tracks.reduce((total, track) => total + track.durationSeconds!, 0)
    : null;
  // A partial sum is not a book duration. If even one track is unknown,
  // clamping to the known tracks can falsely finish a book mid-playback.
  const duration = book.durationSeconds !== null && book.durationSeconds > 0
    ? book.durationSeconds
    : trackDuration;
  const position = duration !== null
    ? Math.min(duration, Math.max(0, progress.bookPositionSeconds))
    : Math.max(0, progress.bookPositionSeconds);
  const remaining = duration !== null ? Math.max(0, duration - position) : null;
  const percent = duration !== null && duration > 0
    ? Math.min(100, Math.max(0, (position / duration) * 100))
    : null;
  const inferredFinished =
    duration !== null
    && duration > 0
    && (remaining! <= 30 || percent! >= 99.5);
  const status =
    progress.finishedOverride === true
      ? "finished"
      : progress.finishedOverride === false
        ? position > 0 ? "inProgress" : "notStarted"
        : inferredFinished
          ? "finished"
          : position > 0 ? "inProgress" : "notStarted";
  return {
    status,
    finishedOverride: progress.finishedOverride ?? null,
    bookPositionSeconds: position,
    durationSeconds: duration,
    remainingSeconds: remaining,
    percentComplete: percent,
    updatedAt: progress.updatedAt
  };
}

export function normalizedBookTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizedTrackName(value: string): string {
  return value
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function durationsMatch(left: number | null, right: number | null): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left === null || right === null) {
    return false;
  }
  const tolerance = Math.max(2, Math.max(left, right) * 0.005);
  return Math.abs(left - right) <= tolerance;
}

export function deviceBookMatchesServer(
  device: {
    title: string;
    trackCount: number;
    durationSeconds?: number | null;
    asin?: string | null;
    tracks?: Array<{ fileName: string; durationSeconds: number | null }>;
  },
  server: {
    title: string;
    trackCount: number;
    durationSeconds?: number | null;
    asin?: string | null;
    tracks?: Array<{ fileName: string; durationSeconds: number | null }>;
  }
): boolean {
  const deviceAsin = device.asin?.trim().toUpperCase();
  const serverAsin = server.asin?.trim().toUpperCase();
  if (deviceAsin && serverAsin) {
    return deviceAsin === serverAsin;
  }
  if (
    normalizedBookTitle(device.title) !== normalizedBookTitle(server.title)
    || device.trackCount !== server.trackCount
    || !durationsMatch(device.durationSeconds ?? null, server.durationSeconds ?? null)
  ) {
    return false;
  }
  if (
    !device.tracks
    || !server.tracks
    || device.tracks.length !== device.trackCount
    || server.tracks.length !== server.trackCount
  ) {
    return false;
  }
  return device.tracks.every((track, index) => {
    const serverTrack = server.tracks![index];
    return normalizedTrackName(track.fileName) === normalizedTrackName(serverTrack.fileName)
      && durationsMatch(track.durationSeconds, serverTrack.durationSeconds);
  });
}

export function splitRoundedHours(hours: number) {
  if (!Number.isFinite(hours) || hours <= 0) {
    return { whole: "0", minutes: 0 };
  }
  const totalMinutes = Math.round(hours * 60);
  return {
    whole: Math.floor(totalMinutes / 60).toString(),
    minutes: totalMinutes % 60
  };
}
