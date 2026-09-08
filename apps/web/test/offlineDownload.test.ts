import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadWebBook } from "../src/offlineDownload.ts";
import type { Book, CompanionFile, Track } from "../src/types";

const book = {
  tracks: [{ id: "t1", title: "Track one", streamUrl: "/audio" } as Track],
  coverArtUrl: "/cover",
  companions: [{ id: "epub", url: "/book.epub" } as CompanionFile],
  syncFile: null
} satisfies Pick<Book, "tracks" | "coverArtUrl" | "companions" | "syncFile">;

test("cover failures keep downloaded audio and continue to companions", async (t) => {
  for (const failure of ["network", "body", "storage", "http"]) {
    const stored = new Map<string, Blob>();
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url === "/cover") {
        if (failure === "network") throw new TypeError("disconnected");
        if (failure === "http") return new Response(null, { status: 404 });
        if (failure === "body") return new Response(new ReadableStream({
          start(controller) { controller.error(new TypeError("truncated cover")); }
        }));
      }
      return new Response(url);
    });
    await downloadWebBook(book, (url) => url, async (key, blob) => {
      if (key === "cover" && failure === "storage") throw new Error("quota exceeded");
      stored.set(key, blob);
    }, async (key) => { stored.delete(key); }, () => {});
    assert.equal(await stored.get("track:t1")?.text(), "/audio", failure);
    assert.equal(await stored.get("companion:epub")?.text(), "/book.epub", failure);
    assert.ok(!stored.has("cover"));
    t.mock.restoreAll();
  }
});

test("cancelling while the final track is being stored rolls it back", async (t) => {
  const controller = new AbortController();
  const stored = new Map<string, Blob>();
  t.mock.method(globalThis, "fetch", async () => new Response("audio"));
  await assert.rejects(downloadWebBook(
    { ...book, coverArtUrl: null, companions: [] }, (url) => url,
    async (key, blob) => { stored.set(key, blob); controller.abort(); },
    async (key) => { stored.delete(key); }, () => {}, controller.signal
  ), { name: "AbortError" });
  assert.equal(stored.size, 0);
});

test("cancelling during an optional cover still removes this attempt's audio", async (t) => {
  const controller = new AbortController();
  const stored = new Map<string, Blob>();
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/cover") { controller.abort(); controller.signal.throwIfAborted(); }
    return new Response(url);
  });
  await assert.rejects(downloadWebBook(book, (url) => url,
    async (key, blob) => { stored.set(key, blob); },
    async (key) => { stored.delete(key); }, () => {}, controller.signal
  ), { name: "AbortError" });
  assert.equal(stored.size, 0);
});

test("failure on a required second track removes the first track", async (t) => {
  const stored = new Map<string, Blob>();
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url === "/audio" ? new Response("audio") : new Response(null, { status: 503 }));
  await assert.rejects(downloadWebBook({
    ...book, tracks: [...book.tracks, { ...book.tracks[0], id: "t2", streamUrl: "/second" }]
  }, (url) => url,
    async (key, blob) => { stored.set(key, blob); },
    async (key) => { stored.delete(key); }, () => {}
  ), /503/);
  assert.equal(stored.size, 0);
});
