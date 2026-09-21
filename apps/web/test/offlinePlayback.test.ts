import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeQueueIdentity,
  nativeQueueIsReady,
  resolveLocalFirstUrls
} from "../src/offlinePlayback.ts";

test("every downloaded queue track resolves locally before playback", async () => {
  const tracks = ["chapter-1", "chapter-2", "chapter-3"];
  const urls = await resolveLocalFirstUrls(
    tracks,
    async (track) => `file:///offline/${track}.m4a`,
    (track) => `https://server.invalid/${track}`
  );

  assert.deepEqual(urls, [
    "file:///offline/chapter-1.m4a",
    "file:///offline/chapter-2.m4a",
    "file:///offline/chapter-3.m4a"
  ]);
});

test("one missing or failed local track falls back without changing the others", async () => {
  const tracks = ["local", "missing", "failed"];
  const urls = await resolveLocalFirstUrls(
    tracks,
    async (track) => {
      if (track === "missing") return null;
      if (track === "failed") throw new Error("filesystem unavailable");
      return `file:///offline/${track}.m4a`;
    },
    (track) => `https://server.example/${track}`
  );

  assert.deepEqual(urls, [
    "file:///offline/local.m4a",
    "https://server.example/missing",
    "https://server.example/failed"
  ]);
});

test("native attachment waits for the complete queue for its exact storage state", () => {
  const remote = nativeQueueIdentity("book", "chapter-1", false);
  const downloaded = nativeQueueIdentity("book", "chapter-1", true);

  assert.equal(nativeQueueIsReady(true, remote, null), false);
  assert.equal(nativeQueueIsReady(true, remote, remote), true);
  assert.equal(nativeQueueIsReady(true, downloaded, remote), false);
  assert.equal(nativeQueueIsReady(false, remote, null), true);
});
