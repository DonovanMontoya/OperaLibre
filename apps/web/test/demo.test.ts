import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { findActiveFragmentIndex, syncMapPrecision } from "../src/readalong.ts";
import type { SyncMap } from "../src/types.ts";
import {
  demoMediaUrl,
  getDemoBooks,
  saveDemoProgress,
  setDemoBookCompletion
} from "../src/demo.ts";

test("demo content is entirely local and carries no store identifiers", () => {
  for (const book of getDemoBooks()) {
    assert.match(book.coverArtUrl ?? "", /^\/demo\//, `${book.id}: cover must be local`);
    for (const track of book.tracks) {
      assert.match(track.streamUrl, /^\/demo\//, `${book.id}/${track.id}: audio must be local`);
    }
    if (book.readingFile) {
      assert.match(book.readingFile.url, /^\/demo\//, `${book.id}: reading file must be local`);
    }
    assert.equal(book.asin, null);
    assert.match(book.description ?? "", /LibriVox/);
    assert.match(book.syncFile?.url ?? "", /^\/demo\//);
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
  const book = getDemoBooks()[0];
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

const demoAsset = (path: string) => new URL(`../public${path}`, import.meta.url);

test("the default Alice package includes the matching audio, EPUB and precise excerpt map", () => {
  const books = getDemoBooks();
  assert.equal(books.length, 1);
  const book = books[0];
  assert.equal(book.title, "Alice’s Adventures in Wonderland");
  assert.equal(book.narrator, "Kristen McQuillin");
  assert.ok(book.readingFile);
  assert.ok(book.syncFile);
  const provenance = JSON.parse(readFileSync(demoAsset("/demo/alice/provenance.json"), "utf8"));
  for (const path of [book.tracks[0].streamUrl, book.readingFile.url, book.syncFile.url]) {
    const bytes = readFileSync(demoAsset(path));
    const name = path.split("/").at(-1)!;
    assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.sha256[name], name);
  }
  assert.equal(book.companions?.[0].sizeBytes, statSync(demoAsset(book.readingFile.url)).size);
  assert.equal(book.durationSeconds, provenance.trim.durationSeconds);
  assert.equal(book.tracks[0].durationSeconds, book.durationSeconds);
  const map = JSON.parse(readFileSync(demoAsset(book.syncFile.url), "utf8")) as SyncMap;
  assert.equal(syncMapPrecision(map), "sentence");
  assert.equal(map.fragments.length, provenance.alignment.sentences);
  let previousEnd = 0;
  for (const [index, fragment] of map.fragments.entries()) {
    assert.ok(fragment.startSeconds >= previousEnd);
    assert.ok(fragment.endSeconds > fragment.startSeconds);
    assert.ok(fragment.endSeconds <= book.durationSeconds!);
    assert.ok(fragment.href);
    assert.ok(fragment.text);
    assert.equal(findActiveFragmentIndex(map.fragments, (fragment.startSeconds + fragment.endSeconds) / 2), index);
    previousEnd = fragment.endSeconds;
  }
});

test("demo media resolves inside a nested frontend without using the saved server", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    for (const baseURI of ["https://example.test/product-demo/index.html", "capacitor://localhost/index.html"]) {
      Object.defineProperty(globalThis, "document", { configurable: true, value: { baseURI } });
      assert.equal(demoMediaUrl("/demo/alice/alice.epub"), new URL("demo/alice/alice.epub", baseURI).href);
    }
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
