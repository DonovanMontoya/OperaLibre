import test from "node:test";
import assert from "node:assert/strict";
import { buildChapterSegments, chapterAtBookPosition } from "../src/chapters.ts";
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

test("a position inside a chapter resolves to that chapter", () => {
  const segments = buildChapterSegments(chapters, 360);
  assert.equal(chapterAtBookPosition(segments, 0)?.title, "One");
  assert.equal(chapterAtBookPosition(segments, 89.9)?.title, "One");
  assert.equal(chapterAtBookPosition(segments, 90)?.title, "Two");
  assert.equal(chapterAtBookPosition(segments, 359)?.title, "Three");
  // Past the last marker still belongs to the closing chapter.
  assert.equal(chapterAtBookPosition(segments, 100_000)?.title, "Three");
  assert.equal(chapterAtBookPosition([], 12), null);
});

test("un-chaptered stretches never resolve to the closing chapter", () => {
  // Opening credits with no embedded markers, then a file that has them. The
  // transport scrubs relative to the active chapter's start, so reporting the
  // last chapter here would turn one drag into a jump to the end of the book.
  const late: Chapter[] = [
    { ...chapters[0], id: "late-one", title: "One", startSeconds: 600, endSeconds: 900 },
    { ...chapters[1], id: "late-two", title: "Two", startSeconds: 900, endSeconds: 1200 }
  ];
  const segments = buildChapterSegments(late, 1200);
  assert.equal(chapterAtBookPosition(segments, 0), null);
  assert.equal(chapterAtBookPosition(segments, 599), null);
  assert.equal(chapterAtBookPosition(segments, 600)?.title, "One");

  // A gap between two marked files keeps the chapter already in progress.
  const gapped = buildChapterSegments(
    [
      { ...chapters[0], id: "gap-one", title: "One", startSeconds: 0, endSeconds: 300 },
      { ...chapters[1], id: "gap-two", title: "Two", startSeconds: 900, endSeconds: 1200 }
    ],
    1200
  );
  assert.equal(chapterAtBookPosition(gapped, 500)?.title, "One");
});
