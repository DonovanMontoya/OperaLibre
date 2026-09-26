import { hrefsMatch, normalizeReadalongText } from "./readalong.ts";
import type { Chapter, SyncFragment } from "./types.ts";

type TocItem = { href: string; label: string };

function illustratedTitle(title: string) {
  return /\b(sketchbook|annotated map|folio|glyphs? page|illustration)\b/i.test(title);
}

/**
 * Older maps sometimes align the next text chapter across a narrated picture.
 * A chapter marker can restore that text's start without regenerating the map.
 * Only repair a uniquely named chapter immediately after an illustrated audio
 * chapter, with a large early start and an otherwise matching end marker.
 */
export function correctEarlyChapterFragments(
  fragments: SyncFragment[],
  audioChapters: Chapter[],
  toc: TocItem[]
): SyncFragment[] {
  if (!fragments.length || !audioChapters.length || !toc.length) return fragments;
  const chapters = [...audioChapters].sort((a, b) => a.startSeconds - b.startSeconds);
  const groups: Array<{ href: string; first: number; last: number }> = [];
  for (let index = 0; index < fragments.length; index += 1) {
    const href = fragments[index].href;
    const group = groups[groups.length - 1];
    if (group && hrefsMatch(group.href, href)) group.last = index;
    else groups.push({ href, first: index, last: index });
  }

  let corrected: SyncFragment[] | null = null;
  for (let chapterIndex = 1; chapterIndex < chapters.length; chapterIndex += 1) {
    const chapter = chapters[chapterIndex];
    const end = chapter.endSeconds;
    if (!illustratedTitle(chapters[chapterIndex - 1].title) || end === null) continue;
    const title = normalizeReadalongText(chapter.title);
    const matchingToc = toc.filter((item) => {
      const label = normalizeReadalongText(item.label);
      return label.length >= 8 && (title === label || title.endsWith(` ${label}`));
    });
    if (matchingToc.length !== 1) continue;
    const matchingGroups = groups.filter((group) => hrefsMatch(group.href, matchingToc[0].href));
    if (matchingGroups.length !== 1) continue;
    const { first, last } = matchingGroups[0];
    const oldStart = fragments[first].startSeconds;
    const oldEnd = fragments[last].endSeconds;
    const newStart = chapter.startSeconds;
    if (newStart - oldStart < 15 || end - newStart < 60 || Math.abs(oldEnd - end) > 10
      || oldEnd <= oldStart || first > 0 && fragments[first - 1].endSeconds > newStart) continue;
    const scale = (end - newStart) / (oldEnd - oldStart);
    const adjust = (seconds: number) => newStart + (seconds - oldStart) * scale;
    corrected ??= fragments.slice();
    for (let index = first; index <= last; index += 1) {
      const fragment = fragments[index];
      corrected[index] = {
        ...fragment,
        startSeconds: adjust(fragment.startSeconds),
        endSeconds: adjust(fragment.endSeconds),
        words: fragment.words?.map(([start, finish, offset, length]) =>
          [adjust(start), adjust(finish), offset, length]
        )
      };
    }
  }
  return corrected ?? fragments;
}
