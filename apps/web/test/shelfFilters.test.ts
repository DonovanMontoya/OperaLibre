import assert from "node:assert/strict";
import test from "node:test";
import {
  bookFacetValues,
  bookMatchesFacet,
  bookMatchesShelfDownload,
  bookMatchesShelfSearch,
  bookMatchesShelfStatus,
  countActiveShelfFilters,
  countShelfFacet,
  EMPTY_SHELF_FILTERS,
  shelfFacetKey,
  shelfDownloadScanKey,
  tagForShelfSort,
  toggleShelfFacet,
  updateShelfFacetCounts
} from "../src/shelfFilters.ts";
import type { ShelfFilters } from "../src/shelfFilters.ts";
import type { Book, BookProgress, BookTag } from "../src/types.ts";

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

test("an empty query is not a filter", () => {
  assert.equal(bookMatchesShelfSearch(book(), ""), true);
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
    countActiveShelfFilters({ status: "finished", downloadedOnly: true, genres: [], tags: [] }),
    2
  );
  assert.equal(
    countActiveShelfFilters({
      status: "inProgress",
      downloadedOnly: false,
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

test("overlapping tag selections use the first matching selection consistently", () => {
  const novel = book({ tags: [tag("Cosmere", "2"), tag("Favorites", "20")] });
  assert.deepEqual(tagForShelfSort(novel, ["weekend", "favorites", "cosmere"]), tag("Favorites", "20"));
});
