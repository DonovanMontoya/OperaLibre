import type { Book, JobChapter, JobStatus, SyncCause, SyncChapterReport, SyncDiagnosis, SyncGrade } from "./types";

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

type CauseCopy = { title: string; explanation: string; action: string };

/** Plain words for every cause a server reports: what happened, and what to do. */
export const CAUSES: Record<SyncCause, CauseCopy> = {
  "runtime-crash": {
    title: "The speech recognizer crashed.",
    explanation: "The alignment add-on stopped partway through without an answer.",
    action: "You can run it again or leave it; crashes like this often don’t repeat.",
  },
  "noisy-audio": {
    title: "The narration was hard to make out.",
    explanation: "Speech recognition couldn’t follow much of this audio, as happens with music, sound effects, or a noisy recording.",
    action: "Listen to check it. The highlight holds its place where it can’t follow.",
  },
  "chapter-mismatch": {
    title: "This audio belongs to another chapter.",
    explanation: "What the narrator says matches a different chapter’s text better than this one’s.",
    action: "Check the audiobook’s chapter markers.",
  },
  "language-mismatch": {
    title: "The narration is in a different language.",
    explanation: "The narrator isn’t speaking the language this book is set to, so speech recognition heard the wrong words.",
    action: "Re-sync it in the language you hear.",
  },
  "edition-mismatch": {
    title: "This EPUB may be a different edition.",
    explanation: "The narrator is clear, but most of what they say isn’t in this text.",
    action: "Try an EPUB of the same edition as the audiobook.",
  },
  "runtime-missing": {
    title: "The sync add-on couldn’t start.",
    explanation: "OperaLibre couldn’t run the alignment add-on or ffmpeg.",
    action: "Reinstall Follow along under Administration → Experimental features, then sync again.",
  },
  "audio-unreadable": {
    title: "The audio couldn’t be read.",
    explanation: "ffmpeg couldn’t extract this stretch of audio, which usually means the file is damaged or in an unusual format.",
    action: "Check that the file plays, then sync again.",
  },
  timeout: {
    title: "Alignment took too long.",
    explanation: "A step ran past its time limit and was stopped, usually because the server was busy or short of memory.",
    action: "Try again when the server is less busy.",
  },
  "language-guess": {
    title: "The aligner misread the text’s language.",
    explanation: "The alignment add-on guessed the wrong language for this text.",
    action: "Run it again. If it keeps happening, check the language set in the EPUB.",
  },
  unknown: {
    title: "Sync stopped unexpectedly.",
    explanation: "OperaLibre couldn’t finish aligning this.",
    action: "Try again. If it keeps stopping, the technical details say where.",
  },
};

/** Copy for a cause; an absent or unrecognized one reads as an unexpected stop. */
export function causeCopy(cause?: string | null): CauseCopy {
  return CAUSES[cause as SyncCause] ?? CAUSES.unknown;
}

