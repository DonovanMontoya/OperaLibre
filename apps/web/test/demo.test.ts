import assert from "node:assert/strict";
import test from "node:test";
import {
  demoContentIsSelfContained,
  getDemoBooks,
  saveDemoProgress,
  setDemoBookCompletion
} from "../src/demo.ts";

test("demo content is entirely local and carries no store identifiers", () => {
  assert.equal(demoContentIsSelfContained(), true);
  for (const book of getDemoBooks()) {
    assert.equal(book.asin, null);
    assert.match(book.description ?? "", /original|procedural/i);
    assert.ok(book.tracks.length > 0);
  }
});

test("demo books can be marked finished and unfinished without seeking", () => {
  const book = getDemoBooks()[0];
  assert.ok(book);
  const finished = setDemoBookCompletion(book, true);
  assert.equal(finished.status, "finished");
  assert.equal(finished.bookPositionSeconds, 0);

  const unfinished = setDemoBookCompletion(book, false);
  assert.equal(unfinished.status, "notStarted");
  assert.equal(unfinished.bookPositionSeconds, 0);
});

test("natural completion stores the final position with the finished status", () => {
  const book = getDemoBooks()[1];
  const finalTrack = book?.tracks[book.tracks.length - 1];
  assert.ok(book);
  assert.ok(finalTrack);
  const finalTrackPosition = finalTrack.durationSeconds ?? 0;
  const finalBookPosition = book.durationSeconds ?? finalTrackPosition;

  const finished = setDemoBookCompletion(book, true, {
    trackId: finalTrack.id,
    positionSeconds: finalTrackPosition,
    bookPositionSeconds: finalBookPosition,
    durationSeconds: finalTrack.durationSeconds
  });

  assert.equal(finished.status, "finished");
  assert.equal(finished.bookPositionSeconds, finalBookPosition);
  assert.equal(finished.remainingSeconds, 0);
});

test("marking a started book unplayed resets it to the opening", () => {
  const book = getDemoBooks()[0];
  const firstTrack = book?.tracks[0];
  assert.ok(book);
  assert.ok(firstTrack);

  saveDemoProgress(book.id, {
    trackId: firstTrack.id,
    positionSeconds: 9,
    bookPositionSeconds: 9,
    durationSeconds: firstTrack.durationSeconds
  });

  const unplayed = setDemoBookCompletion(book, false, {
    trackId: firstTrack.id,
    positionSeconds: 0,
    bookPositionSeconds: 0,
    durationSeconds: firstTrack.durationSeconds
  });

  assert.equal(unplayed.status, "notStarted");
  assert.equal(unplayed.bookPositionSeconds, 0);
  assert.equal(unplayed.percentComplete, 0);
});
