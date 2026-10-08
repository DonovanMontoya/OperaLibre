import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { library } from "./performance/fixtures.ts";
import type { Book, Progress } from "../src/types.ts";
import type { BackgroundDownloadFile } from "../src/backgroundDownloads.ts";

const state = {
  native: false,
  files: new Map<string, string>(),
  stores: { data: new Map<string, unknown>(), media: new Map<string, unknown>() },
  jobs: new Map<string, { state: string; fraction: number; files: BackgroundDownloadFile[] }>(),
  attempts: [] as BackgroundDownloadFile[][],
  hold: false,
  fail: true,
  enqueued: () => {}
};
Reflect.set(globalThis, "__offlineReadinessStorage", state);
const fixture = "globalThis.__offlineReadinessStorage";
const later = (run: () => void) => queueMicrotask(run);
Reflect.set(globalThis, "indexedDB", { open() {
  const request = { result: { onversionchange: null, transaction(store: "data" | "media") {
    const tx = { oncomplete: null as null | (() => void), objectStore() {
      return {
        get(key: string) {
          const req = { result: undefined as unknown, onsuccess: null as null | (() => void) };
          later(() => { req.result = state.stores[store].get(key); req.onsuccess?.(); });
          return req;
        },
        put(value: { key?: string }, key?: string) { later(() => { state.stores[store].set(key ?? value.key!, value); tx.oncomplete?.(); }); },
        delete(key: string) { later(() => { state.stores[store].delete(key); tx.oncomplete?.(); }); }
      };
    } };
    return tx;
  } }, onsuccess: null as null | (() => void) };
  later(() => request.onsuccess?.());
  return request;
} });
const mocks: Record<string, string> = {
  "@capacitor/core": `export const Capacitor = { isNativePlatform: () => ${fixture}.native, convertFileSrc: value => value };`,
  "@capacitor/filesystem": `export const Directory = { Data: "DATA" }; export const Filesystem = {
    stat: async ({path}) => { const file = ${fixture}.files.get(path); if (file !== undefined) return {size: atob(file).length};
      if ([...${fixture}.files.keys()].some(key => key.startsWith(path + '/'))) return {size: 1}; throw Error('missing'); },
    getUri: async ({path}) => ({uri: 'file://' + path}), mkdir: async () => {},
    readFile: async ({path}) => { if (!${fixture}.files.has(path)) throw Error('missing'); return {data: ${fixture}.files.get(path)}; },
    writeFile: async ({path, data}) => { ${fixture}.files.set(path, data); },
    deleteFile: async ({path}) => { ${fixture}.files.delete(path.startsWith("file://") ? path.slice(7) : path); },
    rmdir: async ({path}) => { for (const key of ${fixture}.files.keys()) if (key.startsWith(path + '/')) ${fixture}.files.delete(key); }
  };`,
  "./api": `export const getServerStorageKey = () => 'server-a'; export const getServerUrl = () => '';`,
  "./backgroundDownloads": `
    export const getBackgroundBookDownloadStatus = async id => { const job = ${fixture}.jobs.get(id); if (!job) throw Error('missing job'); return job; };
    export const cancelBackgroundBookDownload = async id => {
      const job = ${fixture}.jobs.get(id);
      for (const file of job?.files ?? []) ${fixture}.files.delete(file.path.slice(7));
      ${fixture}.jobs.delete(id);
    };
    export const runBackgroundBookDownload = async (id, title, origin, files, progress, signal) => {
      ${fixture}.attempts.push(files);
      ${fixture}.enqueued();
      ${fixture}.jobs.set(id, {state: 'running', fraction: 0, files});
      if (${fixture}.hold) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
      for (const file of files) {
        if (${fixture}.fail && !file.required) continue;
        if (!${fixture}.files.has(file.path.slice(7))) ${fixture}.files.set(file.path.slice(7), btoa(file.label === 'read-along sync' ? JSON.stringify({version: 1, fragments: [{startSeconds: 0, endSeconds: 1, href: 'chapter.xhtml', text: 'Hello'}]}) : 'downloaded'));
      }
      ${fixture}.jobs.set(id, {state: 'completed', fraction: 1, files});
      progress(1, 'completed');
    };`,
  "./mediaFiles": `export const fileExtension = (name, fallback) => name.split('.').pop() || fallback; export const storedMediaExtension = value => value;`
};
register(`data:text/javascript,${encodeURIComponent(`
  const mocks = ${JSON.stringify(mocks)};
  export function resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/src/offline.ts') && specifier in mocks) {
      return {url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true};
    }
    if (context.parentURL?.includes('/src/offline.ts') && specifier === './companionCache') return nextResolve('./companionCache.ts', context);
    if (context.parentURL?.includes('/src/offline.ts') && specifier === './offlineDownload') return nextResolve('./offlineDownload.ts', context);
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const offline = await import("../src/offline.ts");
const epub = { id: "ebook", fileName: "book.epub", extension: "epub", contentType: "application/epub+zip", url: "/ebook" };
const book: Book = { ...library(1)[0], readingFile: epub,
  companions: [{ ...epub, kind: "book", sizeBytes: 20 }], syncFile: { url: "/sync", fileName: "book.sync.json", source: "sidecar" } };
const progress = { bookId: book.id, trackId: book.tracks[0].id, positionSeconds: 42, bookPositionSeconds: 42, updatedAt: "2026-10-07T00:00:00Z" } as Progress;

function reset(native: boolean) {
  state.native = native; state.files.clear(); state.stores.data.clear(); state.stores.media.clear();
  state.attempts.length = 0; state.jobs.clear(); state.hold = false; state.fail = true;
}

