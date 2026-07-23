import assert from "node:assert/strict";
import test from "node:test";
import {
  demoContentIsSelfContained,
  getDemoBooks,
  setDemoBookCompletion
} from "../src/demo.ts";

test("demo content is entirely local and carries no store identifiers", () => {
  assert.equal(demoContentIsSelfContained(), true);
  for (const book of getDemoBooks()) {
    assert.equal(book.asin, null);
    assert.match(book.description ?? "", /original|procedural/i);
    assert.ok(book.tracks.length > 0);
  }
});

test("demo books can be marked finished and unfinished without seeking", () => {
  const book = getDemoBooks()[0];
  assert.ok(book);
  const finished = setDemoBookCompletion(book, true);
  assert.equal(finished.status, "finished");
  assert.equal(finished.bookPositionSeconds, 0);

  const unfinished = setDemoBookCompletion(book, false);
  assert.equal(unfinished.status, "notStarted");
  assert.equal(unfinished.bookPositionSeconds, 0);
});
