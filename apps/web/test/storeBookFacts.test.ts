import assert from "node:assert/strict";
import test from "node:test";
import { groupAudibleBooks } from "../src/audibleBooks.ts";
import { audibleBookFacts, libroBookFacts } from "../src/storeBookFacts.ts";
import type { LibationBook } from "../src/types.ts";

const audible = (profileId: string, profileName: string, overrides: Partial<LibationBook> = {}): LibationBook => ({
  catalogId: `${profileId}:B0STORE`, profileId, profileName, accountId: null, asin: "B0STORE", title: "The Store Book",
  subtitle: "  A Novel ", authors: "Ann Author", narrators: "", lengthMinutes: 125, description: "<p>A <b>tale</b> of&nbsp;two&amp;more.</p>",
  publisher: "Fixture House", bookStatus: null, pdfStatus: null, contentType: null, locale: "us", lastDownloaded: null,
  isAudiblePlus: false, coverArtUrl: null, localBookId: null, ...overrides
});

test("Audible details read as plain text and list every owning account", () => {
  const [book] = groupAudibleBooks([audible("personal", "Personal"), audible("family", "family@example.test")]);
  const facts = audibleBookFacts(book, id => id === "family" ? "Family" : undefined);
  assert.equal(facts.description, "A tale of two&more.");
  assert.equal(facts.subtitle, "A Novel");
  assert.equal(facts.narrator, null);
  assert.equal(facts.runtimeSeconds, 125 * 60);
  assert.deepEqual(facts.accounts, ["Personal", "Family"]);
  assert.deepEqual(facts.identifier, { label: "ASIN", value: "B0STORE" });
});

test("Libro.fm details hide a description that only repeats the title", () => {
  const facts = libroBookFacts({
    isbn: "9780000000001", title: "Libro Book", authors: ["One", " ", "Two"], cover_url: null,
    audiobook_info: { narrators: [], duration: 3600 }, description: " libro book ", localBookId: null
  }, "Personal");
  assert.equal(facts.description, null);
  assert.equal(facts.author, "One, Two");
  assert.equal(facts.narrator, null);
  assert.equal(facts.runtimeSeconds, 3600);
  assert.deepEqual(facts.accounts, ["Personal"]);
});
