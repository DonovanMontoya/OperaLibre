import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCarLibrarySnapshot,
  CarLibraryAccess,
  carSessionIsWorthSaving,
  parseCarSessions,
  type CarPlaybackSession
} from "../src/carLibrary.ts";
import type { Book, Chapter, Track } from "../src/types.ts";

test("sign-out blocks a late library snapshot and the next account cannot publish the old scope", async () => {
  const access = new CarLibraryAccess();
  access.begin("server:alice");
  assert.equal(access.allows("server:alice"), true);
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => { complete = resolve; });
  const lateSnapshot = pending.then(() => access.allows("server:alice"));
  access.end();
  complete();
  assert.equal(await lateSnapshot, false);
  access.begin("server:bob");
  assert.equal(access.allows("server:alice"), false);
  assert.equal(access.allows("server:bob"), true);
  access.begin("other-server:bob");
  assert.equal(access.allows("server:bob"), false);
});

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-1",
    title: "Track One",
    fileName: "one.m4b",
    index: 0,
    durationSeconds: 600,
    streamUrl: "/api/books/book-1/tracks/track-1/stream",
    chapters: [],
    metadata: {} as Track["metadata"],
    ...overrides
  };
}

function chapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: "chapter-1",
    title: "Chapter One",
    trackId: "track-1",
    trackIndex: 0,
    startSeconds: 0,
    endSeconds: 300,
    source: "embedded",
    ...overrides
  };
}

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: "book-1",
    title: "A Book",
    author: "An Author",
    narrator: null,
    durationSeconds: 1200,
    trackCount: 2,
    coverArtUrl: "/api/books/book-1/cover",
    coverArtContentType: "image/jpeg",
    description: null,
    genres: [],
    tags: [],
    publishedDate: null,
    asin: null,
    readingFile: null,
    syncFile: null,
    chapters: [],
    metadata: {} as Book["metadata"],
    tracks: [track(), track({ id: "track-2", title: "Track Two", index: 1 })],
    progress: null,
    ...overrides
  };
}

const defaults = {
  scopePrefix: "server:user-1",
  playbackRate: 1.5,
  downloadedBookIds: new Set<string>(),
  bookGains: {},
  coverUrl: async () => null,
  resolveTrackUrl: async (_book: Book, candidate: Track) => `https://server${candidate.streamUrl}`,
  now: () => 1_700_000_000_000
};

test("a track's offset is where it starts in the whole book", async () => {
  const snapshot = await buildCarLibrarySnapshot({ ...defaults, books: [book()] });
  assert.deepEqual(
    snapshot.books[0].tracks.map((entry) => entry.bookOffsetSeconds),
    [0, 600]
  );
});

test("the snapshot carries the scope prefix and rate the car plays with", async () => {
  const snapshot = await buildCarLibrarySnapshot({ ...defaults, books: [book()] });
  assert.equal(snapshot.scopePrefix, "server:user-1");
  assert.equal(snapshot.playbackRate, 1.5);
  assert.equal(snapshot.updatedAt, 1_700_000_000_000);
});

test("a book with no playable file is left out rather than offered as a dead end", async () => {
  const snapshot = await buildCarLibrarySnapshot({
    ...defaults,
    books: [book(), book({ id: "book-2" })],
    resolveTrackUrl: async (candidate) => (candidate.id === "book-2" ? null : "https://server/stream")
  });
  assert.deepEqual(snapshot.books.map((entry) => entry.id), ["book-1"]);
});

test("a track that will not resolve is dropped without taking the book with it", async () => {
  const snapshot = await buildCarLibrarySnapshot({
    ...defaults,
    books: [book()],
    resolveTrackUrl: async (_candidate, entry) => (entry.id === "track-2" ? null : "https://server/one")
  });
  assert.deepEqual(snapshot.books[0].tracks.map((entry) => entry.id), ["track-1"]);
});

test("a resolver failure is a missing file, not a failed sync", async () => {
  const snapshot = await buildCarLibrarySnapshot({
    ...defaults,
    books: [book()],
    resolveTrackUrl: async (_candidate, entry) => {
      if (entry.id === "track-2") throw new Error("disk went away");
      return "https://server/one";
    }
  });
  assert.deepEqual(snapshot.books[0].tracks.map((entry) => entry.id), ["track-1"]);
});

test("downloaded and device books are marked so the car can show what plays offline", async () => {
  const snapshot = await buildCarLibrarySnapshot({
    ...defaults,
    books: [book(), book({ id: "book-2" }), book({ id: "book-3", source: "device" })],
    downloadedBookIds: new Set(["book-2"])
  });
  assert.deepEqual(
    snapshot.books.map((entry) => [entry.id, entry.downloaded]),
    [["book-1", false], ["book-2", true], ["book-3", true]]
  );
});

