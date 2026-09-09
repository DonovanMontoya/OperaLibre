import type { Book, ProfileStats, SharedProgress } from "./types";

export type Achievement = {
  id: string;
  title: string;
  description: string;
  category: "Milestones" | "Exploration" | "Rituals";
  current: number;
  target: number;
  unit: string;
  evidence?: { bookId: string; label: string };
};
export type ReadingRivalry = {
  id: string;
  title: string;
  detail: string;
  leading: boolean;
  bookId: string;
};
const key = (value: string) => value.trim().toLocaleLowerCase();
const positive = (value: number | null | undefined) =>
  Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;

/** Derived from the accessible server library; no stored awards or invented unlock dates. */
export function readingAchievements(
  books: Book[],
  stats: ProfileStats,
  includeDeviceBooks = false
): Achievement[] {
  const finished = books.filter(
    (book) => (includeDeviceBooks || book.source !== "device")
      && book.progress?.status === "finished"
  );
  const longest = [...finished].sort(
    (a, b) => positive(b.durationSeconds) - positive(a.durationSeconds)
  )[0];
  const maxHours = positive(longest?.durationSeconds) / 3600;
  const groups = (get: (book: Book) => string[]) => {
    const counts = new Map<
      string,
      { count: number; book: Book; label: string }
    >();
    for (const book of finished) {
      for (const label of new Set(
        get(book)
          .map((value) => value.trim())
          .filter(Boolean)
          .map(key)
      )) {
        const previous = counts.get(label);
        counts.set(label, { count: (previous?.count ?? 0) + 1, book, label });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  };
  const authors = groups((book) => (book.author ? [book.author] : []));
  const narrators = groups((book) => (book.narrator ? [book.narrator] : []));
  const genres = groups((book) => book.genres);
  const series = groups((book) =>
    book.metadata.series ? [book.metadata.series] : []
  );
  const result: Achievement[] = [];
  const add = (
    id: string,
    title: string,
    description: string,
    category: Achievement["category"],
    current: number,
    target: number,
    unit: string,
    book?: Book
  ) => {
    result.push({
      id,
      title,
      description,
      category,
      current: positive(current),
      target,
      unit,
      evidence: book ? { bookId: book.id, label: book.title } : undefined
    });
  };
  for (const [target, title] of [
    [1, "The first of many"],
    [10, "Shelf made"],
    [25, "Well read"],
    [100, "Living library"]
  ] as const) {
    add(
      `finished-${target}`,
      title,
      `Finish ${target === 1 ? "your first book" : `${target} books`}.`,
      "Milestones",
      stats.booksFinished,
      target,
      "books"
    );
  }
  for (const [target, title] of [
    [24, "A day in another world"],
    [48, "The long way home"],
    [72, "Epic endurance"]
  ] as const) {
    add(
      `epic-${target}`,
      title,
      `Finish a book at least ${target} hours long. Original runtime, at any playback speed.`,
      "Milestones",
      maxHours,
      target,
      "hours",
      longest
    );
  }
  add(
    "authors",
    "Literary passport",
    "Finish books by 5 different authors.",
    "Exploration",
    authors.length,
    5,
    "authors"
  );
  add(
    "genres",
    "Beyond your borders",
    "Finish books spanning 5 different genres.",
    "Exploration",
    genres.length,
    5,
    "genres"
  );
  add(
    "author-loyalty",
    "An old friend",
    "Finish 3 books by the same author.",
    "Exploration",
    authors[0]?.count ?? 0,
    3,
    "books",
    authors[0]?.book
  );
  add(
    "narrator-loyalty",
    "A familiar voice",
    "Finish 3 books with the same narrator credit.",
    "Exploration",
    narrators[0]?.count ?? 0,
    3,
    "books",
    narrators[0]?.book
  );
  add(
    "series",
    "Deep in the saga",
    "Finish 3 books in one series.",
    "Exploration",
    series[0]?.count ?? 0,
    3,
    "books",
    series[0]?.book
  );
  for (const [target, title] of [
    [7, "A week of worlds"],
    [30, "Part of the day"],
    [100, "Unbroken thread"]
  ] as const) {
    add(
      `streak-${target}`,
      title,
      `Listen on ${target} consecutive days. Uses your longest recorded streak.`,
      "Rituals",
      stats.longestStreakDays,
      target,
      "days"
    );
  }
  for (const [target, title] of [
    [24, "Time well spent"],
    [100, "Centurion"],
    [500, "A life in stories"]
  ] as const) {
    add(
      `listening-${target}`,
      title,
      `Log ${target} hours of measured listening.`,
      "Rituals",
      stats.totalHoursRead,
      target,
      "hours"
    );
  }
  return result;
}

function fraction(
  progress: Book["progress"] | SharedProgress | undefined
): number {
  if (progress?.status === "finished") return 1;
  if (progress?.status !== "inProgress") return 0;
  return Math.min(0.999, positive(progress.percentComplete) / 100);
}

/** Current standings only: snapshots cannot prove a historical overtake. */
export function readingRivalries(
  books: Book[],
  viewerId: string,
  sharing: boolean
): ReadingRivalry[] {
  if (!sharing) return [];
  const library = books.filter((book) => book.source !== "device");
  const rivalries: ReadingRivalry[] = [];
  const series = new Map<string, Book[]>();
  for (const book of library) {
    const name = book.metadata.series?.trim();
    if (name) series.set(key(name), [...(series.get(key(name)) ?? []), book]);
    const mine = fraction(book.progress);
    if (mine <= 0) continue;
    for (const reader of book.sharedProgress ?? []) {
      const theirs = fraction(reader);
      if (reader.userId === viewerId || theirs <= 0 || mine === theirs)
        continue;
      const leading = mine > theirs;
      rivalries.push({
        id: `book-${book.id}-${reader.userId}`,
        title: leading ? "A chapter ahead" : "The chase is on",
        detail: `${leading ? "Ahead of" : "Behind"} ${reader.username} in ${book.title}.`,
        leading,
        bookId: book.id
      });
    }
  }
  for (const [name, volumes] of series) {
    if (volumes.length < 2) continue;
    const mine = volumes.filter(
      (book) => book.progress?.status === "finished"
    ).length;
    const readers = new Map<string, { name: string; finished: number }>();
    for (const book of volumes)
      for (const reader of book.sharedProgress ?? []) {
        if (reader.userId === viewerId || reader.status === "notStarted")
          continue;
        const entry = readers.get(reader.userId) ?? {
          name: reader.username,
          finished: 0
        };
        if (reader.status === "finished") entry.finished++;
        readers.set(reader.userId, entry);
      }
    for (const [id, reader] of readers) {
      if (mine === reader.finished || mine === 0) continue;
      const leading = mine > reader.finished;
      rivalries.push({
        id: `series-${name}-${id}`,
        title: leading ? "Leading the expedition" : "Chasing the saga",
        detail: `${volumes[0].metadata.series}: ${mine} finished by you, ${reader.finished} by ${reader.name}.`,
        leading,
        bookId: volumes[0].id
      });
    }
  }
  return rivalries.sort(
    (a, b) => Number(b.leading) - Number(a.leading) || a.id.localeCompare(b.id)
  );
}
