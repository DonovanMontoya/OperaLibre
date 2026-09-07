import assert from "node:assert/strict";
import { test } from "node:test";
import { narrationTextOffset } from "../src/readerPagination.ts";
import type { SyncFragment } from "../src/types.ts";

const fragment: SyncFragment = {
  text: "One two three four", href: "chapter.xhtml", startSeconds: 10, endSeconds: 20,
  words: [[10, 11, 0, 3], [12, 13, 4, 3], [15, 16, 8, 5], [18, 20, 14, 4]]
};

test("a sentence crossing pages follows its spoken word before the sentence ends", () => {
  // Page two begins with 'three', page three with 'four'.
  const page = (time: number) => {
    const offset = narrationTextOffset(fragment, time);
    return offset >= 14 ? 3 : offset >= 8 ? 2 : 1;
  };
  assert.equal(page(10), 1);
  assert.equal(page(14), 1);
  assert.equal(page(15), 2);
  assert.equal(page(18), 3);
  assert.equal(page(12), 1); // A backwards seek within the same sentence.
});

test("sentence-only maps advance during the sentence and clamp outside its times", () => {
  const estimated = { ...fragment, words: undefined };
  assert.equal(narrationTextOffset(estimated, 9), 0);
  assert.equal(narrationTextOffset(estimated, 15), 8);
  assert.equal(narrationTextOffset(estimated, 19), 14);
  assert.equal(narrationTextOffset(estimated, 30), 14);
  assert.equal(narrationTextOffset({ ...estimated, endSeconds: 10 }, 11), 0);
});

test("invalid word offsets fall back without addressing outside the sentence", () => {
  assert.equal(narrationTextOffset({ ...fragment, words: [[10, 20, 200, 4]] }, 15), 8);
  assert.equal(narrationTextOffset(fragment, NaN), 0);
});
