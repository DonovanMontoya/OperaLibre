import assert from "node:assert/strict";
import { test } from "node:test";
import { narrationTextOffset, pageTurnAtEdge } from "../src/readerPagination.ts";
import type { SyncFragment } from "../src/types.ts";

const fragment: SyncFragment = {
  text: "One two three four", href: "chapter.xhtml", startSeconds: 10, endSeconds: 20,
  words: [[10, 11, 0, 3], [12, 13, 4, 3], [15, 16, 8, 5], [18, 20, 14, 4]]
};

test("page turns own a generous outer margin at phone and unfolded widths, capped so a wide screen still leaves most of the page to sentence taps", () => {
  for (const width of [320, 466, 669, 951]) {
    const edge = Math.min(80, width * 0.15);
    assert.equal(pageTurnAtEdge(12, width), "prev");
    assert.equal(pageTurnAtEdge(width - 12, width), "next");
    assert.equal(pageTurnAtEdge(edge - 1, width), "prev");
    assert.equal(pageTurnAtEdge(width - edge + 1, width), "next");
    for (const fraction of [0.3, 0.4, 0.5, 0.6, 0.7]) assert.equal(pageTurnAtEdge(width * fraction, width), null);
  }
  // The widest screens don't hand over more than 80px, or the reading area
  // in the middle would shrink too far.
  assert.equal(pageTurnAtEdge(81, 951), null);
  assert.equal(pageTurnAtEdge(870, 951), null);
  assert.equal(pageTurnAtEdge(-1, 466), null);
  assert.equal(pageTurnAtEdge(467, 466), null);
});

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

test("the follow lead advances word-driven page turns as well as sentence selection", () => {
  assert.equal(narrationTextOffset(fragment, 14.6), 4);
  assert.equal(narrationTextOffset(fragment, 14.6, 0.5), 8);
  assert.equal(narrationTextOffset(fragment, 14.6, -2), 4);
  assert.equal(narrationTextOffset(fragment, 14.6, Infinity), 4);
});

test("invalid word offsets fall back without addressing outside the sentence", () => {
  assert.equal(narrationTextOffset({ ...fragment, words: [[10, 20, 200, 4]] }, 15), 8);
  assert.equal(narrationTextOffset(fragment, NaN), 0);
});
