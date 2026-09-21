import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import type { Book, SyncMap } from "../src/types.ts";

// Load the real persistence code with native I/O replaced at the module boundary.
// Each test can pause a filesystem operation while the server or reader changes.
const state = {
  scope: "server-a",
  stat: async (_options?: { path: string }) => {},
  mkdir: async () => {},
  writeFile: async (_options: { path: string; data: string }) => {},
  readFile: async (_options: { path: string }) => ({ data: "" }),
  getUri: async (options: { path: string }) => ({ uri: `file://${options.path}` }),
  rmdir: async (_options: { path: string }) => {}
};
const fixtureKey = Symbol.for("operalibre.offlineSyncMap.test");
Reflect.set(globalThis, fixtureKey, state);
const fixture = 'globalThis[Symbol.for("operalibre.offlineSyncMap.test")]';
const mocks: Record<string, string> = {
  "@capacitor/core": `export const Capacitor = {
    isNativePlatform: () => true,
    convertFileSrc: (value) => value
  };`,
  "@capacitor/filesystem": `export const Directory = { Data: "DATA" };
    export const Filesystem = {
      stat: (options) => ${fixture}.stat(options),
      mkdir: () => ${fixture}.mkdir(),
      writeFile: (options) => ${fixture}.writeFile(options),
      readFile: (options) => ${fixture}.readFile(options),
      getUri: (options) => ${fixture}.getUri(options),
      rmdir: (options) => ${fixture}.rmdir(options),
      rename: () => Promise.resolve()
    };`,
  "./api": `export const getServerStorageKey = () => ${fixture}.scope;
    export const getServerUrl = () => "";`,
  "./backgroundDownloads": "export const cancelBackgroundBookDownload = null, getBackgroundBookDownloadStatus = null, runBackgroundBookDownload = null;",
  "./mediaFiles": `export const fileExtension = (name, fallback) => name.split(".").pop()?.toLowerCase() || fallback;
    export const storedMediaExtension = (extension) => extension === "m4b" ? "m4a" : extension;`,
  "./companionCache": "export const revalidatedCompanion = null;",
  "./offlineDownload": "export const downloadWebBook = null;"
};
register(`data:text/javascript,${encodeURIComponent(`
  const mocks = ${JSON.stringify(mocks)};
  export function resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/src/offline.ts") && specifier in mocks) {
      return { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const {
  cacheLibrary,
  getCachedLibrary,
  getOfflineTrackUrl,
  isBookDownloaded,
  newestLibrarySnapshot,
  removeBookDownload,
  saveOfflineSyncMap
} = await import("../src/offline.ts");

const book = { id: "shared-book", tracks: [{ id: "track", localFilePath: "downloaded.mp3" }] } as Book;
const map: SyncMap = {
  version: 2,
  precision: "sentence",
  fragments: [{ startSeconds: 0, endSeconds: 2, href: "chapter.xhtml", text: "Café — 読書" }]
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("native sync-map persistence", async (t) => {
  const writes: Array<{ path: string; data: string }> = [];
  t.beforeEach(() => {
    state.scope = "server-a";
    state.stat = async () => {};
    state.mkdir = async () => {};
    state.writeFile = async (options) => { writes.push(options); };
    writes.length = 0;
  });

  await t.test("a downloaded book receives the alignment with intact Unicode", async () => {
    await saveOfflineSyncMap(book, map);
    assert.equal(writes[0].path, "offline-media/server-a/shared-book/sync.json");
    assert.deepEqual(JSON.parse(Buffer.from(writes[0].data, "base64").toString("utf8")), map);
  });

  for (const boundary of ["stat", "mkdir"] as const) {
    for (const change of ["cancel", "server"] as const) {
      await t.test(`${change} during ${boundary} prevents a stale write`, async () => {
        const started = deferred();
        const release = deferred();
        const controller = new AbortController();
        state[boundary] = async () => { started.resolve(); await release.promise; };
        const pending = saveOfflineSyncMap(book, map, controller.signal);
        await started.promise;
        if (change === "cancel") controller.abort();
        else state.scope = "server-b";
        release.resolve();
        await pending;
        assert.deepEqual(writes, []);
      });
    }
  }

  await t.test("an already cancelled refresh performs no filesystem lookup", async () => {
    let lookups = 0;
    state.stat = async () => { lookups += 1; };
    await saveOfflineSyncMap(book, map, AbortSignal.abort());
    assert.equal(lookups, 0);
    assert.deepEqual(writes, []);
  });

  await t.test("missing audio does not create a sync-only download", async () => {
    state.stat = async () => { throw new Error("not found"); };
    await saveOfflineSyncMap(book, map);
    assert.deepEqual(writes, []);
  });

  await t.test("storage failure does not reject the reader's refresh", async () => {
    state.writeFile = async () => { throw new Error("disk full"); };
    await assert.doesNotReject(saveOfflineSyncMap(book, map));
  });
});

test("native library cache survives unavailable IndexedDB", async () => {
  const writes: Array<{ path: string; data: string }> = [];
  state.scope = "server-a";
  state.mkdir = async () => {};
  state.writeFile = async (options) => { writes.push(options); };
  const cachedBook = {
    id: "downloaded-book",
    title: "Downloaded Book",
    tracks: [{ id: "track", fileName: "track.mp3" }]
  } as Book;

  await cacheLibrary("reader", [cachedBook]);
  const snapshot = writes.find((write) => write.path === "offline-media/server-a/library-reader.json");
  assert.ok(snapshot);
  state.readFile = async () => ({ data: snapshot.data });

  assert.deepEqual(await getCachedLibrary("reader"), [cachedBook]);
});

test("the newest durable library copy wins after one cache recovers", () => {
  const stale = { cachedAt: 10, books: [{ id: "stale" }] as Book[] };
  const current = { cachedAt: 20, books: [{ id: "current" }] as Book[] };
  assert.equal(newestLibrarySnapshot(stale, current), current);
  assert.equal(newestLibrarySnapshot(current, stale), current);
});

test("removing a partially migrated download clears scoped and legacy folders", async () => {
  const removed: string[] = [];
  state.stat = async ({ path } = { path: "" }) => {
    if (path !== "offline-media/server-a/legacy-book") throw new Error("not found");
  };
  state.rmdir = async ({ path }) => { removed.push(path); };

  await removeBookDownload({ id: "legacy-book", tracks: [] } as unknown as Book);

  assert.deepEqual(removed.sort(), [
    "offline-media/legacy-book",
    "offline-media/server-a/legacy-book"
  ]);
});

test("a track remains playable from an old folder after a partial scoped migration", async () => {
  const legacyBook = {
    id: "legacy-book",
    tracks: [{ id: "chapter-one", fileName: "Chapter One.m4b" }]
  } as Book;
  const present = new Set([
    // The directory makes whole-book migration stop, but this scoped copy has
    // no track. The valid audio remains in the pre-scope location.
    "offline-media/server-a/legacy-book",
    "offline-media/legacy-book/track-chapter-one.m4a"
  ]);
  state.stat = async ({ path } = { path: "" }) => {
    if (!present.has(path)) throw new Error("not found");
  };

  assert.equal(await isBookDownloaded(legacyBook), true);
  assert.equal(
    await getOfflineTrackUrl(legacyBook, legacyBook.tracks[0]),
    "file://offline-media/legacy-book/track-chapter-one.m4a"
  );
});
