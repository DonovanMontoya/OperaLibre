import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLIP_MAX_SECONDS,
  clipAround,
  clipFileName,
  clipsForBook,
  newClipId,
  pendingClipStorageKey,
  readPendingClips,
  resizeClip,
  slideClip,
  writePendingClips,
  type Clip
} from "../src/clips.ts";

function clip(id: string, bookId: string, startSeconds: number, fields: Partial<Clip> = {}): Clip {
  return {
    id,
    bookId,
    startSeconds,
    endSeconds: startSeconds + 40,
    title: null,
    note: null,
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
    ...fields
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };
}

test("a new clip keeps the last thirty seconds and the next ten", () => {
  assert.deepEqual(clipAround(600, 3600), { startSeconds: 570, endSeconds: 610 });
});

test("a new clip stops at the edges of the book", () => {
  assert.deepEqual(clipAround(12, 3600), { startSeconds: 0, endSeconds: 22 });
  assert.deepEqual(clipAround(3596, 3600), { startSeconds: 3566, endSeconds: 3600 });
  // A book whose length is unknown cannot bound the end.
  assert.deepEqual(clipAround(100, 0), { startSeconds: 70, endSeconds: 110 });
  assert.equal(clipAround(Number.NaN, 3600), null);
});

test("sliding a clip keeps its length and stays inside the book", () => {
  const range = { startSeconds: 100, endSeconds: 140 };
  assert.deepEqual(slideClip(range, 112.5, 3600), { startSeconds: 112.5, endSeconds: 152.5 });
  assert.deepEqual(slideClip(range, -20, 3600), { startSeconds: 0, endSeconds: 40 });
  assert.deepEqual(slideClip(range, 5000, 3600), { startSeconds: 3560, endSeconds: 3600 });
  // A book whose length is unknown cannot bound the end.
  assert.deepEqual(slideClip(range, 5000, 0), { startSeconds: 5000, endSeconds: 5040 });
});

test("resizing a clip keeps its start, within one second and five minutes", () => {
  const range = { startSeconds: 100, endSeconds: 140 };
  assert.deepEqual(resizeClip(range, 25, 3600), { startSeconds: 100, endSeconds: 125 });
  assert.deepEqual(resizeClip(range, 0, 3600), { startSeconds: 100, endSeconds: 101 });
  assert.deepEqual(resizeClip(range, 900, 3600), { startSeconds: 100, endSeconds: 400 });
  // At the end of the book the clip grows backwards.
  assert.deepEqual(resizeClip({ startSeconds: 3580, endSeconds: 3600 }, 60, 3600), { startSeconds: 3540, endSeconds: 3600 });
  assert.deepEqual(resizeClip({ startSeconds: 5, endSeconds: 20 }, 300, 30), { startSeconds: 0, endSeconds: 30 });
});

test("a clip taken to a length bound is never a rounding error past it", () => {
  for (const start of [70.1, 1234.567, 0.3, 9999.99]) {
    const longest = resizeClip({ startSeconds: start, endSeconds: start + 40 }, 300, 0);
    assert.equal(longest.endSeconds - longest.startSeconds, 300);
    const shortest = resizeClip(longest, 1, 0);
    assert.equal(shortest.endSeconds - shortest.startSeconds, 1);
  }
});

test("trimming stays inside a book with a fractional duration", () => {
  const duration = 41.037;
  const range = clipAround(35.1, duration)!;
  const moved = slideClip(range, duration, duration);
  assert.ok(moved.startSeconds >= 0);
  assert.ok(moved.endSeconds <= duration);
  assert.equal(moved.endSeconds - moved.startSeconds, range.endSeconds - range.startSeconds);

  const expanded = resizeClip(moved, CLIP_MAX_SECONDS, duration);
  assert.equal(expanded.startSeconds, 0);
  assert.ok(expanded.endSeconds <= duration);
  assert.ok(duration - expanded.endSeconds < 0.125);
  const shortened = resizeClip(expanded, 1, duration);
  assert.equal(shortened.endSeconds - shortened.startSeconds, 1);
});

test("clip ids have the shape the server accepts", () => {
  assert.match(newClipId(), /^[0-9a-f]{32}$/);
  assert.notEqual(newClipId(), newClipId());
});

test("clips saved out of reach survive a restart, per account", () => {
  const storage = memoryStorage();
  const key = pendingClipStorageKey("server-a", "reader-1");
  writePendingClips(storage, key, [clip("a", "book", 10, { pending: true })]);

  const restored = readPendingClips(storage, key);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].pending, true);
  assert.deepEqual(readPendingClips(storage, pendingClipStorageKey("server-a", "reader-2")), []);

  writePendingClips(storage, key, []);
  assert.equal(storage.values.size, 0, "an emptied queue left its entry behind");
});

test("a damaged queue reads as empty instead of breaking the player", () => {
  const storage = memoryStorage();
  storage.setItem("broken", "{not json");
  storage.setItem("wrong", JSON.stringify([{ id: 4 }, null, clip("ok", "book", 5)]));
  assert.deepEqual(readPendingClips(storage, "broken"), []);
  assert.deepEqual(readPendingClips(storage, "wrong").map((entry) => entry.id), ["ok"]);
});

test("a book lists its own clips in listening order, waiting ones included", () => {
  const saved = [clip("late", "book", 900), clip("other", "elsewhere", 5), clip("early", "book", 30)];
  const pending = [
    clip("waiting", "book", 400, { pending: true }),
    // Its save reached the server but the reply was lost.
    clip("late", "book", 900, { pending: true })
  ];
  const listed = clipsForBook(saved, pending, "book");
  assert.deepEqual(listed.map((entry) => entry.id), ["early", "waiting", "late"]);
  assert.equal(listed[2].pending, undefined, "the delivered copy should win");
});

test("a shared clip gets a file name a message thread can show", () => {
  assert.equal(clipFileName("Dune", { title: null, startSeconds: 3725 }), "Dune - 01-02-05.m4a");
  assert.equal(clipFileName("A/B: C?", { title: "The \"reveal\"", startSeconds: 0 }), "A B C - The reveal.m4a");
  assert.equal(clipFileName("", { title: "...", startSeconds: 0 }), "clip.m4a");
});

test("queued deletions survive restart and hide any server copy", () => {
  const storage = memoryStorage();
  const removed = clip("removed", "book", 10, { pending: true, deleted: true });
  writePendingClips(storage, "queue", [removed]);
  const restored = readPendingClips(storage, "queue");
  assert.equal(restored[0].deleted, true);
  assert.deepEqual(clipsForBook([clip("removed", "book", 10), clip("kept", "book", 20)], restored, "book").map(entry => entry.id), ["kept"]);
});
