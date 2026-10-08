import assert from "node:assert/strict";
import test from "node:test";
import {
  bookFacetValues,
  bookMatchesFacet,
  bookMatchesShelfDownload,
  bookMatchesShelfReading,
  bookReadingAvailability,
  bookMatchesShelfSearch,
  bookMatchesShelfStatus,
  compareShelfAddedAt,
  countActiveShelfFilters,
  countShelfFacet,
  EMPTY_SHELF_FILTERS,
  shelfFacetKey,
  shelfDownloadScanKey,
  shelfSearchWords,
  tagForShelfSort,
  toggleShelfFacet,
  updateShelfFacetCounts
} from "../src/shelfFilters.ts";
import type { ShelfFilters } from "../src/shelfFilters.ts";
import type { Book, BookProgress, BookTag } from "../src/types.ts";
import { getDemoBooks } from "../src/demo.ts";

type ShelfBook = Pick<Book, "title" | "author" | "narrator" | "metadata" | "genres" | "tags" | "progress">;

function book(overrides: Partial<ShelfBook> = {}): Book {
  return {
    title: "Elantris",
    author: "Brandon Sanderson",
    narrator: "Jack Garrett",
    metadata: { series: null, seriesPosition: null, publisher: null },
    genres: [],
    tags: [],
    progress: null,
    ...overrides
  } as unknown as Book;
}

function progress(status: BookProgress["status"]): BookProgress {
  return {
    status,
    bookPositionSeconds: 0,
    durationSeconds: 3600,
    remainingSeconds: 3600,
    percentComplete: 0,
    updatedAt: "2026-09-04T00:00:00Z"
  } as BookProgress;
}

function tag(name: string, position: string | null = null): BookTag {
  return { name, position };
}

test("spellings of the same genre collapse to one chip under the first one seen", () => {
  // Genres and tags are typed by hand on the metadata form, so casing and stray
  // whitespace are the normal case rather than the exception.
  const shelf = [
    book({ genres: ["Sci-Fi"] }),
    book({ genres: ["sci-fi "] }),
    book({ genres: ["SCI-FI"] })
  ];
  const options = countShelfFacet(shelf, "genres");
  assert.deepEqual(options, [{ key: "sci-fi", label: "Sci-Fi", count: 3 }]);
});

test("a book listing one genre twice only counts once toward it", () => {
  const options = countShelfFacet([book({ genres: ["Fantasy", "fantasy"] })], "genres");
  assert.deepEqual(options, [{ key: "fantasy", label: "Fantasy", count: 1 }]);
});

test("blank and whitespace-only values never become chips", () => {
  const shelf = [book({ genres: ["", "   ", "Fantasy"], tags: [tag(" "), tag("Cosmere")] })];
  assert.deepEqual(countShelfFacet(shelf, "genres").map((option) => option.key), ["fantasy"]);
  assert.deepEqual(countShelfFacet(shelf, "tags").map((option) => option.key), ["cosmere"]);
});

test("chips are ordered by how much of the shelf they cover, then alphabetically", () => {
  const shelf = [
    book({ genres: ["Fantasy", "Mystery"] }),
    book({ genres: ["Fantasy", "Adventure"] }),
    book({ genres: ["Fantasy"] })
  ];
  assert.deepEqual(
    countShelfFacet(shelf, "genres").map((option) => `${option.label}:${option.count}`),
    ["Fantasy:3", "Adventure:1", "Mystery:1"]
  );
});

test("a shelf cached by an older build has no tags field and simply offers no tag chips", () => {
  // Native offline caches predate tags; reading them must not throw.
  const cached = book();
  delete (cached as { tags?: unknown }).tags;
  assert.deepEqual(bookFacetValues(cached, "tags"), []);
  assert.deepEqual(countShelfFacet([cached], "tags"), []);
  assert.equal(bookMatchesFacet(cached, "tags", ["cosmere"]), false);
  assert.equal(bookMatchesShelfSearch(cached, "elantris"), true);
});

test("an empty group is not a filter, so every book still passes it", () => {
  assert.equal(bookMatchesFacet(book(), "genres", []), true);
  assert.equal(bookMatchesFacet(book({ genres: ["Fantasy"] }), "genres", []), true);
});

test("picking two chips in one group widens the shelf rather than narrowing it", () => {
  const fantasy = book({ genres: ["Fantasy"] });
  const mystery = book({ genres: ["Mystery"] });
  const romance = book({ genres: ["Romance"] });
  const selected = ["fantasy", "mystery"];
  assert.equal(bookMatchesFacet(fantasy, "genres", selected), true);
  assert.equal(bookMatchesFacet(mystery, "genres", selected), true);
  assert.equal(bookMatchesFacet(romance, "genres", selected), false);
});

