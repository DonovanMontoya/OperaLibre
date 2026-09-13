import { test } from "node:test";
import assert from "node:assert/strict";
import { libroCoverURL, libroDownloadURL, libroPage } from "../src/libroDevicePolicy.ts";

test("cover URLs resolve against Libro securely without accepting unsafe schemes", () => {
  assert.equal(libroCoverURL("/covers/book.jpg"), "https://libro.fm/covers/book.jpg");
  assert.equal(libroCoverURL("//images.libro.fm/book.jpg"), "https://images.libro.fm/book.jpg");
  assert.equal(libroCoverURL("http://images.libro.fm/book.jpg"), "https://images.libro.fm/book.jpg");
  for (const value of [null, "", "javascript:alert(1)", "file:///tmp/private", "https://user:pass@libro.fm/cover", "https://libro.fm:8000/cover"]) assert.equal(libroCoverURL(value), null);
});

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

test("book schema errors identify the field without disclosing provider values", () => {
  const cases: [unknown, string][] = [
    [null, "record is null"],
    [{ isbn: 9780000000001.5, title: "Private title" }, "ISBN is number"],
    [{ title: "Private title" }, "ISBN is undefined"],
    [{ isbn: "private-invalid-id", title: "Private title" }, "ISBN format: 18 characters, other characters"],
    [{ isbn: "9780000000001", title: null }, "title is null"],
  ];
  for (const [record, detail] of cases) {
    assert.throws(() => libroPage({ total_pages: 1, audiobooks: [record] }), (error: Error) => {
      assert.ok(error.message.includes(detail));
      assert.ok(!error.message.includes("Private title"));
      assert.ok(!error.message.includes("private-invalid-id"));
      assert.ok(!error.message.includes("9780000000001"));
      return true;
    });
  }
});

test("numeric provider ISBNs normalize to the same stable ID as string ISBNs", () => {
  const book = { isbn: "9780000000001", title: "A book" };
  const stringPage = libroPage({ total_pages: 1, audiobooks: [book] });
  const numericPage = libroPage({ total_pages: 1, audiobooks: [{ ...book, isbn: 9780000000001 }] });
  assert.deepEqual(numericPage, stringPage);
  assert.equal(numericPage.books[0].isbn, "9780000000001");
  for (const isbn of [NaN, Infinity, -9780000000001, 9780000000001.5, Number.MAX_SAFE_INTEGER + 1, 123, null, true, {}]) {
    assert.throws(() => libroPage({ total_pages: 1, audiobooks: [{ ...book, isbn }] }));
  }
});
