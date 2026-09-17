import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { revalidatedCompanion } from "../src/companionCache.ts";
import { attachEpubReadArchive, attachStreamingArchive, epubEntryUrl, prepareEpubRead, prepareStreamingEpub, streamingArchive, supportsStreamingEpub } from "../src/streamingEpub.ts";

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

test("streaming substitutions replace overlapping names once in chapters and CSS", async (t) => {
  const require = createRequire(import.meta.url);
  const Resources = require("epubjs/lib/resources.js").default;
  const Book = require("epubjs/lib/book.js").default;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const names = ["a.jpg", "aa.jpg", "images/a.jpg", "epub", "media", "prefix", "it's(1).png", "style.css"];
  const css = `a{background:url('aa.jpg')}b{background:url("it's(1).png")}c{background:url(images/a.jpg)}`;
  const originalFetch = globalThis.fetch;
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(css));
  const archive = streamingArchive(source, new AbortController().signal, "container");
  const resolve = (href: string) => posix.resolve("/OPS", href);
  const resources = new Resources(Object.fromEntries(names.map((href, index) => [String(index), {
    href, type: href.endsWith(".css") ? "text/css" : "image/png"
  }])), { archive, resolver: resolve, replacements: "blobUrl" });
  const hooks: Array<(output: string, section: { url: string; output?: string }) => void> = [];
  const book = {
    resources, resolve,
    replacements: Book.prototype.replacements,
    spine: { hooks: { serialize: { register: (hook: typeof hooks[number]) => hooks.push(hook) } } }
  };
  attachStreamingArchive(book as unknown as Parameters<typeof attachStreamingArchive>[0], archive);
  await book.replacements();
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(String(fetch.mock.calls[0].arguments[0]), epubEntryUrl(source, "/OPS/style.css"));
  const section = { url: "/OPS/chapter.xhtml", output: "" };
  const images = names.slice(0, -1);
  hooks[0](images.map((name) => `<img src="${name}"/>`).join(""), section);
  assert.equal(section.output, images.map((name) => `<img src="${epubEntryUrl(source, resolve(name))}"/>`).join(""));
  assert.equal(resources.substitute("aa.jpg a.jpg", "/OPS/chapter.xhtml"),
    `${epubEntryUrl(source, "/OPS/aa.jpg")} ${epubEntryUrl(source, "/OPS/a.jpg")}`);
  const cssUrl = resources.replacementUrls[names.indexOf("style.css")];
  const rewritten = await (await originalFetch(cssUrl)).text();
  assert.equal(rewritten,
    `a{background:url('${epubEntryUrl(source, "/OPS/aa.jpg")}')}b{background:url("${epubEntryUrl(source, "/OPS/it's(1).png")}")}c{background:url(${epubEntryUrl(source, "/OPS/images/a.jpg")})}`);
  assert.match(rewritten, /it%27s%281%29\.png/);
  archive.destroy();
  await assert.rejects(originalFetch(cssUrl));
});

test("member URL punctuation is safe in quoted and unquoted CSS URLs", async () => {
  const archive = streamingArchive(source, new AbortController().signal, "container");
  const url = await archive.createUrl("/OPS/it's(1)!*.png");
  assert.equal(url, "https://books.example/prefix/api/books/book/companions/epub/entries/OPS/it%27s%281%29%21%2A.png?token=media");
  assert.equal(decodeURIComponent(new URL(url).pathname.split("/entries/")[1]), "OPS/it's(1)!*.png");
});

test("old servers fall back, but access failures are not concealed", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("", { status: 404 }));
  assert.equal(await prepareStreamingEpub(source, new AbortController().signal), null);
  fetch.mock.mockImplementation(async () => new Response("", { status: 403 }));
  await assert.rejects(prepareStreamingEpub(source, new AbortController().signal), /403/);
});

