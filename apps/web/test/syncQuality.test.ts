import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAUSES, canRerunChapter, causeCopy, chapterNames, chapterProblem, coveragePercent, gradeLabel, gradeTone, groupSyncedBooks,
  jobProblem, needsAttention, sortChapters, syncJobAttention, syncJobScope,
} from "../src/syncQuality.ts";
import type { SyncCause, SyncChapterReport, SyncDiagnosis, SyncGrade } from "../src/types.ts";

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

test("every cause a server reports reads in plain words", () => {
  const causes: SyncCause[] = [
    "runtime-crash", "noisy-audio", "chapter-mismatch", "language-mismatch", "edition-mismatch",
    "runtime-missing", "audio-unreadable", "timeout", "language-guess", "unknown",
  ];
  assert.deepEqual(Object.keys(CAUSES).sort(), [...causes].sort());
  for (const cause of causes) {
    const copy = causeCopy(cause);
    for (const part of [copy.title, copy.explanation, copy.action]) {
      assert.ok(part.trim().length > 0, cause);
      assert.match(part, /[.!]$/, `${cause}: whole sentences`);
      assert.doesNotMatch(part, /os error|exit status|stderr/i, cause);
    }
  }
  // Absent or newer causes stop "unexpectedly" rather than show raw output.
  assert.equal(causeCopy(undefined).title, "Sync stopped unexpectedly.");
  assert.equal(causeCopy("a-cause-from-the-future").title, "Sync stopped unexpectedly.");
});

test("a failed job leads with what happened and keeps the raw error as detail", () => {
  assert.equal(jobProblem({ status: "completed", error: null }), null);
  const missingOutput = jobProblem({ status: "failed", error: "No such file or directory (os error 2)", cause: "runtime-crash" })!;
  assert.equal(missingOutput.title, "The speech recognizer crashed.");
  assert.equal(missingOutput.detail, "No such file or directory (os error 2)");
  // An older server sends no cause; the error never becomes the headline.
  const older = jobProblem({ status: "failed", error: "No such file or directory (os error 2)" })!;
  assert.equal(older.title, "Sync stopped unexpectedly.");
  assert.doesNotMatch(`${older.title} ${older.explanation} ${older.action}`, /os error/);
  const language = jobProblem({ status: "failed", error: "Alignment produced no usable sentence fragments.", cause: "language-mismatch", heardLanguage: "en" })!;
  assert.equal(language.resyncLanguage, "en");
  assert.deepEqual(language.notes, ["It sounds like English."]);
});

function diagnosed(cause: SyncCause, diagnosis: Partial<SyncDiagnosis> = {}, status = "aligned"): SyncChapterReport {
  return {
    ...chapter(4, status === "aligned" ? "poor" : "failed", 0.4), status,
    diagnosis: { cause, evidence: {}, fix: { kind: "none", attempted: false }, ...diagnosis },
  };
}

test("a weak chapter says what was heard, what readers get, and what was tried", () => {
  assert.equal(chapterProblem(chapter(1, "good", 1)), null);
  const language = chapterProblem(diagnosed("language-mismatch", {
    evidence: { heardLanguage: "en", labelledLanguage: "nl" },
    fix: { kind: "suggested", action: "resync-language", attempted: false },
  }))!;
  assert.equal(language.title, "The narration is in a different language.");
  assert.deepEqual(language.notes, ["Heard English; this book is set to Dutch."]);
  assert.equal(language.resyncLanguage, "en");

  const crash = chapterProblem({
    ...diagnosed("runtime-crash", { fix: { kind: "auto", action: "retry-other-model", attempted: true } }, "kept-previous"),
    error: "Alignment of `Chapter 39` stopped without writing a result. The alignment runtime may have crashed.",
  })!;
  assert.deepEqual(crash.notes, ["Earlier timing was kept.", "OperaLibre retried it with a different model, which crashed too."]);
  assert.match(crash.action, /run it again or leave it/);
  assert.match(crash.detail!, /stopped without writing a result/);

  const edition = chapterProblem(diagnosed("edition-mismatch", { evidence: { wordsInText: 0.08, recognizedWords: 3000 } }))!;
  assert.equal(edition.title, "This EPUB may be a different edition.");
  assert.deepEqual(edition.notes, ["8% of what was heard is in this chapter’s text."]);

  const noisy = chapterProblem(diagnosed("noisy-audio", {
    evidence: { wordsInText: 0.57, windows: 9, unanchoredWindows: 5 },
    fix: { kind: "auto", action: "larger-model", attempted: true },
  }))!;
  assert.deepEqual(noisy.notes, [
    "57% of what was heard is in this chapter’s text.",
    "5 of 9 stretches had no clear match.",
    "OperaLibre tried a larger speech model, which did no better.",
  ]);

  // A fix that worked is reported without the advice for the gone problem.
  const repaired = chapterProblem({
    ...chapter(2, "good", 1),
    diagnosis: {
      cause: "chapter-mismatch", evidence: { matchingChapter: { index: 3, label: "Chapter 3" } },
      fix: { kind: "auto", action: "match-other-chapter", attempted: true, applied: true },
    },
  })!;
  assert.deepEqual(repaired.notes, ["Fixed: OperaLibre aligned this audio with the text of Chapter 3."]);
  assert.equal(repaired.action, "");

  // A failed chapter from an older report has no diagnosis.
  const older = chapterProblem({ status: "failed", error: "No such file or directory (os error 2)" })!;
  assert.equal(older.title, "Sync stopped unexpectedly.");
  assert.deepEqual(older.notes, ["It is left unhighlighted."]);
  assert.equal(older.detail, "No such file or directory (os error 2)");
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
  assert.equal(
    syncJobAttention({ status: "completed", failedChapters: [{ index: 9, label: "Chapter 9", cause: "runtime-crash" }, { index: 12, label: "Chapter 12" }] }),
    "Completed · 2 chapters need attention: Chapter 9 (the speech recognizer crashed) and Chapter 12 (sync stopped unexpectedly)",
  );
  // A failed job reports its own error instead.
  assert.equal(syncJobAttention({ status: "failed", failedChapters: named(3) }), null);
});
