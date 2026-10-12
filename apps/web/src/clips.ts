/** A stretch of a book a listener saved, in whole-book seconds. */
export type Clip = {
  id: string;
  bookId: string;
  startSeconds: number;
  endSeconds: number;
  title: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  /** Saved on this device and still waiting to reach the server. */
  pending?: boolean;
  /** A queued deletion, including a save whose response was lost. */
  deleted?: boolean;
};

export type ClipRange = { startSeconds: number; endSeconds: number };

/**
 * A new clip reaches back further than it reaches forward: the moment worth
 * keeping has usually just been heard, and the few seconds after it are there
 * so a sentence is not cut off. Both ends can be trimmed afterwards.
 */
export const CLIP_LEAD_SECONDS = 30;
export const CLIP_TAIL_SECONDS = 10;
/** The server's bounds, mirrored so a trim never offers a range it refuses. */
export const CLIP_MIN_SECONDS = 1;
export const CLIP_MAX_SECONDS = 300;

/** The range saved for a tap at `position`, or null when no audio surrounds it. */
export function clipAround(position: number, bookDuration: number): ClipRange | null {
  if (!Number.isFinite(position)) return null;
  const startSeconds = Math.max(0, position - CLIP_LEAD_SECONDS);
  const reach = position + CLIP_TAIL_SECONDS;
  const endSeconds = bookDuration > 0 ? Math.min(bookDuration, reach) : reach;
  return endSeconds - startSeconds >= CLIP_MIN_SECONDS ? { startSeconds, endSeconds } : null;
}

/**
 * Trimmed clips sit on eighths of a second. Those add and subtract exactly, so
 * a clip taken to a length bound is not refused over a rounding error.
 */
const TRIM_GRID = 8;

/** Move a whole clip to start at `startSeconds`, keeping its length and staying inside the book. */
export function slideClip(range: ClipRange, startSeconds: number, bookDuration: number): ClipRange {
  const length = range.endSeconds - range.startSeconds;
  const latest = bookDuration > 0 ? Math.max(0, Math.floor((bookDuration - length) * TRIM_GRID) / TRIM_GRID) : Infinity;
  const start = Math.min(latest, Math.max(0, Math.round(startSeconds * TRIM_GRID) / TRIM_GRID));
  return { startSeconds: start, endSeconds: start + length };
}

/**
 * Change how long a clip runs from its start, within the length bounds. A clip
 * already at the end of the book grows backwards instead.
 */
export function resizeClip(range: ClipRange, lengthSeconds: number, bookDuration: number): ClipRange {
  const longest = Math.min(CLIP_MAX_SECONDS, bookDuration > 0 ? Math.floor(bookDuration * TRIM_GRID) / TRIM_GRID : Infinity);
  const length = Math.min(longest, Math.max(CLIP_MIN_SECONDS, Math.round(lengthSeconds * TRIM_GRID) / TRIM_GRID));
  return slideClip({ startSeconds: 0, endSeconds: length }, range.startSeconds, bookDuration);
}

/** An id the server accepts, chosen here so a retried save lands once. */
export function newClipId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function pendingClipStorageKey(serverKey: string, userId: string): string {
  return `operalibre.pendingClips:${serverKey}:${userId}`;
}

type ClipStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isClip(value: unknown): value is Clip {
  if (!value || typeof value !== "object") return false;
  const clip = value as Record<string, unknown>;
  return typeof clip.id === "string"
    && typeof clip.bookId === "string"
    && typeof clip.startSeconds === "number"
    && typeof clip.endSeconds === "number";
}

/** Clips saved while the server was out of reach, oldest first. */
export function readPendingClips(storage: ClipStorage, key: string): Clip[] {
  try {
    const stored: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    return Array.isArray(stored) ? stored.filter(isClip).map((clip) => ({ ...clip, pending: true })) : [];
  } catch {
    return [];
  }
}

export function writePendingClips(storage: ClipStorage, key: string, clips: readonly Clip[]): void {
  try {
    if (clips.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(clips));
  } catch {
    // A full or unavailable store leaves the clip in memory for this session.
  }
}

/**
 * One book's clips in listening order: what the server holds, plus what this
 * device has not delivered yet. A clip the server already has wins over its
 * pending copy, which is a save whose reply was lost.
 */
export function clipsForBook(saved: readonly Clip[], pending: readonly Clip[], bookId: string): Clip[] {
  const deleted = new Set(pending.filter((clip) => clip.deleted).map((clip) => clip.id));
  const delivered = new Set(saved.map((clip) => clip.id));
  return [
    ...saved.filter((clip) => clip.bookId === bookId && !deleted.has(clip.id)),
    ...pending.filter((clip) => clip.bookId === bookId && !clip.deleted && !delivered.has(clip.id))
  ].sort((left, right) => left.startSeconds - right.startSeconds || left.createdAt.localeCompare(right.createdAt));
}

/** A file name for a shared clip that reads sensibly in a message thread. */
export function clipFileName(bookTitle: string, clip: Pick<Clip, "title" | "startSeconds">): string {
  const total = Math.max(0, Math.floor(clip.startSeconds));
  const moment = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
  const name = `${bookTitle} - ${clip.title ?? moment}`
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96)
    .replace(/^[-. ]+|[-. ]+$/g, "");
  return `${name || "clip"}.m4a`;
}
