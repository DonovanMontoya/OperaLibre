import type { Book, ProfileStats } from "./types";

export type CachedProfileStats = {
  cachedAt: string;
  stats: ProfileStats;
};

type ProfileCacheStorage = Pick<Storage, "getItem" | "setItem">;

export function profileStatsStorageKey(serverScope: string, userId: string): string {
  return `${serverScope}:profileStats:${userId}`;
}

function isCachedProfileStats(value: unknown): value is CachedProfileStats {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { cachedAt?: unknown; stats?: Partial<ProfileStats> };
  return typeof candidate.cachedAt === "string"
    && !!candidate.stats
    && typeof candidate.stats === "object"
    && typeof candidate.stats.totalHoursRead === "number"
    && typeof candidate.stats.booksFinished === "number"
    && Array.isArray(candidate.stats.streakCalendar)
    && Array.isArray(candidate.stats.recentBooks);
}

export function readCachedProfileStats(
  storage: ProfileCacheStorage,
  serverScope: string,
  userId: string
): CachedProfileStats | null {
  try {
    const parsed = JSON.parse(storage.getItem(profileStatsStorageKey(serverScope, userId)) ?? "null") as unknown;
    return isCachedProfileStats(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCachedProfileStats(
  storage: ProfileCacheStorage,
  serverScope: string,
  userId: string,
  stats: ProfileStats,
  cachedAt = new Date().toISOString()
): CachedProfileStats {
  const snapshot = { cachedAt, stats };
  try {
    storage.setItem(profileStatsStorageKey(serverScope, userId), JSON.stringify(snapshot));
  } catch {
    // A full or unavailable localStorage must not stop the live ledger from rendering.
  }
  return snapshot;
}

/**
 * A server measures listening sessions and streaks; an offline-only device does
 * not. Build only the facts its saved book positions can actually support.
 */
export function deriveDeviceProfileStats(books: Book[]): ProfileStats {
  const status = (book: Book) => {
    const value = book.progress?.status;
    return value === "inProgress" || value === "finished" ? value : "notStarted";
  };
  const updatedAtMillis = (value: string | undefined) => {
    if (!value) return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const booksWithProgress = books
    .filter((book) => status(book) !== "notStarted")
    .sort((left, right) =>
      updatedAtMillis(right.progress?.updatedAt) - updatedAtMillis(left.progress?.updatedAt)
    );
  const totalPositionSeconds = booksWithProgress.reduce(
    (total, book) => total + Math.max(0, book.progress?.bookPositionSeconds ?? 0),
    0
  );

  return {
    totalHoursRead: totalPositionSeconds / 3600,
    booksFinished: books.filter((book) => status(book) === "finished").length,
    totalTracksCompleted: 0,
    currentStreakDays: 0,
    longestStreakDays: 0,
    avgDailyMinutes: 0,
    lastListenedAt: booksWithProgress[0]?.progress?.updatedAt ?? null,
    favoriteNarrator: null,
    favoriteGenre: null,
    daysActive: 0,
    memberSince: "",
    streakCalendar: [],
    recentBooks: booksWithProgress.slice(0, 8).map((book) => ({
      id: book.id,
      title: book.title,
      coverArtUrl: book.coverArtUrl,
      hoursRead: Math.max(0, book.progress?.bookPositionSeconds ?? 0) / 3600,
      finished: status(book) === "finished",
      updatedAt: book.progress?.updatedAt ?? ""
    })),
    measuringSince: null
  };
}
