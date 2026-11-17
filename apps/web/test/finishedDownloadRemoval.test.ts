import assert from "node:assert/strict";
import test from "node:test";
import { loadHook } from "./hookHarness.ts";

function removalFixture(downloaded: boolean) {
  const removed: string[] = [];
  const notices: unknown[] = [];
  let downloadedIds = new Set(["book"]);
  const useOfflineDownloads = loadHook("useOfflineDownloads", {
    react: { useRef: (current: unknown) => ({ current }), useEffect: () => {}, useMemo: (run: () => unknown) => run(), useState: (value: unknown) => [value, () => {}] },
    "./offline": {
      isBookDownloaded: async () => downloaded,
      removeBookDownload: async (book: { id: string }) => { removed.push(book.id); },
      getBookOfflineReadiness: async () => ({ audio: false })
    },
    "./api": { getServerStorageKey: () => "fixture" },
    "./offlineReadiness": {},
    "./formatting": { errorMessage: (error: Error) => error.message },
    "./localLibrary": {}
  });
  const hook = useOfflineDownloads({
    books: [],
    playbackBook: null,
    clearPlaybackSession: () => assert.fail("a finished book has no session left to clear"),
    persistProgress: async () => assert.fail("removal after finishing must not write progress"),
    stopCarPlaybackForRemoval: async () => {},
    setDownloadStatus: (notice: unknown) => notices.push(notice),
    setDownloadedBookIds: (update: (ids: Set<string>) => Set<string>) => { downloadedIds = update(downloadedIds); }
  });
  return { hook, removed, notices, downloadedIds: () => downloadedIds };
}

test("finishing a downloaded server book removes only its local copy", async () => {
  const f = removalFixture(true);
  await f.hook.removeFinishedDownload({ id: "book", title: "Fixture", source: "server", tracks: [{ id: "t" }] });
  assert.deepEqual(f.removed, ["book"]);
  assert.equal(f.downloadedIds().has("book"), false);
  assert.deepEqual(f.notices, [{ bookId: "book", message: "Removed the finished download of Fixture" }]);
});

test("finishing leaves device imports and books without a download alone", async () => {
  const deviceImport = removalFixture(true);
  await deviceImport.hook.removeFinishedDownload({ id: "book", title: "Fixture", source: "device", tracks: [{ id: "t" }] });
  assert.deepEqual(deviceImport.removed, [], "a device import is the listener's only copy");

  const streamed = removalFixture(false);
  await streamed.hook.removeFinishedDownload({ id: "book", title: "Fixture", source: "server", tracks: [{ id: "t" }] });
  assert.deepEqual(streamed.removed, []);
  assert.deepEqual(streamed.notices, []);
});
