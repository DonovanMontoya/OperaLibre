import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { library } from "./performance/fixtures.ts";

const paths = new Set<string>();
Reflect.set(globalThis, "__coverTestPaths", paths);
const mocks: Record<string, string> = {
  "@capacitor/core": "export const Capacitor = { isNativePlatform: () => true, convertFileSrc: (value) => value };",
  "@capacitor/filesystem": `export const Directory = { Data: "DATA" }; export const Filesystem = {
    stat: async ({path}) => { if (!globalThis.__coverTestPaths.has(path)) throw new Error('missing'); return {}; },
    getUri: async ({path}) => ({uri: 'file://' + path}),
    readdir: async ({path}) => ({ files: [...globalThis.__coverTestPaths]
      .filter(file => file.startsWith(path + '/'))
      .map((file, index) => ({ name: file.slice(path.length + 1), mtime: index })) })
  };`,
  "./api": "export const getServerStorageKey = () => 'server-a'; export const getServerUrl = () => '';",
  "./backgroundDownloads": "export const cancelBackgroundBookDownload = null, getBackgroundBookDownloadStatus = null, runBackgroundBookDownload = null;",
  "./mediaFiles": "export const fileExtension = () => ''; export const storedMediaExtension = value => value;",
  "./companionCache": "export const revalidatedCompanion = null;",
  "./offlineDownload": "export const downloadWebBook = null;"
};
register(`data:text/javascript,${encodeURIComponent(`
  const mocks = ${JSON.stringify(mocks)};
  export function resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/src/offline.ts') && specifier in mocks) {
      return { url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const { getOfflineCoverUrl } = await import("../src/offline.ts");
const directory = "offline-media/server-a/book-0";
const book = { ...library(1)[0], coverArtUrl: "/api/books/book-0/cover?v=new", coverArtContentType: "image/png" };

test("a versioned cover never returns an older local image while online", async () => {
  paths.clear();
  paths.add(directory);
  paths.add(`${directory}/cover.jpg`);
  paths.add(`${directory}/track-track-0-0.m4a`);
  const before = [...paths];
  assert.equal(await getOfflineCoverUrl(book, false), null);
  assert.deepEqual([...paths], before, "reading a replacement cover must not alter downloaded audio or files");
});

test("an older unversioned download remains an offline fallback after the first upgraded scan", async () => {
  paths.clear();
  paths.add(directory);
  paths.add(`${directory}/cover.jpg`);
  assert.equal(await getOfflineCoverUrl(book, true), `file://${directory}/cover.jpg`);
});

test("the matching cover revision is used offline and later revisions do not reuse it", async () => {
  paths.clear();
  paths.add(directory);
  paths.add(`${directory}/cover-new.png`);
  assert.equal(await getOfflineCoverUrl(book, false), `file://${directory}/cover-new.png`);
  assert.equal(await getOfflineCoverUrl({ ...book, coverArtUrl: "/cover?v=later" }, false), null);
});

test("a paired device cover cannot mask a replacement but remains available during an outage", async () => {
  paths.clear();
  paths.add(directory);
  paths.add("device/imported.jpg");
  const paired = { ...book, localCoverPath: "device/imported.jpg" };
  assert.equal(await getOfflineCoverUrl(paired, false), null);
  assert.equal(await getOfflineCoverUrl(paired, true), "file://device/imported.jpg");
  assert.equal(await getOfflineCoverUrl({ ...paired, coverArtUrl: null, source: "device" }, false), "file://device/imported.jpg");
});


test("replacing artwork online then going offline retains the last downloaded revision", async () => {
  paths.clear();
  paths.add(directory);
  paths.add(`${directory}/cover-original.jpg`);
  paths.add(`${directory}/cover-downloaded.png`);
  paths.add(`${directory}/track-track-0-0.m4a`);
  const before = [...paths];
  assert.equal(await getOfflineCoverUrl(book, false), null, "online must request the newer server version");
  assert.equal(await getOfflineCoverUrl(book, true), `file://${directory}/cover-downloaded.png`);
  assert.deepEqual([...paths], before, "fallback leaves downloaded audio and covers intact");
});


test("restoring a book with no embedded cover cannot resurrect the downloaded override", async () => {
  paths.clear();
  paths.add(directory);
  paths.add(`${directory}/cover.jpg`);
  paths.add(`${directory}/cover-downloaded.png`);
  assert.equal(await getOfflineCoverUrl({ ...book, coverArtUrl: null, hasCoverOverride: false }, true), null);
});