test("progress becomes the position and status the car resumes from", async () => {
  const snapshot = await buildCarLibrarySnapshot({
    ...defaults,
    books: [book({
      progress: {
        status: "inProgress",
        bookPositionSeconds: 742,
        durationSeconds: 1200,
        remainingSeconds: 458,
        percentComplete: 61,
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    })]
  });
  assert.equal(snapshot.books[0].positionSeconds, 742);
  assert.equal(snapshot.books[0].status, "inProgress");
});

test("a book that was never opened is not started", async () => {
  const snapshot = await buildCarLibrarySnapshot({ ...defaults, books: [book()] });
  assert.equal(snapshot.books[0].positionSeconds, 0);
  assert.equal(snapshot.books[0].status, "notStarted");
});

test("chapters keep their whole-book start and the track they belong to", async () => {
  const snapshot = await buildCarLibrarySnapshot({
    ...defaults,
    books: [book({
      chapters: [
        chapter(),
        chapter({ id: "chapter-2", title: "Chapter Two", startSeconds: 300, endSeconds: null }),
        chapter({ id: "chapter-3", title: "Chapter Three", trackId: "track-2", trackIndex: 1, startSeconds: 600, endSeconds: null })
      ]
    })]
  });
  assert.deepEqual(
    snapshot.books[0].chapters.map((entry) => [entry.startSeconds, entry.durationSeconds, entry.trackId]),
    [[0, 300, "track-1"], [300, 300, "track-1"], [600, 600, "track-2"]]
  );
});

test("a book's own gain travels with it, so the car plays it at the right level", async () => {
  const snapshot = await buildCarLibrarySnapshot({
    ...defaults,
    books: [book(), book({ id: "book-2" })],
    bookGains: { "book-1": 2.5 }
  });
  assert.equal(snapshot.books[0].volumeGain, 2.5);
  assert.equal(snapshot.books[1].volumeGain, undefined);
});

test("a local file wins over the stream, so a downloaded book plays out of range", async () => {
  const snapshot = await buildCarLibrarySnapshot({
    ...defaults,
    books: [book()],
    downloadedBookIds: new Set(["book-1"]),
    resolveTrackUrl: async () => "capacitor://localhost/_capacitor_file_/var/media/one.m4a"
  });
  assert.equal(snapshot.books[0].tracks[0].url, "capacitor://localhost/_capacitor_file_/var/media/one.m4a");
});

function session(overrides: Partial<CarPlaybackSession> = {}): CarPlaybackSession {
  return {
    bookId: "book-1",
    trackId: "track-1",
    positionSeconds: 120,
    bookPositionSeconds: 720,
    durationSeconds: 1200,
    updatedAt: 1_700_000_000_000,
    finished: false,
    intentionalRegression: false,
    ...overrides
  };
}

test("sessions survive the trip across the bridge", () => {
  assert.deepEqual(parseCarSessions(JSON.stringify([session()])), [session()]);
});

test("nothing the bridge could hand back loses a whole drive", () => {
  assert.deepEqual(parseCarSessions(""), []);
  assert.deepEqual(parseCarSessions("not json"), []);
  assert.deepEqual(parseCarSessions("{}"), []);
  assert.deepEqual(parseCarSessions(undefined), []);
  assert.deepEqual(parseCarSessions(JSON.stringify([null, 4, { bookId: "book-1" }])), []);
});

test("a session with no usable position is dropped rather than saved as one", () => {
  assert.deepEqual(parseCarSessions(JSON.stringify([session({ bookPositionSeconds: NaN })])), []);
  assert.deepEqual(parseCarSessions(JSON.stringify([{ ...session(), updatedAt: "soon" }])), []);
});

test("a drive that moved the book is worth saving", () => {
  assert.equal(
    carSessionIsWorthSaving(session({ bookPositionSeconds: 900 }), book({
      progress: {
        status: "inProgress",
        bookPositionSeconds: 720,
        durationSeconds: 1200,
        remainingSeconds: 480,
        percentComplete: 60,
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    })),
    true
  );
});

test("a drive that ended where the app already was writes nothing", () => {
  const known = book({
    progress: {
      status: "inProgress",
      bookPositionSeconds: 720.4,
      durationSeconds: 1200,
      remainingSeconds: 480,
      percentComplete: 60,
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  });
  assert.equal(carSessionIsWorthSaving(session({ bookPositionSeconds: 720 }), known), false);
});

test("a first listen in the car is worth saving against a book with no progress", () => {
  assert.equal(carSessionIsWorthSaving(session({ bookPositionSeconds: 60 }), book()), true);
  assert.equal(carSessionIsWorthSaving(session({ bookPositionSeconds: 0 }), book()), false);
});
