import assert from "node:assert/strict";
import test from "node:test";
import { groupAudibleBooks } from "../src/audibleBooks.ts";
import type { LibationBook } from "../src/types.ts";

const book = (profileId: string, asin = "B000SHAR00", localBookId: string | null = null): LibationBook => ({
  catalogId: `${profileId}:${asin}`, profileId, profileName: profileId,
  accountId: null, asin, title: "Shared book", subtitle: null, authors: null,
  narrators: null, lengthMinutes: null, description: null, publisher: null,
  bookStatus: null, pdfStatus: null, contentType: null, locale: null,
  lastDownloaded: null, isAudiblePlus: false, coverArtUrl: null, localBookId
});

test("shared Audible books have one row with all owners and local availability", () => {
  const input = [book("Dad"), book("Marge", "b000shar00", "local-book"), book("Veterans"), book("Dad")];
  const rows = groupAudibleBooks(input);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].accounts.map(account => account.profileName), ["Dad", "Marge", "Veterans"]);
  assert.equal(rows[0].localBookId, "local-book");
  assert.equal(input[0].localBookId, null);
  assert.equal(rows.filter(row => row.accounts.some(account => account.profileId === "Marge")).length, 1);
});

test("different Audible editions remain separate even with identical titles", () => {
  assert.equal(groupAudibleBooks([book("Dad"), book("Marge", "B000OTHER0")]).length, 2);
  assert.deepEqual(groupAudibleBooks([]), []);
});
