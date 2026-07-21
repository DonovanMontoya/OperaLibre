import assert from "node:assert/strict";
import test from "node:test";
import { displayBookDescription, enrichBooksFromLibation } from "../src/bookMetadata.ts";
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

test("a real tag or manual description wins over catalog metadata", () => {
  const manual = { ...book, description: "A hand-edited description." };
  assert.equal(enrichBooksFromLibation([manual], [catalogBook])[0], manual);
});

test("track-name comments are not displayed as book descriptions", () => {
  assert.equal(displayBookDescription({ ...book, description: "Opening Credits" }), null);
});
