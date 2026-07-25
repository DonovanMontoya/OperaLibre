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