test("a chip matches however the book happened to spell the value", () => {
  const shelf = book({ genres: [" Science Fiction "], tags: [tag("COSMERE", "1")] });
  assert.equal(bookMatchesFacet(shelf, "genres", [shelfFacetKey("science fiction")]), true);
  assert.equal(bookMatchesFacet(shelf, "tags", ["cosmere"]), true);
});

test("the status filter passes everything only while it is set to all", () => {
  const reading = book({ progress: progress("inProgress") });
  const done = book({ progress: progress("finished") });
  const untouched = book({ progress: null });

  assert.equal(bookMatchesShelfStatus(reading, "all"), true);
  assert.equal(bookMatchesShelfStatus(done, "all"), true);
  assert.equal(bookMatchesShelfStatus(done, "finished"), true);
  assert.equal(bookMatchesShelfStatus(reading, "finished"), false);
  // A book with no progress record at all is not started, not a fourth state.
  assert.equal(bookMatchesShelfStatus(untouched, "notStarted"), true);
});

test("the downloaded filter only narrows the shelf when selected", () => {
  assert.equal(bookMatchesShelfDownload(true, false), true);
  assert.equal(bookMatchesShelfDownload(false, false), true);
  assert.equal(bookMatchesShelfDownload(true, true), true);
  assert.equal(bookMatchesShelfDownload(false, true), false);
});

test("reading filters distinguish unsynced ebooks, synced EPUBs, and audio-only books", () => {
  const readingFile = { fileName: "Elantris.epub", extension: "epub" } as Book["readingFile"];
  const ebook = { readingFile, syncFile: null };
  const synced = { readingFile, syncFile: { source: "generated", outdated: true } as Book["syncFile"] };
  const sidecar = { ...synced, syncFile: { source: "sidecar" } as Book["syncFile"] };
  const audioOnly = { readingFile: null, syncFile: null };
  const legacy = {} as Pick<Book, "readingFile" | "syncFile">;
  assert.deepEqual([ebook, synced, sidecar, audioOnly, legacy].map((candidate) => bookReadingAvailability(candidate, true)),
    ["ebook", "followAlong", "followAlong", "none", "none"]);
  for (const candidate of [ebook, synced, sidecar, audioOnly, legacy]) {
    assert.equal(bookMatchesShelfReading(candidate, "all", true), true);
    assert.equal(bookMatchesShelfReading(candidate, "ebook", true), candidate === ebook);
    assert.equal(bookMatchesShelfReading(candidate, "followAlong", true), candidate === synced || candidate === sidecar);
  }
});

test("disabling sentence following moves saved maps into the ebook filter and re-enabling restores them", () => {
  const synced = {
    readingFile: { extension: "epub" } as Book["readingFile"],
    syncFile: { source: "generated" } as Book["syncFile"]
  };
  for (const enabled of [true, false, true]) {
    assert.equal(bookReadingAvailability(synced, enabled), enabled ? "followAlong" : "ebook");
    assert.equal(bookMatchesShelfReading(synced, "followAlong", enabled), enabled);
    assert.equal(bookMatchesShelfReading(synced, "ebook", enabled), !enabled);
    assert.equal(bookMatchesShelfReading(synced, "all", enabled), true);
  }
});

test("a sync file alone, an unknown source, or a non-EPUB companion does not promise follow along", () => {
  const syncFile = { source: "generated" } as Book["syncFile"];
  assert.equal(bookReadingAvailability({ readingFile: null, syncFile }, true), "none");
  for (const extension of ["pdf", "txt", "html"]) {
    assert.equal(bookReadingAvailability({ readingFile: { extension } as Book["readingFile"], syncFile }, true), "ebook");
  }
  const readingFile = { extension: "EPUB" } as Book["readingFile"];
  assert.equal(bookReadingAvailability({ readingFile, syncFile }, true), "followAlong");
  assert.equal(bookReadingAvailability({ readingFile, syncFile: { source: "unknown" } as Book["syncFile"] }, true), "ebook");
});

test("removing a merged imported copy invalidates the native download scan", () => {
  const downloaded = book() as Book;
  downloaded.id = "server-book";
  downloaded.deviceBookId = "device-book";
  downloaded.tracks = [{ localFilePath: "device-library/device-book/track.m4b" }] as Book["tracks"];

  const serverOnly = {
    ...downloaded,
    deviceBookId: undefined,
    tracks: downloaded.tracks.map((track) => ({ ...track, localFilePath: undefined }))
  };
  assert.notEqual(shelfDownloadScanKey([downloaded]), shelfDownloadScanKey([serverOnly]));

  const progressOnly = { ...downloaded, progress: progress("inProgress") };
  assert.equal(shelfDownloadScanKey([downloaded]), shelfDownloadScanKey([progressOnly]));
});