test("web partial downloads and retries survive offline reopening with listening progress intact", async (t) => {
  reset(false);
  let fail = true;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.push(url);
    if (fail && ["/ebook", "/sync"].includes(url)) return new Response(null, {status: 404});
    return new Response(url === '/sync' ? JSON.stringify({version: 1, fragments: [{startSeconds: 0, endSeconds: 1, href: 'chapter.xhtml', text: 'Hello'}]}) : url);
  });
  await offline.cacheProgress("reader", progress);
  await offline.cacheLibrary("reader", [book]);
  await offline.downloadBookForOffline(book, url => url, () => {});
  const reopened = await import("../src/offline.ts?web-reopened" as string);
  requests.length = 0;
  assert.equal((await reopened.getBookOfflineReadiness(book)).ebook, "missing");
  assert.equal((await reopened.getCachedLibrary("reader"))[0].id, book.id);
  assert.equal(await reopened.isBookDownloaded(book), true);
  assert.deepEqual(requests, [], "reopening inspects storage without reaching the server");
  const audio = state.stores.media.get(`server-a:${book.id}:track:${book.tracks[0].id}`);
  fail = false;
  await reopened.downloadBookForOffline(book, url => url, () => {}, undefined, true);
  assert.deepEqual(requests, ["/ebook", "/sync"]);
  assert.equal(state.stores.media.get(`server-a:${book.id}:track:${book.tracks[0].id}`), audio);
  assert.equal((await reopened.getBookOfflineReadiness(book)).sentenceSync, "available");
  assert.deepEqual(await reopened.getCachedProgress("reader", book.id), progress);
});

test("native missing-file jobs exclude audio, preserve progress, and reopen using their original cancellation list", async (t) => {
  reset(true);
  t.mock.method(globalThis, "fetch", async (url: string) => new Response(atob(state.files.get(url.slice(7))!)));
  await offline.cacheProgress("reader", progress);
  await offline.cacheLibrary("reader", [book]);
  await offline.downloadBookForOffline(book, url => url, () => {});
  assert.equal((await offline.getBookOfflineReadiness(book)).audio, true);
  assert.equal((await offline.getBookOfflineReadiness(book)).ebook, "missing");
  state.files.set(`offline-media/server-a/${book.id}/sync.json`, btoa("broken JSON"));
  const before = new Map(state.files);
  state.hold = true;
  const controller = new AbortController();
  const enqueued = new Promise<void>(resolve => { state.enqueued = resolve; });
  const attempt = offline.downloadBookForOffline(book, url => url, () => {}, controller.signal, true);
  const rejection = assert.rejects(attempt, {name: "AbortError"});
  // Wait for the real planning and persistence boundary, rather than a delay.
  await enqueued;
  assert.ok(!state.files.has(`offline-media/server-a/${book.id}/sync.json`), "iOS must replace unreadable JSON instead of precounting it");
  const files = state.attempts[1];
  assert.equal(files.length, 2);
  assert.ok(files.every(file => !file.required && !file.path.includes('/track-')));
  const reopened = await import("../src/offline.ts?native-reopened" as string);
  // One optional file finishes while the WebView is away.
  state.files.set(files[0].path.slice(7), btoa("ebook"));
  state.hold = false; state.fail = false;
  await reopened.downloadBookForOffline(book, url => url, () => {}, undefined, true);
  assert.deepEqual(state.attempts[2], files, "reattachment must not replace the live job's file list");
  assert.equal((await reopened.getBookOfflineReadiness(book)).sentenceSync, "available");
  await reopened.cancelBookOfflineDownload(book, true);
  controller.abort();
  await rejection;
  for (const track of book.tracks) {
    const key = `offline-media/server-a/${book.id}/track-${track.id}.wav`;
    assert.equal(state.files.get(key), before.get(key), "retry cancellation must never delete existing audio");
  }
  assert.equal(await reopened.isBookDownloaded(book), true);
  assert.deepEqual(await reopened.getCachedProgress("reader", book.id), progress);
  assert.equal((await reopened.getBookOfflineReadiness(book)).ebook, "missing");
  await reopened.removeBookDownload(book);
  assert.equal(await reopened.isBookDownloaded(book), false);
  assert.equal(state.jobs.size, 0, "removal must stop persisted jobs before they can recreate files");
  assert.deepEqual(await reopened.getCachedProgress("reader", book.id), progress);
});

test("readiness parses a stored sync map once and rereads it after the file changes", async (t) => {
  reset(false);
  const sentenceMap = {version: 1, precision: "sentence", fragments: [{startSeconds: 0, endSeconds: 1, href: 'chapter.xhtml', text: 'Hello'}]};
  t.mock.method(globalThis, "fetch", async (url: string) =>
    new Response(url === '/sync' ? JSON.stringify(sentenceMap) : url));
  await offline.downloadBookForOffline(book, url => url, () => {});
  const parse = t.mock.method(JSON, "parse");
  const mapReads = () => parse.mock.calls.filter(call => String(call.arguments[0]).includes('"fragments"')).length;
  for (let scan = 0; scan < 3; scan++) {
    assert.equal((await offline.getBookOfflineReadiness(book)).sentenceSync, "available");
  }
  assert.equal(mapReads(), 1, "later scans must reuse the verdict for an unchanged map");
  // Same length, different precision: only the write itself can tell the cache.
  await offline.saveOfflineSyncMap(book, {...sentenceMap, precision: "chapter!"});
  assert.equal((await offline.getBookOfflineReadiness(book)).sentenceSync, "unsupported");
  state.stores.media.delete(`server-a:${book.id}:sync`);
  assert.deepEqual((await offline.getBookOfflineReadiness(book)).missingFiles, ["sync"]);
});
