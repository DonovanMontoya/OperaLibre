import assert from "node:assert/strict";
import { test } from "node:test";
import { correctEarlyChapterFragments } from "../src/readerTimingCorrection.ts";
import type { Chapter, SyncFragment } from "../src/types.ts";

const chapters: Chapter[] = [
  { id: "image", title: "Part Four: Alethi Glyphs Page 2", trackId: "a", trackIndex: 0,
    startSeconds: 100, endSeconds: 300, source: "embedded" },
  { id: "text", title: "Part Four: 73. Which Master to Follow", trackId: "a", trackIndex: 0,
    startSeconds: 300, endSeconds: 500, source: "embedded" }
];
const fragments: SyncFragment[] = [
  { href: "before.html", text: "Before", startSeconds: 80, endSeconds: 99 },
  { href: "text.html", text: "First", startSeconds: 100, endSeconds: 110,
    words: [[101, 109, 0, 5]] },
  { href: "text.html", text: "Last", startSeconds: 480, endSeconds: 502 }
];
const toc = [{ href: "text.html", label: "73. Which Master to Follow" }];

test("moves a text chapter aligned across a narrated picture back to its audio marker", () => {
  const result = correctEarlyChapterFragments(fragments, chapters, toc);
  assert.notEqual(result, fragments);
  assert.equal(result[0], fragments[0]);
  assert.equal(result[1].startSeconds, 300);
  assert.equal(result[2].endSeconds, 500);
  assert.equal(result[1].words?.[0][0], 300 + (101 - 100) * 200 / 402);
  assert.equal(fragments[1].startSeconds, 100);
});

test("leaves ambiguous or already bounded maps untouched", () => {
  assert.equal(correctEarlyChapterFragments(fragments, chapters, [...toc, ...toc]), fragments);
  assert.equal(correctEarlyChapterFragments(fragments, chapters, [{ href: "other.html", label: toc[0].label }]), fragments);
  assert.equal(correctEarlyChapterFragments(fragments, [chapters[0], { ...chapters[1], startSeconds: 110 }], toc), fragments);
  assert.equal(correctEarlyChapterFragments(fragments, [chapters[0], { ...chapters[1], endSeconds: 550 }], toc), fragments);
});