test("search reaches the tag and genre a book carries, not just its title", () => {
  const shelf = book({
    title: "Elantris",
    genres: ["Epic Fantasy"],
    tags: [tag("Cosmere", "1")],
    metadata: { series: "Elantris", seriesPosition: "1", publisher: null } as Book["metadata"]
  });
  assert.equal(bookMatchesShelfSearch(shelf, "cosmere"), true);
  assert.equal(bookMatchesShelfSearch(shelf, "epic"), true);
  assert.equal(bookMatchesShelfSearch(shelf, "sanderson"), true);
  assert.equal(bookMatchesShelfSearch(shelf, "garrett"), true);
  assert.equal(bookMatchesShelfSearch(shelf, "mistborn"), false);
});

test("search finds the demo's Alice using words from its author and title in either order", () => {
  const alice = getDemoBooks()[0];
  for (const query of ["Carroll Wonderland", "wonderland carroll", "  CARROLL\t\nWonderland  "]) {
    assert.equal(bookMatchesShelfSearch(alice, query), true, query);
    assert.equal(bookMatchesShelfSearch(alice, shelfSearchWords(query)), true, query);
  }
  assert.equal(bookMatchesShelfSearch(alice, "Carroll Wonderland missing"), false);
});

test("all search words can span title, author, narrator, series, tags and genres", () => {
  const novel = book({
    title: "The Final Empire",
    metadata: { series: "Mistborn", seriesPosition: "1", publisher: null } as Book["metadata"],
    genres: ["Epic Fantasy"],
    tags: [tag("Favorites"), tag("Cosmere", "1")]
  });
  const query = "empire sanderson garrett mistborn cosmere fantasy";
  assert.equal(bookMatchesShelfSearch(novel, query), true);
  assert.equal(bookMatchesShelfSearch(novel, `${query} mystery`), false);
});

test("existing phrase and partial-word searches still find their books", () => {
  const novel = book({ title: "The Final Empire", genres: ["Epic Fantasy"] });
  for (const query of ["final empire", "brandon sanderson", "jack garrett", "epic fantasy", "sand gar", "Final\t  Empire"]) {
    assert.equal(bookMatchesShelfSearch(novel, query), true, query);
  }
  assert.equal(bookMatchesShelfSearch(novel, "final-empire"), false);
});

test("Jellyfin and device book shapes search with null or partial metadata", () => {
  const jellyfin = book({
    title: "Alice’s Adventures in Wonderland",
    author: "Lewis Carroll",
    narrator: null,
    tags: [],
    genres: ["Classics"],
    metadata: { series: null } as Book["metadata"]
  });
  assert.equal(bookMatchesShelfSearch(jellyfin, "classics carroll wonderland"), true);
  assert.equal(bookMatchesShelfSearch(jellyfin, "carroll mcquillin"), false);

  const device = { ...jellyfin, source: "device" as const };
  // Older cached books can omit fields added by newer frontends.
  for (const key of ["metadata", "tags", "genres"] as const) Reflect.deleteProperty(device, key);
  assert.equal(bookMatchesShelfSearch(device, "Carroll Wonderland"), true);
  assert.equal(bookMatchesShelfSearch(device, "Carroll Classics"), false);

  const titleOnly = book({ author: null, narrator: null });
  assert.equal(bookMatchesShelfSearch(titleOnly, "ELANTRIS"), true);
  assert.equal(bookMatchesShelfSearch(titleOnly, "elantris sanderson"), false);
});

test("search words must match one book and facet counts use only matching books", () => {
  const alice = book({ title: "Wonderland", author: "Lewis Carroll", genres: ["Fantasy"], tags: [tag("Favorites")] });
  const other = book({ title: "Wonderland", author: "Another Author", genres: ["Mystery"], tags: [tag("Other")] });
  const authorOnly = book({ author: "Lewis Carroll", genres: ["Mystery"] });
  const shelf = [alice, other, authorOnly];
  const words = shelfSearchWords("Carroll Wonderland");
  const matches = shelf.filter((candidate) => bookMatchesShelfSearch(candidate, words));
  assert.deepEqual(matches, [alice]);
  assert.deepEqual(updateShelfFacetCounts(countShelfFacet(shelf, "genres"), matches, "genres"), [
    { key: "mystery", label: "Mystery", count: 0 },
    { key: "fantasy", label: "Fantasy", count: 1 }
  ]);
  assert.deepEqual(countShelfFacet(matches, "tags"), [{ key: "favorites", label: "Favorites", count: 1 }]);
});

test("an empty or whitespace-only query is not a filter", () => {
  for (const query of ["", " \t\n "]) {
    assert.equal(bookMatchesShelfSearch(book(), query), true);
    assert.equal(bookMatchesShelfSearch(book(), shelfSearchWords(query)), true);
  }
});

