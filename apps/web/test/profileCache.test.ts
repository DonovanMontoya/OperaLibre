import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveDeviceProfileStats,
  profileStatsStorageKey,
  readCachedProfileStats,
  writeCachedProfileStats
} from "../src/profileCache.ts";
import type { Book, ProfileStats } from "../src/types.ts";

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const stats: ProfileStats = {
  totalHoursRead: 12.5,
  booksFinished: 3,
  totalTracksCompleted: 18,
  currentStreakDays: 2,
  longestStreakDays: 6,
  avgDailyMinutes: 31,
  lastListenedAt: "1788912000000",
  favoriteNarrator: "Robin Miles",
  favoriteGenre: "History",
  daysActive: 9,
  memberSince: "1780000000",
  streakCalendar: [{ date: "2026-09-08", minutes: 31 }],
  recentBooks: [{
    id: "book-1",
    title: "A Book",
    coverArtUrl: "/api/books/book-1/cover",
    hoursRead: 2.5,
    finished: false,
    updatedAt: "1788912000000"
  }],
  measuringSince: "2026-08-01"
};

test("profile snapshots are scoped to both server and reader", () => {
  const storage = new MemoryStorage();
  writeCachedProfileStats(storage, "server-a", "reader-1", stats, "2026-09-08T12:00:00Z");

  assert.deepEqual(readCachedProfileStats(storage, "server-a", "reader-1"), {
    cachedAt: "2026-09-08T12:00:00Z",
    stats
  });
  assert.equal(readCachedProfileStats(storage, "server-b", "reader-1"), null);
  assert.equal(readCachedProfileStats(storage, "server-a", "reader-2"), null);
  assert.equal(
    profileStatsStorageKey("server-a", "reader-1"),
    "server-a:profileStats:reader-1"
  );
});

test("invalid or unavailable cached data is ignored", () => {
  const storage = new MemoryStorage();
  storage.setItem(profileStatsStorageKey("server-a", "reader-1"), "{not-json");
  assert.equal(readCachedProfileStats(storage, "server-a", "reader-1"), null);

  const unavailable = {
    getItem() { throw new Error("unavailable"); },
    setItem() { throw new Error("unavailable"); }
  };
  assert.equal(readCachedProfileStats(unavailable, "server-a", "reader-1"), null);
  assert.doesNotThrow(() => writeCachedProfileStats(unavailable, "server-a", "reader-1", stats));
});

test("a device-only ledger derives positions without inventing server activity", () => {
  const books = [
    {
      id: "finished",
      title: "Finished",
      coverArtUrl: null,
      progress: {
        status: "finished" as const,
        bookPositionSeconds: 7200,
        updatedAt: "2026-09-08T12:00:00Z"
      }
    },
    {
      id: "reading",
      title: "Reading",
      coverArtUrl: "/cover",
      progress: {
        status: "inProgress" as const,
        bookPositionSeconds: 3600,
        updatedAt: "2026-09-08T13:00:00Z"
      }
    },
    { id: "new", title: "New", coverArtUrl: null, progress: null }
  ] as unknown as Book[];

  const derived = deriveDeviceProfileStats(books);
  assert.equal(derived.totalHoursRead, 3);
  assert.equal(derived.booksFinished, 1);
  assert.equal(derived.currentStreakDays, 0);
  assert.equal(derived.longestStreakDays, 0);
  assert.deepEqual(derived.recentBooks.map((book) => book.id), ["reading", "finished"]);
});

