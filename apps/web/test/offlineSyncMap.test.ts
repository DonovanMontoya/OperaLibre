import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import type { Book, SyncMap } from "../src/types.ts";

// Load the real persistence code with native I/O replaced at the module boundary.
// Each test can pause a filesystem operation while the server or reader changes.
const state = {
  scope: "server-a",
  stat: async () => {},
  mkdir: async () => {},
  writeFile: async (_options: { path: string; data: string }) => {}
};
const fixtureKey = Symbol.for("operalibre.offlineSyncMap.test");
Reflect.set(globalThis, fixtureKey, state);
const fixture = 'globalThis[Symbol.for("operalibre.offlineSyncMap.test")]';
const mocks: Record<string, string> = {
  "@capacitor/core": "export const Capacitor = { isNativePlatform: () => true };",
  "@capacitor/filesystem": `export const Directory = { Data: "DATA" };
    export const Filesystem = {
      stat: () => ${fixture}.stat(),
      mkdir: () => ${fixture}.mkdir(),
      writeFile: (options) => ${fixture}.writeFile(options)
    };`,
  "./api": `export const getServerStorageKey = () => ${fixture}.scope;
    export const getServerUrl = () => "";`,
  "./backgroundDownloads": "export const cancelBackgroundBookDownload = null, getBackgroundBookDownloadStatus = null, runBackgroundBookDownload = null;",
  "./mediaFiles": "export const fileExtension = null, storedMediaExtension = null;",
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
const { saveOfflineSyncMap } = await import("../src/offline.ts");

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
