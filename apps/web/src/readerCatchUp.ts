import { LABEL_MATCH_THRESHOLD, parseReadalongLabel, readalongMatchScore } from "./readalong.ts";
import type { Book as EpubBook } from "epubjs";

/** Ambiguous chapter names must never choose an automatic landing place. */
export function catchUpChapterHref(toc: Array<{ href: string; label: string }>, title: string | null) {
  if (!title) return null;
  const target = parseReadalongLabel(title);
  const matches = toc.filter((item) => item.href &&
    readalongMatchScore(target, parseReadalongLabel(item.label)) >= LABEL_MATCH_THRESHOLD);
  const hrefs = [...new Set(matches.map((item) => item.href))];
  return hrefs.length === 1 ? hrefs[0] : null;
}

/** Comparing chapter starts to the exact page also protects same-chapter readers. */
export function canCatchUp(saved: string | null, target: string | null, compare: (a: string, b: string) => number) {
  if (!saved || !target) return false;
  try {
    return compare(target, saved) > 0;
  } catch {
    return false;
  }
}

export async function resolveListeningCfi(book: EpubBook, toc: Array<{ href: string; label: string }>, chapter: string | null) {
  const href = catchUpChapterHref(toc, chapter);
  if (!href) return null;
  const section = book.spine.get(href);
  if (!section) return null;
  // epub.js resolves load() with the root element, despite its Document type.
  await section.load(book.load.bind(book));
  const document = section.document;
  const fragment = href.split("#")[1];
  const element = fragment ? document.getElementById(decodeURIComponent(fragment)) : document.body;
  return element ? section.cfiFromElement(element) : null;
}
