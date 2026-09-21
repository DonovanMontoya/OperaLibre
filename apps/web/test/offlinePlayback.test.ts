import assert from "node:assert/strict";
import test from "node:test";
import {
  canPublishNativeQueue,
  nativeQueueEntryUrl,
  nativeQueueIdentity,
  nativeQueueIdentityAfterRestore,
  nativeQueueIsReady,
  nativeQueueRefreshShouldResume,
  playbackRestoreBookAfterAction,
  resolveLocalFirstSources,
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
  const remote = nativeQueueIdentity("book", "chapter-1", false, true);
  const downloaded = nativeQueueIdentity("book", "chapter-1", true, true);

  assert.equal(nativeQueueIsReady(true, remote, null), false);
  assert.equal(nativeQueueIsReady(true, remote, remote), true);
  assert.equal(nativeQueueIsReady(true, downloaded, remote), false);
  assert.equal(nativeQueueIsReady(false, remote, null), true);
});

test("offline native cold start cannot queue the first track before progress restoration", () => {
  assert.equal(
    nativeQueueIdentityAfterRestore(true, "book", "opening-credits", null, true, false),
    null
  );
  assert.equal(
    nativeQueueIdentityAfterRestore(true, "book", "chapter-63", "book", true, false),
    nativeQueueIdentity("book", "chapter-63", true, false)
  );
  assert.equal(
    nativeQueueIdentityAfterRestore(false, "book", "opening-credits", null, true, false),
    nativeQueueIdentity("book", "opening-credits", true, false)
  );
});

test("a deliberate playback action releases a superseded restoration gate", () => {
  assert.equal(playbackRestoreBookAfterAction(null, "book", true), "book");
  assert.equal(playbackRestoreBookAfterAction(null, "book", false), null);
  assert.equal(playbackRestoreBookAfterAction("first", null, true), "first");
});

test("receiving the media credential invalidates tokenless remote queue URLs", () => {
  const withoutCredential = nativeQueueIdentity("book", "chapter-1", false, false);
  const withCredential = nativeQueueIdentity("book", "chapter-1", false, true);

  assert.notEqual(withCredential, withoutCredential);
  assert.equal(nativeQueueIsReady(true, withCredential, withoutCredential), false);
});

test("replacing an active native queue preserves its play intent", () => {
  const remote = nativeQueueIdentity("book", "chapter-1", false, true);
  const downloaded = nativeQueueIdentity("book", "chapter-1", true, true);

  assert.equal(nativeQueueRefreshShouldResume(true, true, downloaded, remote), true);
  assert.equal(nativeQueueRefreshShouldResume(true, false, downloaded, remote), false);
  assert.equal(nativeQueueRefreshShouldResume(false, true, downloaded, remote), false);
  assert.equal(nativeQueueRefreshShouldResume(true, true, downloaded, downloaded), false);
  assert.equal(nativeQueueRefreshShouldResume(true, true, downloaded, null), false);
  assert.equal(nativeQueueRefreshShouldResume(true, true, null, remote), false);
});

test("the rebuilt queue owns the current source instead of a stale remote fallback", () => {
  assert.equal(
    nativeQueueEntryUrl([{ url: "file:///downloaded/chapter-1.m4a" }], "https://server/chapter-1"),
    "file:///downloaded/chapter-1.m4a"
  );
  assert.equal(nativeQueueEntryUrl([], "https://server/chapter-1"), "https://server/chapter-1");
});

test("only a wholly local queue publishes before the media credential arrives", async () => {
  const tracks = ["local", "remote"];
  const mixed = await resolveLocalFirstSources(
    tracks,
    async (track) => track === "local" ? "file:///local.m4a" : null,
    (track) => `https://server.example/${track}`
  );
  const local = await resolveLocalFirstSources(
    tracks,
    async (track) => `file:///${track}.m4a`,
    (track) => `https://server.example/${track}`
  );

  assert.equal(canPublishNativeQueue(mixed, false), false);
  assert.equal(canPublishNativeQueue(mixed, true), true);
  assert.equal(canPublishNativeQueue(local, false), true);
});
