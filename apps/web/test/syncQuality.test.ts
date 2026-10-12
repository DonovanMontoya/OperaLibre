import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canRerunChapter, chapterFailure, chapterNames, coveragePercent, gradeLabel, gradeTone, groupSyncedBooks, needsAttention,
  sortChapters, syncJobAttention, syncJobScope,
} from "../src/syncQuality.ts";
import type { SyncChapterReport, SyncGrade } from "../src/types.ts";

function book(title: string, grade?: SyncGrade, flagged = 0) {
  return {
    title,
    syncFile: { source: "generated", fileName: "map.json", url: "/sync", quality: grade ? { grade, flagged } : undefined },
  };
}

function chapter(index: number, grade: SyncGrade | null, textCoverage: number): SyncChapterReport {
  return {
    index, label: `Chapter ${index}`, startSeconds: index * 100, endSeconds: index * 100 + 100,
    textCoverage, gapSeconds: 0, skippedText: 0, status: grade ? "aligned" : "empty", grade,
  };
}

test("grades map to labels and the existing state tones", () => {
  assert.deepEqual(
    (["good", "review", "poor", "failed"] as const).map((grade) => [gradeLabel(grade), gradeTone(grade)]),
    [["Good", "done"], ["Review", "queued"], ["Poor", "failed"], ["Failed", "failed"]],
  );
  assert.equal(gradeLabel("future-grade"), "Review");
});

test("poor and failed books need attention, worst and most flagged first", () => {
  const books = [
    book("Alpha", "poor", 1),
    book("Beta", "good"),
    book("Gamma", "failed", 1),
    book("Delta", "poor", 4),
    book("Epsilon"),
    book("Zeta", "review", 2),
  ];
  assert.equal(needsAttention(books[1]), false);
  assert.equal(needsAttention(books[4]), false);
  const { attention, synced } = groupSyncedBooks(books);
  assert.deepEqual(attention.map((entry) => entry.title), ["Gamma", "Delta", "Alpha"]);
  assert.deepEqual(synced.map((entry) => entry.title), ["Beta", "Epsilon", "Zeta"]);
});

test("chapters list the worst first, then book order, with textless chapters last", () => {
  const sorted = sortChapters([
    chapter(0, null, 1),
    chapter(1, "good", 0.99),
    chapter(2, "poor", 0.7),
    chapter(3, "review", 0.9),
    chapter(4, "poor", 0.4),
    chapter(5, "good", 0.96),
  ]);
  assert.deepEqual(sorted.map((entry) => entry.index), [4, 2, 3, 1, 5, 0]);
});

test("coverage never rounds a gap up to a full chapter", () => {
  assert.equal(coveragePercent({ textCoverage: 0.999 }), "99%");
  assert.equal(coveragePercent({ textCoverage: 1 }), "100%");
  assert.equal(coveragePercent({ textCoverage: 0.29 }), "29%");
});

test("only graded chapters below good can be re-run", () => {
  assert.deepEqual(
    [chapter(0, null, 1), chapter(1, "good", 1), chapter(2, "review", 0.9), chapter(3, "poor", 0.5), chapter(4, "failed", 0)].map(canRerunChapter),
    [false, false, true, true, true],
  );
});

test("a failed chapter says what readers get and why", () => {
  assert.equal(chapterFailure(chapter(1, "good", 1)), null);
  assert.equal(
    chapterFailure({ status: "kept-previous", error: "Alignment of `Chapter 39` stopped without writing a result." }),
    "Kept its earlier timing. Alignment of `Chapter 39` stopped without writing a result.",
  );
  assert.equal(chapterFailure({ status: "failed", error: null }), "Left unhighlighted.");
});

test("job cards name re-run chapters and the ones a sync could not align", () => {
  const named = (...indices: number[]) => indices.map((index) => ({ index, label: `Chapter ${index}` }));
  assert.equal(chapterNames(named(3)), "Chapter 3");
  assert.equal(chapterNames(named(3, 7)), "Chapter 3 and Chapter 7");
  assert.equal(chapterNames(named(3, 7, 9)), "Chapter 3, Chapter 7 and Chapter 9");
  assert.equal(chapterNames(named(1, 2, 3, 4, 5, 6)), "Chapter 1, Chapter 2 and 4 more");

  assert.equal(syncJobScope({ status: "queued" }, "Yumi"), null);
  assert.equal(syncJobScope({ status: "running", chapters: named(39) }, "Yumi"), "Re-running Chapter 39 of Yumi");
  assert.equal(syncJobScope({ status: "completed", chapters: named(39) }, "Yumi"), "Re-run of Chapter 39");

  assert.equal(syncJobAttention({ status: "completed" }), null);
  assert.equal(syncJobAttention({ status: "completed", failedChapters: [] }), null);
  assert.equal(syncJobAttention({ status: "completed", failedChapters: named(55) }), "Completed · 1 chapter needs attention: Chapter 55");
  assert.equal(
    syncJobAttention({ status: "completed", failedChapters: named(3, 7) }),
    "Completed · 2 chapters need attention: Chapter 3 and Chapter 7",
  );
  // A failed job reports its own error instead.
  assert.equal(syncJobAttention({ status: "failed", failedChapters: named(3) }), null);
});
