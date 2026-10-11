import assert from "node:assert/strict";
import test from "node:test";
import { readerContentPolicy } from "../src/readerContentPolicy.ts";

const source = "https://books.example/prefix/api/books/book/companions/epub?token=media";

test("a streamed book may load from its own server and nowhere else", () => {
  const streamed = readerContentPolicy(source);
  assert.match(streamed, /^default-src 'none';/);
  assert.match(streamed, /img-src data: blob: https:\/\/books\.example;/);
  // Page markup never carries the media token or the proxy path.
  assert.doesNotMatch(streamed, /token|prefix/);
  assert.doesNotMatch(readerContentPolicy(), /https?:/);
});
