import assert from "node:assert/strict";
import test from "node:test";
import { epubEntryUrl, prepareEpubRead, prepareStreamingEpub, streamingArchive, supportsStreamingEpub } from "../src/streamingEpub.ts";

const source = "https://books.example/prefix/api/books/book/companions/epub?token=media";

test("member URLs retain proxy prefix and media credentials, encoding archive names", () => {
  assert.equal(epubEntryUrl(source, "/OPS/My%20Image%23one.jpg"),
    "https://books.example/prefix/api/books/book/companions/epub/entries/OPS/My%20Image%23one.jpg?token=media");
  assert.throws(() => epubEntryUrl(source, "/../secret"));
  assert.equal(supportsStreamingEpub(source), true);
  assert.equal(supportsStreamingEpub("blob:https://books.example/file"), false);
  assert.equal(supportsStreamingEpub("https://jellyfin.example/book.epub"), false);
});

test("archive prepares image URLs without downloading images or the whole EPUB", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("chapter one"));
  const archive = streamingArchive(source, new AbortController().signal, "container");
  assert.equal(await archive.getText("/META-INF/container.xml"), "container");
  await archive.createUrl("/OPS/later-chapter-image.jpg");
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await archive.getText("/OPS/chapter1.xhtml"), "chapter one");
  assert.equal(fetch.mock.callCount(), 1);
  assert.match(String(fetch.mock.calls[0].arguments[0]), /entries\/OPS\/chapter1.xhtml/);
});

test("old servers fall back, but access failures are not concealed", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("", { status: 404 }));
  assert.equal(await prepareStreamingEpub(source, new AbortController().signal), null);
  fetch.mock.mockImplementation(async () => new Response("", { status: 403 }));
  await assert.rejects(prepareStreamingEpub(source, new AbortController().signal), /403/);
});

test("closing the reader cancels subsequent chapter reads", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("chapter"));
  const controller = new AbortController();
  const archive = streamingArchive(source, controller.signal, "container");
  controller.abort();
  await assert.rejects(archive.getText("/OPS/chapter.xhtml"), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 0);
});


test("a cached preview opens on a network outage without downloaded audio", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Network unavailable"); });
  const bytes = new ArrayBuffer(12);
  const prepared = await prepareEpubRead(source, new AbortController().signal, async () => bytes);
  assert.equal(prepared.data, bytes);
});

test("normal member streaming never reads a whole cached preview", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("container"));
  let cachedReads = 0;
  const prepared = await prepareEpubRead(source, new AbortController().signal, async () => {
    cachedReads += 1;
    return new ArrayBuffer(12);
  });
  assert.ok(prepared.archive);
  assert.equal(cachedReads, 0);
});

test("cached previews do not conceal HTTP denial or cancellation", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("", { status: 403 }));
  let cachedReads = 0;
  const cached = async () => { cachedReads += 1; return new ArrayBuffer(12); };
  await assert.rejects(prepareEpubRead(source, new AbortController().signal, cached), /403/);
  fetch.mock.mockImplementation(async () => { throw new TypeError("Offline"); });
  const controller = new AbortController();
  await assert.rejects(prepareEpubRead(source, controller.signal, async () => {
    controller.abort();
    return new ArrayBuffer(12);
  }), { name: "AbortError" });
  assert.equal(cachedReads, 0);
});

test("old-server whole-file fallback can still use an offline cached preview", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++requests === 1) return new Response("", { status: 404 });
    throw new TypeError("Network unavailable");
  });
  const bytes = new ArrayBuffer(12);
  assert.equal((await prepareEpubRead(source, new AbortController().signal, async () => bytes)).data, bytes);
  assert.equal(requests, 2);
});
