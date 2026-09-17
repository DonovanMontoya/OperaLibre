import assert from "node:assert/strict";
import test from "node:test";
import {
  ownsPendingPlay,
  playbackEventOwnsPendingPlay,
  playbackIntentBelongsToBook
} from "../src/playbackPending.ts";

test("a rejected play cannot clear the replacement book's pending request", () => {
  const oldRequest = { bookId: "book-a", cancelGeneration: 4 };

  assert.equal(ownsPendingPlay(oldRequest, 5, "book-b"), false);
});

test("a rejected play can clear the pending request that created it", () => {
  const request = { bookId: "book-a", cancelGeneration: 4 };

  assert.equal(ownsPendingPlay(request, 4, "book-a"), true);
});

test("playing events only clear their own book's pending request", () => {
  assert.equal(playbackEventOwnsPendingPlay(true, "book-b", "book-a"), false);
  assert.equal(playbackEventOwnsPendingPlay(true, "book-b", "book-b"), true);
  assert.equal(playbackEventOwnsPendingPlay(false, null, "book-a"), true);
});

test("a mounted book cannot borrow a replacement book's playback intent", () => {
  assert.equal(playbackIntentBelongsToBook(true, "book-b", "book-a", true), false);
  assert.equal(playbackIntentBelongsToBook(true, "book-a", "book-a", false), true);
  assert.equal(playbackIntentBelongsToBook(false, null, "book-a", true), true);
});
