import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadWebBook } from "../src/offlineDownload.ts";
import { inspectOfflineReadiness, offlineDownloadMessage, storedSyncTimings } from "../src/offlineReadiness.ts";
import { library } from "./performance/fixtures.ts";
import type { Book, SyncMap } from "../src/types.ts";

const epub = { id: "ebook", fileName: "book.epub", extension: "epub", contentType: "application/epub+zip", url: "/ebook" };
const book: Book = { ...library(1)[0], readingFile: epub,
  companions: [{ ...epub, kind: "book", sizeBytes: 20 }], syncFile: { url: "/sync", fileName: "book.sync.json", source: "sidecar" } };
const map: SyncMap = { version: 1, fragments: [{ startSeconds: 0, endSeconds: 1, href: "chapter.xhtml", text: "Hello" }] };

async function readiness(book: Book, stored: Map<string, Blob>) {
  return inspectOfflineReadiness(book, book.tracks.every((track) => stored.has(`track:${track.id}`)),
    async (key) => stored.has(key), async () => {
      try { return storedSyncTimings(JSON.parse(await stored.get("sync")!.text())); } catch { return "none"; }
    }, "cover");
}

test("404s leave playable audio, report missing reading files, and retry only those files", async (t) => {
  const stored = new Map<string, Blob>();
  const requested: string[] = [];
  let failOptional = true;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requested.push(url);
    return failOptional && ["/ebook", "/sync"].includes(url)
      ? new Response(null, { status: 404 }) : new Response(url === "/sync" ? JSON.stringify(map) : url);
  });
  const save = async (kind: string, blob: Blob) => { stored.set(kind, blob); };
  const remove = async (kind: string) => { stored.delete(kind); };
  await downloadWebBook(book, (url) => url, save, remove, () => {});
  const audio = stored.get(`track:${book.tracks[0].id}`);
  const partial = await readiness(book, stored);
  assert.deepEqual(partial, { audio: true, ebook: "missing", sentenceSync: "missing", missingFiles: ["companion:ebook", "sync"] });
  assert.match(offlineDownloadMessage(book.title, partial), /Ebook: missing.*Sentence sync: missing/);
  assert.doesNotMatch(offlineDownloadMessage(book.title, partial), /is available offline/);
  requested.length = 0;
  failOptional = false;
  await downloadWebBook(book, (url) => url, save, remove, () => {}, undefined, async (key) => stored.has(key));
  assert.deepEqual(requested, ["/ebook", "/sync"]);
  assert.equal(stored.get(`track:${book.tracks[0].id}`), audio);
  assert.deepEqual(await readiness(book, stored), { audio: true, ebook: "available", sentenceSync: "available", missingFiles: [] });
});

test("failed and cancelled retries preserve audio and companions stored before the attempt", async (t) => {
  for (const cancel of [false, true]) {
    const audio = new Blob(["original audio"]);
    const stored = new Map(book.tracks.map((track) => [`track:${track.id}`, audio]));
    const controller = new AbortController();
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url === "/sync") {
        if (cancel) controller.abort();
        return new Response(null, { status: 503 });
      }
      return new Response("ebook");
    });
    const operation = downloadWebBook(book, (url) => url,
      async (key, blob) => { stored.set(key, blob); }, async (key) => { stored.delete(key); },
      () => {}, controller.signal, async (key) => stored.has(key));
    if (cancel) await assert.rejects(operation, { name: "AbortError" });
    else await operation;
    assert.equal(stored.get(`track:${book.tracks[0].id}`), audio);
    assert.equal((await readiness(book, stored)).audio, true);
    assert.equal(stored.has("companion:ebook"), !cancel);
    t.mock.restoreAll();
  }
});

test("missing, unsupported, legacy, and chapter-only companions are distinguished", async () => {
  const stored = new Map([["companion:ebook", new Blob(["ebook"])], ["sync", new Blob([JSON.stringify(map)])]]);
  assert.equal((await readiness({ ...book, companions: undefined }, stored)).ebook, "available", "legacy readingFile is inspected");
  const absent = await readiness({ ...book, companions: [], readingFile: null, syncFile: null }, stored);
  assert.equal(absent.ebook, "not-present");
  assert.equal(absent.sentenceSync, "unsupported");
  assert.deepEqual(absent.missingFiles, []);
  const pdf = { ...epub, extension: "pdf", url: "/pdf" };
  const unsupported = await readiness({ ...book, readingFile: pdf, companions: [{ ...pdf, kind: "book", sizeBytes: 20 }], syncFile: null }, stored);
  assert.equal(unsupported.ebook, "unsupported");
  assert.equal(unsupported.sentenceSync, "unsupported");
  assert.deepEqual(unsupported.missingFiles, []);
  stored.set("sync", new Blob([JSON.stringify({ ...map, precision: "chapter" })]));
  const chapter = await readiness(book, stored);
  assert.equal(chapter.sentenceSync, "unsupported");
  assert.deepEqual(chapter.missingFiles, []);
  stored.set("sync", new Blob(["broken JSON"]));
  assert.equal((await readiness(book, stored)).sentenceSync, "missing");
  stored.set("sync", new Blob([JSON.stringify(map)]));
  stored.delete("companion:ebook");
  assert.equal((await readiness(book, stored)).sentenceSync, "needs-ebook");
});
