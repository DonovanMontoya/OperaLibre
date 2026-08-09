import type { Chapter } from "./types";

export type ChapterSegment = Chapter & {
  chapterNumber: number;
  endSeconds: number;
  durationSeconds: number;
};

export function buildChapterSegments(
  chapters: Chapter[],
  bookDurationSeconds: number
): ChapterSegment[] {
  if (chapters.length === 0) {
    return [];
  }
  const inferredEnd = chapters.reduce(
    (latest, chapter) => Math.max(latest, chapter.endSeconds ?? chapter.startSeconds),
    0
  );
  const boundedBookDuration =
    Number.isFinite(bookDurationSeconds) && bookDurationSeconds > 0
      ? bookDurationSeconds
      : Math.max(1, inferredEnd);

  return chapters.map((chapter, index) => {
    const nextChapter = chapters[index + 1];
    const endSeconds = chapter.endSeconds ?? nextChapter?.startSeconds ?? boundedBookDuration;
    const boundedEnd = Math.max(
      chapter.startSeconds,
      Math.min(endSeconds, boundedBookDuration)
    );
    return {
      ...chapter,
      chapterNumber: index + 1,
      endSeconds: boundedEnd,
      durationSeconds: Math.max(1, boundedEnd - chapter.startSeconds)
    };
  });
}

/**
 * The chapter a whole-book position falls in.
 *
 * Markers do not have to cover the whole book: the server keeps only the
 * chapters tracks actually carry, so a leading file without embedded markers —
 * opening credits, a publisher's note — or a gap between two files that do
 * have them leaves stretches belonging to no chapter. Scanning for the last
 * chapter that has already started keeps a position inside such a gap on the
 * chapter it is still in, and past the end on the closing one.
 *
 * Before the first marker there is genuinely no chapter, so this returns null
 * and callers fall back to plain track time. Defaulting to the array's last
 * element instead labelled the start of the book with the closing chapter, and
 * because the transport scrubs relative to `activeChapter.startSeconds`, one
 * drag would have thrown the listener to the end of the book.
 */
export function chapterAtBookPosition(
  segments: ChapterSegment[],
  bookPositionSeconds: number
): ChapterSegment | null {
  let match: ChapterSegment | null = null;
  for (const segment of segments) {
    if (segment.startSeconds > bookPositionSeconds) break;
    match = segment;
  }
  return match;
}