/** "English" for `en`, in the reader's own language; the code itself when unknown. */
export function languageName(code: string) {
  try {
    return new Intl.DisplayNames(undefined, { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** What a sync problem is, with the raw error kept for "Technical details". */
export type SyncProblem = CauseCopy & {
  /** What was measured, or what OperaLibre already tried; may be empty. */
  notes: string[];
  detail: string | null;
  /** A language to offer re-syncing the book in. */
  resyncLanguage: string | null;
};

/** A failed sync job in plain words; null unless it failed. */
export function jobProblem(job: Pick<JobStatus, "status" | "cause" | "error" | "heardLanguage">): SyncProblem | null {
  if (job.status !== "failed") return null;
  const language = job.cause === "language-mismatch" ? job.heardLanguage ?? null : null;
  return {
    ...causeCopy(job.cause),
    notes: language ? [`It sounds like ${languageName(language)}.`] : [],
    detail: job.error,
    resyncLanguage: language,
  };
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

function evidenceNotes({ cause, evidence }: SyncDiagnosis) {
  const notes: string[] = [];
  if (evidence.heardLanguage && evidence.labelledLanguage && cause === "language-mismatch") {
    notes.push(`Heard ${languageName(evidence.heardLanguage)}; this book is set to ${languageName(evidence.labelledLanguage)}.`);
  }
  if (evidence.matchingChapter && cause === "chapter-mismatch") notes.push(`It matches the text of ${evidence.matchingChapter.label}.`);
  if (evidence.wordsInText !== undefined && (cause === "edition-mismatch" || cause === "noisy-audio")) {
    notes.push(`${percent(evidence.wordsInText)} of what was heard is in this chapter’s text.`);
  }
  if (evidence.windows && evidence.unanchoredWindows && cause === "noisy-audio") {
    notes.push(`${evidence.unanchoredWindows} of ${evidence.windows} stretches had no clear match.`);
  }
  return notes;
}

/** What OperaLibre already did about it, if anything. */
function fixNote({ fix, evidence }: SyncDiagnosis) {
  if (!fix.attempted) return null;
  const other = evidence.matchingChapter?.label ?? "another chapter";
  switch (fix.action) {
    case "retry-other-model":
      return fix.applied ? "OperaLibre retried it with a different model, which worked." : "OperaLibre retried it with a different model, which crashed too.";
    case "larger-model":
      return fix.applied ? "A larger speech model did better, so its timing is used." : "OperaLibre tried a larger speech model, which did no better.";
    case "match-other-chapter":
      return fix.applied ? `Fixed: OperaLibre aligned this audio with the text of ${other}.` : `Aligning it with the text of ${other} did no better.`;
    default:
      return null;
  }
}

/** A chapter's problem in plain words: its diagnosis, or for a failed chapter without one, an unexpected stop. Null when it went well. */
export function chapterProblem(chapter: Pick<SyncChapterReport, "status" | "error" | "errorDetail" | "diagnosis">): SyncProblem | null {
  const diagnosis = chapter.diagnosis ?? null;
  const failed = chapter.status === "kept-previous" || chapter.status === "failed";
  if (!diagnosis && !failed) return null;
  const outcome = chapter.status === "kept-previous" ? "Earlier timing was kept."
    : chapter.status === "failed" ? "It is left unhighlighted." : null;
  const tried = diagnosis ? fixNote(diagnosis) : null;
  const copy = causeCopy(diagnosis?.cause);
  // A fix that worked replaces the evidence and advice for a problem that is gone.
  const fixed = diagnosis?.fix.applied && tried;
  return {
    ...copy,
    action: fixed ? "" : copy.action,
    notes: fixed ? [tried] : [...(diagnosis ? evidenceNotes(diagnosis) : []), outcome, tried].filter((note): note is string => !!note),
    detail: chapter.errorDetail ?? chapter.error ?? null,
    resyncLanguage: diagnosis?.fix.action === "resync-language" ? diagnosis.evidence.heardLanguage ?? null : null,
  };
}

/** "the speech recognizer crashed" from its title, to follow a chapter's name. */
function causePhrase(cause?: string | null) {
  const title = causeCopy(cause).title.replace(/\.$/, "");
  return title.charAt(0).toLowerCase() + title.slice(1);
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

/** A completed sync that could not align some chapters says so, and why; null otherwise. */
export function syncJobAttention(job: Pick<JobStatus, "status" | "failedChapters">) {
  const failed = job.status === "completed" ? job.failedChapters ?? [] : [];
  if (!failed.length) return null;
  const named = failed.some((chapter) => chapter.cause)
    ? failed.map((chapter) => ({ ...chapter, label: `${chapter.label} (${causePhrase(chapter.cause)})` }))
    : failed;
  return `Completed · ${failed.length} ${failed.length === 1 ? "chapter needs" : "chapters need"} attention: ${chapterNames(named)}`;
}
