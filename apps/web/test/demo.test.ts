import assert from "node:assert/strict";
import test from "node:test";
import { demoContentIsSelfContained, getDemoBooks } from "../src/demo.ts";

test("demo content is entirely local and carries no store identifiers", () => {
  assert.equal(demoContentIsSelfContained(), true);
  for (const book of getDemoBooks()) {
    assert.equal(book.asin, null);
    assert.match(book.description ?? "", /original|procedural/i);
    assert.ok(book.tracks.length > 0);
  }
});