test("toggling a chip adds it, then takes it back off, without touching the other group", () => {
  const withGenre = toggleShelfFacet(EMPTY_SHELF_FILTERS, "genres", "fantasy");
  assert.deepEqual(withGenre.genres, ["fantasy"]);
  assert.deepEqual(withGenre.tags, []);
  assert.equal(withGenre.status, "all");
  assert.equal(withGenre.downloadedOnly, false);

  const withTag = toggleShelfFacet(withGenre, "tags", "cosmere");
  assert.deepEqual(withTag.genres, ["fantasy"]);
  assert.deepEqual(withTag.tags, ["cosmere"]);

  const withoutGenre = toggleShelfFacet(withTag, "genres", "fantasy");
  assert.deepEqual(withoutGenre.genres, []);
  assert.deepEqual(withoutGenre.tags, ["cosmere"]);
});

test("toggling leaves the filters it was given untouched", () => {
  // The panel holds these in React state and compares by identity.
  const before: ShelfFilters = {
    status: "finished",
    downloadedOnly: true,
    reading: "all",
    genres: ["fantasy"],
    tags: []
  };
  const after = toggleShelfFacet(before, "genres", "mystery");
  assert.deepEqual(before.genres, ["fantasy"]);
  assert.notEqual(after.genres, before.genres);
  assert.equal(after.status, "finished");
  assert.equal(after.downloadedOnly, true);
});

test("the badge counts every chip that is on, and nothing when none are", () => {
  assert.equal(countActiveShelfFilters(EMPTY_SHELF_FILTERS), 0);
  assert.equal(
    countActiveShelfFilters({ status: "finished", downloadedOnly: true, reading: "followAlong", genres: [], tags: [] }),
    3
  );
  assert.equal(
    countActiveShelfFilters({
      status: "inProgress",
      downloadedOnly: false,
      reading: "all",
      genres: ["fantasy", "mystery"],
      tags: ["cosmere"]
    }),
    4
  );
});

test("narrowing results keeps facet order, spelling and zero-count choices intact", () => {
  const fantasy = book({ genres: ["Fantasy", "Adventure"] });
  const mystery = book({ genres: ["Mystery"] });
  const options = countShelfFacet([fantasy, fantasy, mystery], "genres");
  assert.deepEqual(updateShelfFacetCounts(options, [mystery], "genres"), [
    { key: "adventure", label: "Adventure", count: 0 },
    { key: "fantasy", label: "Fantasy", count: 0 },
    { key: "mystery", label: "Mystery", count: 1 }
  ]);
  assert.equal(options[0].count, 2);
});

test("filtering to Cosmere uses its own book number even when it is the second tag", () => {
  const novel = book({ tags: [tag("Favorites", "20"), tag(" Cosmere ", "2")] });
  assert.deepEqual(tagForShelfSort(novel, ["cosmere"]), tag(" Cosmere ", "2"));
  assert.deepEqual(tagForShelfSort(novel, []), tag("Favorites", "20"));
  assert.equal(tagForShelfSort(book(), ["cosmere"]), undefined);
});

test("newest sorts legacy missing and invalid timestamps as epoch in either direction", () => {
  const dates = [undefined, "2026-09-16T12:00:00Z", null, "", "invalid", "1970-01-01T00:00:00Z", "2026-09-15T12:00:00Z"];
  const sorted = dates.map((addedAt, id) => ({ addedAt, id }))
    .sort((a, b) => compareShelfAddedAt(a.addedAt, b.addedAt) || a.id - b.id);
  assert.deepEqual(sorted.map(({ id }) => id), [1, 6, 0, 2, 3, 4, 5]);
  assert.deepEqual(sorted.reverse().map(({ id }) => id), [5, 4, 3, 2, 0, 6, 1]);
  assert.equal(compareShelfAddedAt(undefined, "1970-01-01T00:00:00Z"), 0);
});

test("newest compares mixed timestamp precision and timezone offsets chronologically", () => {
  const dates = ["2026-09-16T12:00:00Z", "2026-09-16T12:00:00.500Z", "2026-09-16T09:00:01-03:00"];
  assert.deepEqual([...dates].sort(compareShelfAddedAt), [dates[2], dates[1], dates[0]]);
  assert.equal(compareShelfAddedAt(dates[0], "2026-09-16T12:00:00.000Z"), 0);
});

test("overlapping tag selections use the first matching selection consistently", () => {
  const novel = book({ tags: [tag("Cosmere", "2"), tag("Favorites", "20")] });
  assert.deepEqual(tagForShelfSort(novel, ["weekend", "favorites", "cosmere"]), tag("Favorites", "20"));
});