test("a legacy media-token probe retries the authenticated whole-file URL", async (t) => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal(new URL(url).searchParams.get("token"), "media");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return url.includes("/entries/")
      ? new Response("", { status: 401 }) : new Response(bytes);
  });
  let saved: ArrayBuffer | null = null;
  const prepared = await prepareEpubRead(source, new AbortController().signal,
    async () => { assert.fail("A successful retry must not use cached bytes"); },
    (url, signal) => revalidatedCompanion(url, async () => null, async (data) => { saved = data; }, signal));
  assert.deepEqual(prepared.data, bytes);
  assert.deepEqual(saved, bytes);
  assert.deepEqual(requests, [epubEntryUrl(source, "META-INF/container.xml"), source]);
});

for (const status of [401, 403]) {
  test(`legacy probe retry preserves whole-file HTTP ${status} without cache rescue`, async (t) => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => new Response("", { status: ++requests === 1 ? 401 : status }));
    const cached = async () => { assert.fail("An access denial must not read cached bytes"); };
    await assert.rejects(prepareEpubRead(source, new AbortController().signal, cached,
      (url, signal) => revalidatedCompanion(url, cached, async () => { assert.fail("Denied bytes must not be saved"); }, signal)),
    new RegExp(`Companion request failed with ${status}`));
    assert.equal(requests, 2);
  });
}

