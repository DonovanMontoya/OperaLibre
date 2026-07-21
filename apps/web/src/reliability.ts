import type { Progress } from "./types";

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
    && typeof progress.updatedAt === "string";
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

export function freshestProgress(
  ...candidates: Array<Progress | null | undefined>
): Progress | null {
  return candidates
    .filter((value): value is Progress => !!value)
    .sort((a, b) => progressTimestamp(b.updatedAt) - progressTimestamp(a.updatedAt))[0] ?? null;
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

export function normalizedBookTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function deviceBookMatchesServer(
  device: { title: string; trackCount: number },
  server: { title: string; trackCount: number }
): boolean {
  return normalizedBookTitle(device.title) === normalizedBookTitle(server.title)
    && device.trackCount === server.trackCount;
}
