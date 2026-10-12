import type { Book, JobChapter, JobStatus, SyncChapterReport, SyncGrade } from "./types";

const GRADES: Record<SyncGrade, { label: string; tone: "done" | "queued" | "failed"; rank: number }> = {
  good: { label: "Good", tone: "done", rank: 0 },
  review: { label: "Review", tone: "queued", rank: 1 },
  poor: { label: "Poor", tone: "failed", rank: 2 },
  failed: { label: "Failed", tone: "failed", rank: 3 },
};

/** Grades a newer server sends are shown as Review rather than hidden. */
function grade(value: SyncGrade | string) {
  return GRADES[value as SyncGrade] ?? GRADES.review;
}

export function gradeLabel(value: SyncGrade | string) {
  return grade(value).label;
}

/** The `admin-sync-job-state-*` tone a grade pill takes. */
export function gradeTone(value: SyncGrade | string) {
  return grade(value).tone;
}

export function needsAttention(book: Pick<Book, "syncFile">) {
  const value = book.syncFile?.quality?.grade;
  return value === "poor" || value === "failed";
}

/** Splits synced books into those to look at first, worst first, and the rest. */
export function groupSyncedBooks<T extends Pick<Book, "syncFile" | "title">>(books: T[]) {
  const attention = books.filter(needsAttention).sort((a, b) =>
    grade(b.syncFile!.quality!.grade).rank - grade(a.syncFile!.quality!.grade).rank
    || (b.syncFile!.quality!.flagged - a.syncFile!.quality!.flagged)
    || a.title.localeCompare(b.title));
  return { attention, synced: books.filter((book) => !needsAttention(book)) };
}

/** Worst chapters first, then book order; chapters without text last. */
export function sortChapters(chapters: SyncChapterReport[]) {
  const rank = (chapter: SyncChapterReport) => chapter.grade ? grade(chapter.grade).rank : -1;
  return [...chapters].sort((a, b) =>
    rank(b) - rank(a)
    || (rank(a) > 0 ? a.textCoverage - b.textCoverage : 0)
    || a.index - b.index);
}

/** Rounded down, so a chapter missing any text never reads as 100%. */
export function coveragePercent(chapter: Pick<SyncChapterReport, "textCoverage">) {
  return `${Math.floor(Math.max(0, Math.min(1, chapter.textCoverage)) * 100 + 1e-9)}%`;
}

/** Chapters below Good can be re-run; one with no text has nothing to align. */
export function canRerunChapter(chapter: Pick<SyncChapterReport, "grade">) {
  return chapter.grade !== null && chapter.grade !== "good";
}

/** What became of a chapter whose last run failed, with the error's first line; null otherwise. */
export function chapterFailure(chapter: Pick<SyncChapterReport, "status" | "error">) {
  const outcome = chapter.status === "kept-previous" ? "Kept its earlier timing."
    : chapter.status === "failed" ? "Left unhighlighted." : null;
  if (!outcome) return null;
  return chapter.error ? `${outcome} ${chapter.error}` : outcome;
}

/** "Chapter 3", "Chapter 3 and Chapter 7", or "Chapter 3, Chapter 7 and 4 more". */
export function chapterNames(chapters: JobChapter[]) {
  const labels = chapters.map((chapter) => chapter.label);
  if (labels.length <= 2) return labels.join(" and ");
  if (labels.length === 3) return `${labels[0]}, ${labels[1]} and ${labels[2]}`;
  return `${labels[0]}, ${labels[1]} and ${labels.length - 2} more`;
}

/** Names the chapters a re-run job covers; null for a whole-book sync. */
export function syncJobScope(job: Pick<JobStatus, "status" | "chapters">, title: string) {
  if (!job.chapters?.length) return null;
  const names = chapterNames(job.chapters);
  return job.status === "completed" || job.status === "failed" ? `Re-run of ${names}` : `Re-running ${names} of ${title}`;
}

/** A completed sync that could not align some chapters says so; null otherwise. */
export function syncJobAttention(job: Pick<JobStatus, "status" | "failedChapters">) {
  const failed = job.status === "completed" ? job.failedChapters ?? [] : [];
  if (!failed.length) return null;
  return `Completed · ${failed.length} ${failed.length === 1 ? "chapter needs" : "chapters need"} attention: ${chapterNames(failed)}`;
}
