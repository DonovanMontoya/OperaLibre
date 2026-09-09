import assert from "node:assert/strict";
import test from "node:test";
import {
  readingAchievements,
  readingRivalries
} from "../src/readingAchievements.ts";
import type { Book, ProfileStats } from "../src/types.ts";
const stats = {
  booksFinished: 0,
  longestStreakDays: 0,
  totalHoursRead: 0
} as ProfileStats;
const book = (id: string, patch: Partial<Book> = {}): Book =>
  ({
    id,
    title: id,
    author: null,
    narrator: null,
    genres: [],
    metadata: {},
    progress: null,
    ...patch
  }) as Book;
const progress = (status: string, percentComplete: number | null = null) =>
  ({ status, percentComplete }) as Book["progress"];
const reader = (
  status: "inProgress" | "finished",
  percentComplete: number | null = null
) => ({
  userId: "friend",
  username: "Sam",
  status,
  percentComplete,
  updatedAt: "0"
});

test("epics require finished status and use runtime, not position or measured listening", () => {
  const books = [
    book("long", {
      durationSeconds: 72 * 3600,
      progress: progress("inProgress", 99)
    }),
    book("done", {
      durationSeconds: 48 * 3600,
      progress: progress("finished", 0)
    })
  ];
  const awards = readingAchievements(books, stats);
  assert.equal(awards.find((a) => a.id === "epic-48")?.current, 48);
  assert.equal(
    awards.find((a) => a.id === "epic-72")?.evidence?.bookId,
    "done"
  );
  assert.equal(awards.find((a) => a.id === "listening-24")?.current, 0);
});
test("completion milestones follow current eligible book progress", () => {
  const books = [
    book("server", { progress: progress("finished") }),
    book("local", { source: "device", progress: progress("finished") })
  ];
  const staleStats = { ...stats, booksFinished: 0 };
  assert.equal(
    readingAchievements(books, staleStats).find((a) => a.id === "finished-1")?.current,
    1
  );
  assert.equal(
    readingAchievements(books, staleStats, true).find((a) => a.id === "finished-1")?.current,
    2
  );
});
test("metadata normalizes case, ignores blanks and duplicate genres, excludes device books", () => {
  const books = [
    book("one", {
      author: " Writer ",
      genres: ["Fantasy", "fantasy", " "],
      progress: progress("finished")
    }),
    book("two", {
      author: "writer",
      genres: ["Fantasy"],
      progress: progress("finished")
    }),
    book("local", {
      source: "device",
      author: "Other",
      durationSeconds: 1000000,
      progress: progress("finished")
    })
  ];
  const awards = readingAchievements(books, stats);
  assert.equal(awards.find((a) => a.id === "authors")?.current, 1);
  assert.equal(awards.find((a) => a.id === "author-loyalty")?.current, 2);
  assert.equal(awards.find((a) => a.id === "genres")?.current, 1);
  assert.equal(awards.find((a) => a.id === "epic-24")?.current, 0);
  const deviceAwards = readingAchievements(books, stats, true);
  assert.equal(deviceAwards.find((a) => a.id === "authors")?.current, 2);
  assert.ok((deviceAwards.find((a) => a.id === "epic-72")?.current ?? 0) > 72);
});
test("book standings respect privacy, omit ties, self, and unknown positions", () => {
  const books = [
    book("one", {
      progress: progress("inProgress", 60),
      sharedProgress: [reader("inProgress", 40)]
    })
  ];
  assert.equal(readingRivalries(books, "me", false).length, 0);
  assert.equal(readingRivalries(books, "friend", true).length, 0);
  assert.equal(readingRivalries(books, "me", true)[0].leading, true);
  books[0].sharedProgress = [reader("inProgress", 60)];
  assert.equal(readingRivalries(books, "me", true).length, 0);
  books[0].sharedProgress = [reader("inProgress")];
  assert.equal(readingRivalries(books, "me", true).length, 0);
});
test("series standings compare finished counts, not series position or unequal runtimes", () => {
  const books = [
    book("one", {
      metadata: { series: "Saga" } as Book["metadata"],
      progress: progress("finished"),
      sharedProgress: [reader("inProgress", 90)]
    }),
    book("two", {
      metadata: { series: " saga " } as Book["metadata"],
      sharedProgress: [reader("inProgress", 80)]
    })
  ];
  const standing = readingRivalries(books, "me", true).find((a) =>
    a.id.startsWith("series-")
  );
  assert.equal(standing?.leading, true);
  assert.match(standing!.detail, /1 finished by you, 0 by Sam/);
});
test("empty libraries and invalid durations never create phantom progress", () => {
  assert.equal(
    readingAchievements([], stats).filter((a) => a.current >= a.target).length,
    0
  );
  const awards = readingAchievements(
    [book("bad", { durationSeconds: NaN, progress: progress("finished") })],
    stats
  );
  assert.equal(awards.find((a) => a.id === "epic-24")?.current, 0);
});
