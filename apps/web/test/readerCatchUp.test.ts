import assert from "node:assert/strict";
import { test } from "node:test";
import { canCatchUp, catchUpChapterHref, resolveListeningCfi } from "../src/readerCatchUp.ts";
import type { Book as EpubBook } from "epubjs";

test("catch-up requires a unique chapter match, including repeated chapter numbers in different parts", () => {
  const toc = [{ href: "one.xhtml", label: "Chapter One" }, { href: "two.xhtml#start", label: "Chapter Two" }];
  assert.equal(catchUpChapterHref(toc, "Chapter 2"), "two.xhtml#start");
  assert.equal(catchUpChapterHref(toc, "Track 99"), null);
  assert.equal(catchUpChapterHref(toc, null), null);
  assert.equal(catchUpChapterHref([...toc, { href: "part-two.xhtml", label: "Chapter Two" }], "Chapter 2"), null);
  assert.equal(catchUpChapterHref([...toc, toc[1]], "Chapter 2"), "two.xhtml#start");
});

test("catch-up only moves forward from an existing reading place", () => {
  const compare = (a: string, b: string) => Number(a) - Number(b);
  assert.equal(canCatchUp("12", "20", compare), true);
  assert.equal(canCatchUp("25", "20", compare), false);
  assert.equal(canCatchUp("20", "20", compare), false);
  assert.equal(canCatchUp(null, "20", compare), false);
  assert.equal(canCatchUp("12", null, compare), false);
  assert.equal(canCatchUp("12", "bad", compare), false);
  assert.equal(canCatchUp("12", "20", () => { throw new Error("invalid CFI"); }), false);
});

test("chapter resolution uses the loaded document and respects in-document chapter anchors", async () => {
  const heading = { id: "chapter-two" };
  const body = { id: "body" };
  const section = {
    // The real library returns a root element, not a Document.
    load: async () => ({ tagName: "html" }),
    document: { body, getElementById: (id: string) => id === heading.id ? heading : null },
    cfiFromElement: (element: { id: string }) => `cfi:${element.id}`
  };
  const book = { spine: { get: () => section }, load: async () => undefined } as unknown as EpubBook;
  assert.equal(await resolveListeningCfi(book, [{ href: "book.xhtml#chapter-two", label: "Chapter 2" }], "Chapter 2"), "cfi:chapter-two");
  assert.equal(await resolveListeningCfi(book, [{ href: "book.xhtml", label: "Chapter 2" }], "Chapter 2"), "cfi:body");
  assert.equal(await resolveListeningCfi(book, [{ href: "book.xhtml#missing", label: "Chapter 2" }], "Chapter 2"), null);
});
