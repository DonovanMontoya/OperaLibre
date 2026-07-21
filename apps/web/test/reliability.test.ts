import assert from "node:assert/strict";
import test from "node:test";
import {
  deviceBookMatchesServer,
  freshestProgress,
  progressFromBookSummary,
  progressTimestamp,
  readProgressCheckpoint,
  resolveBookId,
  resolveProgressLocation,
  serverStorageKey,
  writeProgressCheckpoint
} from "../src/reliability.ts";
import type { Progress } from "../src/types.ts";

function progress(overrides: Partial<Progress> = {}): Progress {
  return {
    bookId: "book-1",
    trackId: "track-1",
    positionSeconds: 12,
    bookPositionSeconds: 12,
    durationSeconds: 60,
    updatedAt: "2025-07-11T01:00:00.000Z",
    ...overrides
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
}

test("offline storage keys are isolated by server and type", () => {
  const first = serverStorageKey("operalibre", "http://books-a.local:4000");
  const second = serverStorageKey("operalibre", "http://books-b.local:4000");
  const jellyfin = serverStorageKey("jellyfin", "http://books-a.local:4000");
  assert.notEqual(first, second);
  assert.notEqual(first, jellyfin);
  assert.equal(first, serverStorageKey("operalibre", "HTTP://BOOKS-A.LOCAL:4000"));
});

test("legacy epoch and ISO progress timestamps compare consistently", () => {
  assert.equal(progressTimestamp("1752195600"), 1_752_195_600_000);
  assert.equal(progressTimestamp("2025-07-11T01:00:00Z"), 1_752_195_600_000);
  assert.equal(progressTimestamp("invalid"), 0);
});

test("the shelf reopens on the newest listen, not the first book in the library", () => {
  // Shelf order is alphabetical; the newest listen is deliberately last.
  const shelf = [
    { id: "game-of-thrones", progress: { updatedAt: "1783894082" } },
    { id: "dune", progress: null },
    { id: "the-odyssey", progress: { updatedAt: "1783999999" } }
  ];
  assert.equal(resolveBookId(shelf, null), "the-odyssey");
  // Mixed epoch/ISO stores must still order correctly against each other.
  assert.equal(
    resolveBookId(
      [
        { id: "game-of-thrones", progress: { updatedAt: "1783894082" } },
        { id: "the-odyssey", progress: { updatedAt: "2026-07-20T12:00:00Z" } }
      ],
      null
    ),
    "the-odyssey"
  );
  // A resolvable stored id always wins over the recency fallback.
  assert.equal(resolveBookId(shelf, "dune"), "dune");
  // An id from a book that has since left the library falls back, not away.
  assert.equal(resolveBookId(shelf, "deleted-book"), "the-odyssey");
  assert.equal(resolveBookId([], "deleted-book"), null);
  // With nothing listened to yet, the shelf's first book is the right answer.
  assert.equal(resolveBookId([{ id: "dune", progress: null }], null), "dune");
});

test("device books reconcile only with equivalent server books", () => {
  assert.equal(
    deviceBookMatchesServer(
      { title: "The Odyssey: An Audiobook", trackCount: 4 },
      { title: "the odyssey—an audiobook", trackCount: 4 }
    ),
    true
  );
  assert.equal(
    deviceBookMatchesServer(
      { title: "The Odyssey", trackCount: 1 },
      { title: "The Odyssey", trackCount: 12 }
    ),
    false
  );
});

test("playback checkpoints are durable and isolated by server, user, and book", () => {
  const storage = memoryStorage();
  const saved = progress();
  writeProgressCheckpoint(storage, "server-a", "reader-a", saved);

  assert.deepEqual(readProgressCheckpoint(storage, "server-a", "reader-a", "book-1"), saved);
  assert.equal(readProgressCheckpoint(storage, "server-b", "reader-a", "book-1"), null);
  assert.equal(readProgressCheckpoint(storage, "server-a", "reader-b", "book-1"), null);
  assert.equal(readProgressCheckpoint(storage, "server-a", "reader-a", "book-2"), null);
});

test("the freshest playback copy wins over stale server or device data", () => {
  const older = progress({ updatedAt: "2025-07-11T01:00:00.000Z", bookPositionSeconds: 12 });
  const newer = progress({ updatedAt: "2025-07-11T01:00:03.000Z", bookPositionSeconds: 15 });
  assert.equal(freshestProgress(older, null, newer)?.bookPositionSeconds, 15);
});

test("a native background checkpoint wins when the WebView was suspended", () => {
  const web = progress({ updatedAt: "2025-07-11T01:00:00.000Z", bookPositionSeconds: 12 });
  const native = progress({ updatedAt: "1752195605000", bookPositionSeconds: 95 });
  assert.equal(freshestProgress(web, native)?.bookPositionSeconds, 95);
});

test("whole-book position recovers progress when a saved track id changes", () => {
  const location = resolveProgressLocation(
    [
      { id: "new-track-1", durationSeconds: 30 },
      { id: "new-track-2", durationSeconds: 30 }
    ],
    progress({ trackId: "old-track-2", positionSeconds: 12, bookPositionSeconds: 42 })
  );
  assert.deepEqual(location, { trackId: "new-track-2", positionSeconds: 12 });
});

test("the library listing's progress summary works as a resume point", () => {
  const summary = {
    status: "inProgress",
    bookPositionSeconds: 42,
    durationSeconds: 60,
    updatedAt: "2025-07-11T01:00:00.000Z"
  };
  const fallback = progressFromBookSummary("book-1", summary);
  assert.equal(fallback?.bookPositionSeconds, 42);
  assert.equal(fallback?.updatedAt, summary.updatedAt);

  // The summary has no track id; the whole-book offset must map to a track.
  const location = resolveProgressLocation(
    [
      { id: "track-1", durationSeconds: 30 },
      { id: "track-2", durationSeconds: 30 }
    ],
    fallback
  );
  assert.deepEqual(location, { trackId: "track-2", positionSeconds: 12 });

  assert.equal(progressFromBookSummary("book-1", null), null);
  assert.equal(
    progressFromBookSummary("book-1", { ...summary, status: "notStarted" }),
    null
  );
});
