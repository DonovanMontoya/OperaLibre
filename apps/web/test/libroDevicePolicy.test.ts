import { test } from "node:test";
import assert from "node:assert/strict";
import { libroDownloadURL, libroPage } from "../src/libroDevicePolicy.ts";

test("device Libro downloads allow only HTTPS provider hosts", () => {
  for (const host of ["libro.fm", "assets.libro.fm", "books.s3.amazonaws.com", "example.cloudfront.net"]) {
    assert.equal(libroDownloadURL(`https://${host}/book.m4b?signature=fixture`), `https://${host}/book.m4b?signature=fixture`);
  }
  for (const url of ["http://libro.fm/file", "https://libro.fm.evil.test/file", "https://localhost/file", "https://libro.fm:8000/file", "https://user:password@libro.fm/file", "file:///tmp/book", null]) {
    assert.throws(() => libroDownloadURL(url));
  }
});

test("empty device catalogs are valid and optional metadata is normalized", () => {
  assert.deepEqual(libroPage({ total_pages: 0, audiobooks: [] }), { pages: 0, books: [] });
  const result = libroPage({ total_pages: 1, audiobooks: [{ isbn: "9780000000001", title: "A book", authors: null, audiobook_info: null }] });
  assert.deepEqual(result.books[0].authors, []);
  assert.deepEqual(result.books[0].audiobook_info, { narrators: [], duration: null });
  assert.equal(result.books[0].localBookId, null);
});

test("device catalogs reject malformed responses and oversized page counts", () => {
  for (const value of [null, {}, { total_pages: 201, audiobooks: [] }, { total_pages: 1.5, audiobooks: [] },
    { total_pages: 1, audiobooks: [{ isbn: "../../secret", title: "Book" }] },
    { total_pages: 1, audiobooks: [{ isbn: "9780000000001", title: null }] }]) {
    assert.throws(() => libroPage(value));
  }
});