test("a legacy 401 probe also retries without a whole-file loader", async (t) => {
  const bytes = new Uint8Array([4, 5, 6]).buffer;
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => ++requests === 1
    ? new Response("", { status: 401 }) : new Response(bytes));
  const result = await prepareEpubRead(source, new AbortController().signal);
  assert.deepEqual(result.data, bytes);
  assert.equal(requests, 2);
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

async function cachedEpubFixture(t: TestContext) {
  const require = createRequire(import.meta.url);
  const JSZip = require("jszip");
  const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
  const Book = require("epubjs/lib/book.js").default;
  for (const [key, value] of Object.entries({
    window: { decodeURIComponent, URL }, DOMParser, XMLSerializer
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const files: Record<string, string> = {
    "META-INF/container.xml": '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    "OPS/content.opf": '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">cached</dc:identifier><dc:title>Cached</dc:title><dc:language>en</dc:language><meta property="rendition:layout">reflowable</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="image" href="image.png" media-type="image/png"/><item id="css" href="style.css" media-type="text/css"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    "OPS/nav.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc" id="toc"><ol><li><a href="chapter.xhtml">Chapter one</a></li></ol></nav></body></html>',
    "OPS/chapter.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title><link rel="stylesheet" href="style.css"/></head><body><p>Cached first chapter</p><img src="image.png"/></body></html>',
    "OPS/style.css": 'body{background-image:url("image.png")}',
    "OPS/image.png": "cached image bytes"
  };
  const zip = new JSZip();
  for (const [path, text] of Object.entries(files)) zip.file(path, text);
  const bytes: ArrayBuffer = await zip.generateAsync({ type: "arraybuffer" });
  return { Book, files, bytes };
}

for (const failedPath of ["OPS/content.opf", "OPS/nav.xhtml", "OPS/chapter.xhtml", "OPS/style.css"]) {
  test(`post-container ${failedPath} network failure recovers cached chapters and images`, { timeout: 3000 }, async (t) => {
    const { Book, files, bytes } = await cachedEpubFixture(t);
    const originalFetch = globalThis.fetch;
    const fetch = t.mock.method(globalThis, "fetch", async (url) => {
      const path = decodeURIComponent(new URL(String(url)).pathname.split("/entries/")[1]);
      if (path === failedPath) throw new TypeError("Network unavailable after container");
      assert.ok(files[path], path);
      return new Response(files[path]);
    });
    let cachedReads = 0;
    const prepared = await prepareEpubRead(source, new AbortController().signal, async () => {
      cachedReads += 1;
      return bytes;
    });
    assert.ok(prepared.archive);
    const book = new Book({ replacements: "blobUrl" });
    attachEpubReadArchive(book, prepared.archive);
    await book.open(new ArrayBuffer(0), "binary");
    await book.opened;
    assert.equal((await book.loaded.navigation).toc[0].label, "Chapter one");
    const output = await book.section(0).render(book.load.bind(book));
    assert.match(output, /Cached first chapter/);
    assert.doesNotMatch(output, /books\.example/);
    const imageUrl = book.resources.replacementUrls[book.resources.urls.indexOf("image.png")];
    assert.match(output, new RegExp(imageUrl));
    assert.equal(await (await originalFetch(imageUrl)).text(), "cached image bytes");
    const cssUrl = book.resources.replacementUrls[book.resources.urls.indexOf("style.css")];
    assert.equal(await (await originalFetch(cssUrl)).text(), `body{background-image:url("${imageUrl}")}`);
    assert.equal(cachedReads, 1);
    assert.ok(fetch.mock.callCount() <= 5);
    book.destroy();
    await assert.rejects(originalFetch(imageUrl));
    await assert.rejects(originalFetch(cssUrl));
  });
}

test("a network failure without a local copy does not break later streamed reads", { timeout: 3000 }, async (t) => {
  const { Book, files } = await cachedEpubFixture(t);
  let offline = false;
  t.mock.method(globalThis, "fetch", async (url) => {
    const path = decodeURIComponent(new URL(String(url)).pathname.split("/entries/")[1]);
    if (offline && path === "OPS/chapter.xhtml") throw new TypeError("Network briefly unavailable");
    assert.ok(files[path], path);
    return new Response(files[path]);
  });
  let cachedReads = 0;
  const prepared = await prepareEpubRead(source, new AbortController().signal, async () => {
    cachedReads += 1;
    return null;
  });
  assert.ok(prepared.archive);
  const book = new Book({ replacements: "blobUrl" });
  attachEpubReadArchive(book, prepared.archive);
  await book.open(new ArrayBuffer(0), "binary");
  await book.opened;
  offline = true;
  await assert.rejects(prepared.archive.getText("/OPS/chapter.xhtml"), TypeError);
  offline = false;
  assert.match(await prepared.archive.getText("/OPS/chapter.xhtml"), /Cached first chapter/);
  assert.match(await prepared.archive.createUrl("/OPS/image.png"), /books\.example/);
  assert.equal(cachedReads, 1);
  book.destroy();
});

for (const url of [source, "https://books.example/legacy.epub"]) {
  test(`whole-file loader persists legacy bytes for ${url}`, async (t) => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    let cached: ArrayBuffer | null = null;
    let loads = 0;
    let saves = 0;
    t.mock.method(globalThis, "fetch", async (input) =>
      String(input).includes("/entries/") ? new Response("", { status: 404 }) : new Response(bytes));
    const prepared = await prepareEpubRead(url, new AbortController().signal, async () => cached,
      (input, signal) => {
        loads += 1;
        assert.equal(input, url);
        return revalidatedCompanion(input, async () => cached, async (data) => {
          saves += 1;
          cached = data;
        }, signal);
      });
    assert.deepEqual(prepared.data, bytes);
    assert.deepEqual(cached, bytes);
    assert.equal(loads, 1);
    assert.equal(saves, 1);
  });
}

test("successful streaming reads no cached or whole-file bytes through first chapter", { timeout: 3000 }, async (t) => {
  const { Book, files } = await cachedEpubFixture(t);
  const fetch = t.mock.method(globalThis, "fetch", async (url) => {
    const path = decodeURIComponent(new URL(String(url)).pathname.split("/entries/")[1]);
    assert.notEqual(path, "OPS/image.png");
    assert.ok(files[path], path);
    return new Response(files[path]);
  });
  const prepared = await prepareEpubRead(source, new AbortController().signal,
    async () => { assert.fail("Cache must stay lazy"); },
    async () => { assert.fail("Whole-file loader must stay lazy"); });
  assert.ok(prepared.archive);
  const book = new Book({ replacements: "blobUrl" });
  attachEpubReadArchive(book, prepared.archive);
  await book.open(new ArrayBuffer(0), "binary");
  await book.opened;
  await book.loaded.navigation;
  const output = await book.section(0).render(book.load.bind(book));
  assert.ok(output.includes(epubEntryUrl(source, "/OPS/image.png").replaceAll("&", "&amp;")));
  assert.equal(fetch.mock.callCount(), 5);
  book.destroy();
});

test("book opens without cached rescue when an optional stylesheet returns HTTP 404", { timeout: 3000 }, async (t) => {
  const { Book, files, bytes } = await cachedEpubFixture(t);
  let cachedReads = 0;
  let stylesheetReads = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    const path = decodeURIComponent(new URL(String(url)).pathname.split("/entries/")[1]);
    if (path === "OPS/style.css") {
      stylesheetReads += 1;
      return new Response("", { status: 404 });
    }
    assert.ok(files[path], path);
    return new Response(files[path]);
  });
  const prepared = await prepareEpubRead(source, new AbortController().signal, async () => {
    cachedReads += 1;
    return bytes;
  });
  assert.ok(prepared.archive);
  const book = new Book({ replacements: "blobUrl" });
  t.after(() => book.destroy());
  attachEpubReadArchive(book, prepared.archive);
  await book.open(new ArrayBuffer(0), "binary");
  await book.opened;
  const output = await book.section(0).render(book.load.bind(book));
  assert.match(output, /Cached first chapter/);
  assert.equal(book.resources.replacementUrls[book.resources.urls.indexOf("style.css")], undefined);
  assert.equal(stylesheetReads, 1);
  assert.equal(cachedReads, 0);
});

for (const status of [401, 403, 404, 500]) {
  test(`post-probe HTTP ${status} never rescues cached bytes`, { timeout: 3000 }, async (t) => {
    const { Book, files } = await cachedEpubFixture(t);
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response(files["META-INF/container.xml"]));
    const prepared = await prepareEpubRead(source, new AbortController().signal,
      async () => { assert.fail("HTTP errors must not read the cache"); });
    assert.ok(prepared.archive);
    const book = new Book({ replacements: "blobUrl" });
    attachEpubReadArchive(book, prepared.archive);
    fetch.mock.mockImplementation(async () => new Response("", { status }));
    for (const path of ["/OPS/content.opf", "/OPS/nav.xhtml", "/OPS/chapter.xhtml"]) {
      await assert.rejects(prepared.archive.request(path), new RegExp(String(status)));
    }
    prepared.archive.destroy();
    book.destroy();
  });
}

for (const action of ["abort", "destroy", "missing", "unreadable", "corrupt"]) {
  test(`post-probe recovery handles ${action} during cache loading`, { timeout: 3000 }, async (t) => {
    const { Book, files, bytes } = await cachedEpubFixture(t);
    const controller = new AbortController();
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response(files["META-INF/container.xml"]));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const prepared = await prepareEpubRead(source, controller.signal, async () => {
      started();
      await blocked;
      if (action === "unreadable") throw new Error("Cache unavailable");
      return action === "missing" ? null : action === "corrupt" ? new ArrayBuffer(1) : bytes;
    });
    assert.ok(prepared.archive);
    const book = new Book({ replacements: "blobUrl" });
    attachEpubReadArchive(book, prepared.archive);
    fetch.mock.mockImplementation(async () => { throw new TypeError("Offline"); });
    const request = prepared.archive.request("/OPS/content.opf");
    await reading;
    if (action === "abort") controller.abort();
    if (action === "destroy") prepared.archive.destroy();
    release();
    await assert.rejects(request, action === "abort" || action === "destroy"
      ? { name: "AbortError" } : action === "corrupt" ? /zip/i : /Offline/);
    prepared.archive.destroy();
    book.destroy();
  });
}
