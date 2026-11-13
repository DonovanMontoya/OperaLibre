import assert from "node:assert/strict";
import test from "node:test";
import { displayBookDescription, displayPublishedDate, enrichBooksFromLibation } from "../src/bookMetadata.ts";
import type { Book, LibationBook } from "../src/types.ts";

const book = {
  id: "local-book",
  title: "The Great Gatsby",
  description: null,
  asin: "B00GATSBY1",
  tracks: [{ title: "Opening Credits" }],
  chapters: [],
  metadata: { description: null }
} as Book;

const catalogBook = {
  asin: "B00GATSBY1",
  localBookId: "local-book",
  description: "<p>A portrait of longing &amp; reinvention.</p>"
} as LibationBook;

test("matched Audible descriptions enrich the corresponding local book only", () => {
  const other = { ...book, id: "other-book", title: "Other Book", asin: "B00OTHER01" };
  const enriched = enrichBooksFromLibation([book, other], [catalogBook]);
  assert.equal(enriched[0].description, "A portrait of longing & reinvention.");
  assert.equal(enriched[0].metadata.description, enriched[0].description);
  assert.equal(enriched[1].description, null);
});

test("catalog descriptions cannot reconstruct HTML from encoded or malformed markup", () => {
  for (const description of [
    "&lt;scrip&lt;script&gt;ignored&lt;/script&gt;t&gt;alert(1)&lt;/script&gt;",
    "&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;"
  ]) {
    const catalog = { ...catalogBook, description };
    const [enriched] = enrichBooksFromLibation([book], [catalog]);
    assert.doesNotMatch(enriched.description ?? "", /[<>]/);
  }
});

test("a real tag or manual description wins over catalog metadata", () => {
  const manual = { ...book, description: "A hand-edited description." };
  assert.equal(enrichBooksFromLibation([manual], [catalogBook])[0], manual);
});

test("track-name comments are not displayed as book descriptions", () => {
  assert.equal(displayBookDescription({ ...book, description: "Opening Credits" }), null);
});

test("nonbreaking-space placeholders are treated as missing descriptions", () => {
  for (const description of [
    "&nbsp;", "&nbsp", " &#160; ", "&#xA0;", "\u00a0",
    "&amp;nbsp;", "&amp;amp;nbsp;", "&nbsp;&nbsp;\n&#160;"
  ]) {
    const placeholder = { ...book, description };
    assert.equal(displayBookDescription(placeholder), null, description);
    const [enriched] = enrichBooksFromLibation([placeholder], [catalogBook]);
    assert.equal(enriched.description, "A portrait of longing & reinvention.", description);
  }
});

test("description spaces are decoded without losing text or paragraph breaks", () => {
  const description = "A&nbsp;portrait&#160;of&#xa0;longing.\n\nLove &amp; reinvention.";
  assert.equal(
    displayBookDescription({ ...book, description }),
    "A portrait of longing.\n\nLove &amp; reinvention."
  );
  assert.equal(displayBookDescription({ ...book, description: "Opening&nbsp;Credits" }), null);
});

test("blank catalog placeholders do not replace missing metadata", () => {
  for (const description of ["<p>&nbsp;</p>", "&amp;nbsp;", "&#xA0;", "&nbsp"]) {
    const books = [book];
    assert.equal(enrichBooksFromLibation(books, [{ ...catalogBook, description }]), books);
  }
});

test("HTML stored in a book's description displays as plain paragraphs", () => {
  const description = "<p><b>The brand-new Miss Marple mystery from #1 <i>New York Times</i> author.</b></p>"
    + "<p><i>The notorious actress.</i><br><i>The society wife.</i></p>\n<p>Who&#39;s next&hellip;</p>";
  assert.equal(
    displayBookDescription({ ...book, description }),
    "The brand-new Miss Marple mystery from #1 New York Times author.\n\n"
      + "The notorious actress.\nThe society wife.\n\nWho's next\u2026"
  );
});

test("published timestamps display as a calendar date without shifting the day", () => {
  const expected = new Date(Date.UTC(2026, 8, 22)).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });
  assert.equal(displayPublishedDate("2026-09-22T00:00:00.000Z"), expected);
  assert.equal(displayPublishedDate("2026-09-22"), expected);
  assert.equal(displayPublishedDate("1865"), "1865");
  assert.equal(displayPublishedDate("  "), null);
});
