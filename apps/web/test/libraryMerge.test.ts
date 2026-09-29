import assert from "node:assert/strict";
import test from "node:test";
import { libraryAfterUpload, mergeLibraryBooks } from "../src/libraryMerge.ts";
import { library } from "./performance/fixtures.ts";
import type { Book } from "../src/types.ts";

function deviceBooks() {
  return library(2).map((book, index): Book => ({
    ...book, id: `device-${index}`, source: "device", deviceBookId: `device-${index}`,
    tracks: book.tracks.map((track) => ({ ...track, id: `device-${track.id}`, localFilePath: `device-library/${index}/${track.fileName}` }))
  }));
}

test("an upload retains unmatched device books and local paths on paired server books", () => {
  const device = deviceBooks();
  device[1].title = "Device only";
  const server = library(1);
  const current = mergeLibraryBooks(server, device);
  const uploaded = { ...library(3)[2], title: "Uploaded book" };
  const result = libraryAfterUpload(current, [...server, uploaded], device);
  assert.deepEqual(result.map((book) => book.id), [server[0].id, uploaded.id, device[1].id]);
  assert.equal(result[0].deviceBookId, device[0].id);
  assert.deepEqual(result[0].tracks.map((track) => track.localFilePath), device[0].tracks.map((track) => track.localFilePath));
});

test("playback advanced during upload survives a stale server response", () => {
  const incoming = library(1);
  const progress = { status: "inProgress" as const, bookPositionSeconds: 150, durationSeconds: 240, remainingSeconds: 90, percentComplete: 62.5, updatedAt: "2026-09-29T12:01:00Z" };
  const current = [{ ...incoming[0], progress }];
  incoming[0].progress = { ...progress, bookPositionSeconds: 100, updatedAt: "2026-09-29T12:00:00Z" };
  incoming[0].description = "New metadata";
  const result = libraryAfterUpload(current, incoming, []);
  assert.equal(result[0].progress, progress);
  assert.equal(result[0].description, "New metadata");
});

test("a device import completed during upload is included in the resulting shelf", () => {
  const current = library(1);
  const device = deviceBooks();
  device[1].title = "New device import";
  assert.equal(libraryAfterUpload(current, current, device).find((book) => book.id === device[1].id)?.title, "New device import");
});

test("ambiguous copies remain separate instead of assigning the wrong audio", () => {
  const server = library(1);
  const device = deviceBooks();
  device[1] = { ...device[0], id: "second-copy" };
  const result = libraryAfterUpload([], server, device);
  assert.equal(result.length, 3);
  assert.equal(result[0].deviceBookId, undefined);
});
