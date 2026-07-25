import test from "node:test";
import assert from "node:assert/strict";
import { buildChapterSegments } from "../src/chapters.ts";
import type { Chapter } from "../src/types.ts";

const chapters: Chapter[] = [
  {
    id: "one",
    title: "One",
    trackId: "track",
    trackIndex: 0,
    startSeconds: 0,
    endSeconds: null,
    source: "test"
  },
  {
    id: "two",
    title: "Two",
    trackId: "track",
    trackIndex: 0,
    startSeconds: 90,
    endSeconds: 240,
    source: "test"
  },
  {
    id: "three",
    title: "Three",
    trackId: "track",
    trackIndex: 0,
    startSeconds: 240,
    endSeconds: null,
    source: "test"
  }
];

test("chapter segments expose chapter length instead of cumulative book position", () => {
  const segments = buildChapterSegments(chapters, 360);

  assert.deepEqual(
    segments.map(({ startSeconds, endSeconds, durationSeconds }) => ({
      startSeconds,
      endSeconds,
      durationSeconds
    })),
    [
      { startSeconds: 0, endSeconds: 90, durationSeconds: 90 },
      { startSeconds: 90, endSeconds: 240, durationSeconds: 150 },
      { startSeconds: 240, endSeconds: 360, durationSeconds: 120 }
    ]
  );
});
