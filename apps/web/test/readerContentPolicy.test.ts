import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readerContentPolicy, restrictEpubContent } from "../src/readerContentPolicy.ts";

const source = "https://books.example/prefix/api/books/book/companions/epub?token=media";

test("a streamed book may load from its own server and nowhere else", () => {
  const streamed = readerContentPolicy(source);
  assert.match(streamed, /^default-src 'none';/);
  assert.match(streamed, /img-src data: blob: https:\/\/books\.example;/);
  // Page markup never carries the media token or the proxy path.
  assert.doesNotMatch(streamed, /token|prefix/);
  assert.doesNotMatch(readerContentPolicy(), /https?:/);
});

test("the policy leads the page and keeps the resource URLs epub.js substituted", async () => {
  const Hook = createRequire(import.meta.url)("epubjs/lib/utils/hook.js").default;
  const hooks = { content: new Hook(), serialize: new Hook() };
  // epub.js registers its substitution while the book opens, and writes the
  // page from the markup it was handed.
  hooks.serialize.register((output: string, section: { output: string }) => {
    section.output = output.replace("cover.png", "blob:cover");
  });
  restrictEpubContent({ spine: { hooks } } as unknown as Parameters<typeof restrictEpubContent>[0]);
  const section = { output: '<html><img src="https://tracker.example/a.png"/><head/><body><img src="cover.png"/></body></html>' };
  await hooks.serialize.trigger(section.output, section);
  assert.equal(section.output,
    `<meta http-equiv="Content-Security-Policy" content="${readerContentPolicy()}">`
    + '<html><img src="https://tracker.example/a.png"/><head/><body><img src="blob:cover"/></body></html>');
});
