import assert from "node:assert/strict";
import { test } from "node:test";
import { coverFileError, coverMediaKind, coverRevision, MAX_COVER_BYTES, mergeBookEdit } from "../src/bookCover.ts";
import { library } from "./performance/fixtures.ts";

test("cover selection accepts supported images and rejects empty, large, or unsupported files", () => {
  for (const [name, type] of [["cover.jpg", "image/jpeg"], ["cover.png", "image/png"], ["cover.webp", "image/webp"], ["COVER.JPEG", ""]]) {
    assert.equal(coverFileError({ name, type, size: MAX_COVER_BYTES }), null);
  }
  for (const file of [
    { name: "cover.svg", type: "image/svg+xml", size: 20 },
    { name: "cover.gif", type: "image/gif", size: 20 },
    { name: "cover.exe", type: "", size: 20 },
    { name: "cover.png", type: "image/png", size: 0 },
    { name: "cover.png", type: "image/png", size: MAX_COVER_BYTES + 1 }
  ]) assert.ok(coverFileError(file), file.name);
});

test("cover revisions isolate changed artwork without invalidating older unversioned downloads", () => {
  assert.equal(coverMediaKind({ coverArtUrl: "/api/books/one/cover" }), "cover");
  assert.equal(coverMediaKind({ coverArtUrl: "/api/books/one/cover?v=abc_123&token=private" }), "cover:abc_123");
  assert.equal(coverMediaKind({ coverArtUrl: "/api/books/one/cover?v=next" }), "cover:next");
  for (const value of ["../other", "a/b", "x".repeat(129)]) {
    assert.equal(coverRevision({ coverArtUrl: `/cover?v=${encodeURIComponent(value)}` }), null);
  }
});

test("cover and metadata saves preserve newer playback, device copies, and unrelated edits", () => {
  const current = library(1)[0];
  current.progress = { status: "inProgress", bookPositionSeconds: 170, durationSeconds: 240,
    remainingSeconds: 70, percentComplete: 71, updatedAt: "2026-10-01T12:00:00Z" };
  current.deviceBookId = "device-copy";
  current.localCoverPath = "device-cover.jpg";
  current.tracks[0].localFilePath = "device-audio.m4a";
  current.volumeGain = 1.5;
  const response = { ...library(1)[0], title: "New title", coverArtUrl: "/cover?v=new",
    coverArtContentType: "image/png", hasCoverOverride: true };
  const metadata = mergeBookEdit(current, response, "metadata");
  assert.equal(metadata.title, "New title");
  assert.equal(metadata.coverArtUrl, current.coverArtUrl);
  const cover = mergeBookEdit(metadata, { ...response, title: "Stale title" }, "cover");
  assert.equal(cover.title, "New title");
  assert.equal(cover.coverArtUrl, "/cover?v=new");
  assert.equal(cover.hasCoverOverride, true);
  assert.equal(cover.progress, current.progress);
  assert.equal(cover.tracks, current.tracks);
  assert.equal(cover.deviceBookId, "device-copy");
  assert.equal(cover.localCoverPath, "device-cover.jpg");
  assert.equal(cover.volumeGain, 1.5);
  assert.equal(mergeBookEdit(cover, { ...response, hasCoverOverride: false, coverArtUrl: "/cover?v=original" }, "cover").hasCoverOverride, false);
});
