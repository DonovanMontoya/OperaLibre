import assert from "node:assert/strict";
import { test } from "node:test";
import { coveragePercent, gradeLabel, gradeTone, groupSyncedBooks, needsAttention, sortChapters } from "../src/syncQuality.ts";
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
