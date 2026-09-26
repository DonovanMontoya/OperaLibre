import type { Book as EpubBook } from "epubjs";
import { normalizeReadalongText, normalizeSyncNeedle } from "./readalong.ts";
import type { Chapter, SyncFragment } from "./types";

export type IllustrationGap = {
  startSeconds: number;
  endSeconds: number;
  href: string;
  cfi?: string;
  heading?: boolean;
  divider?: boolean;
};

/** A long interval may contain narration of text printed only in a picture. */
export function illustrationGapCandidates(fragments: SyncFragment[]) {
  const candidates: Array<{ before: SyncFragment; after: SyncFragment }> = [];
  for (let index = 0; index + 1 < fragments.length; index += 1) {
    const before = fragments[index];
    const after = fragments[index + 1];
    // Inline pictures are confirmed between the exact mapped snippets below;
    // their spoken descriptions can be much shorter than a separate page.
    const minimum = before.href === after.href ? 3 : 15;
    if (after.startSeconds - before.endSeconds >= minimum) {
      candidates.push({ before, after });
    }
  }
  return candidates;
}

function imageOnlyBody(body: HTMLElement | null | undefined) {
  return !!body?.querySelector("img, svg, image") && (body.textContent?.trim().length ?? 0) <= 40;
}

/** The first visible content is a picture containing the chapter heading. */
function leadingImage(body: HTMLElement | null | undefined) {
  if (!body) return false;
  const firstContent = (node: Node): "image" | "text" | null => {
    if (node.nodeType === 3) return node.textContent?.trim() ? "text" : null;
    if (node.nodeType !== 1) return null;
    const element = node as Element;
    if (/^(img|svg|image)$/i.test(element.localName)) return "image";
    for (const child of Array.from(node.childNodes ?? [])) {
      const content = firstContent(child);
      if (content) return content;
    }
    return null;
  };
  return firstContent(body) === "image";
}

/** Locate an image between the two mapped snippets in the same EPUB section. */
function imageBetweenSnippets(body: HTMLElement, before: string, after?: string): Element | null {
  const images: Array<{ element: Element; offset: number }> = [];
  let normalized = "";
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      for (const ch of node.textContent ?? "") {
        if (ch === "\u00ad") continue;
        if (/\s/.test(ch)) {
          if (normalized && !normalized.endsWith(" ")) normalized += " ";
        } else {
          normalized += ch.toLowerCase();
        }
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (/^(img|svg|image)$/i.test(element.localName)) {
      images.push({ element, offset: normalized.length });
      return;
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  };
  visit(body);
  const beforeNeedle = normalizeSyncNeedle(before);
  const afterNeedle = after === undefined ? "" : normalizeSyncNeedle(after);
  if (!beforeNeedle || (after !== undefined && !afterNeedle)) return null;
  const afterAt = after === undefined ? normalized.length : normalized.indexOf(afterNeedle);
  const beforeAt = normalized.lastIndexOf(beforeNeedle, afterAt);
  if (afterAt < 0 || beforeAt < 0) return null;
  if (after === undefined && normalized.slice(beforeAt + beforeNeedle.length).trim()) return null;
  const candidates = images.filter(({ offset }) => offset >= beforeAt + beforeNeedle.length && offset <= afterAt);
  // Several trailing figures need separate evidence for their order/timing.
  if (after === undefined && candidates.length !== 1) return null;
  return candidates[0]?.element ?? null;
}

function gapStart(before: SyncFragment, after: SyncFragment, chapterStarts: number[], fallbackDelay = 5) {
  const first = chapterStarts.find((start) => start > before.endSeconds && start < after.startSeconds);
  return first !== undefined && first - before.endSeconds <= 10 ? first : before.endSeconds + fallbackDelay;
}

function illustratedAudioTitle(title: string) {
  return /\b(sketchbook|annotated map|folio|glyphs? page|illustration)\b/i.test(title);
}

/** Accessible image descriptions can distinguish pictures sharing one page. */
function pictureNamedByChapter(body: HTMLElement | null | undefined, title: string): Element | null {
  const name = normalizeReadalongText(title.replace(/^.*?\billustration\s*:\s*/i, ""));
  if (!name) return null;
  const matches = Array.from(body?.querySelectorAll?.("img, svg") ?? []).filter((image) => {
    const label = normalizeReadalongText(image.getAttribute("alt") ?? image.getAttribute("aria-label") ?? "");
    return label === name || label.startsWith(`${name} `);
  });
  return matches.length === 1 ? matches[0] : null;
}

function overlayGap(gaps: IllustrationGap[], named: IllustrationGap) {
  return [
    ...gaps.flatMap((gap) => {
      if (gap.endSeconds <= named.startSeconds || gap.startSeconds >= named.endSeconds) return [gap];
      return [
        ...(gap.startSeconds < named.startSeconds ? [{ ...gap, endSeconds: named.startSeconds }] : []),
        ...(gap.endSeconds > named.endSeconds ? [{ ...gap, startSeconds: named.endSeconds }] : [])
      ];
    }),
    named
  ];
}

/**
 * Find narrated pictures that have no sync fragments. EPUB spine order gives
 * their page order; audiobook chapter markers give exact turns when present.
 */
export async function findIllustrationGaps(
  book: EpubBook,
  fragments: SyncFragment[],
  audioChapters: Chapter[] = []
): Promise<IllustrationGap[]> {
  let gaps: IllustrationGap[] = [];
  const sortedChapters = [...audioChapters].sort((a, b) => a.startSeconds - b.startSeconds);
  const chapterStarts = sortedChapters.map((chapter) => chapter.startSeconds);
  for (const { before, after } of illustrationGapCandidates(fragments)) {
    const previousText = book.spine.get(before.href);
    const nextText = book.spine.get(after.href);
    if (!previousText || !nextText) continue;
    // An inline figure is the next content after the preceding sentence;
    // show it as that sentence ends instead of waiting through its narration.
    const startSeconds = gapStart(before, after, chapterStarts, previousText.index === nextText.index ? 0 : 5);
    if (startSeconds >= after.startSeconds) continue;

    if (previousText.index === nextText.index) {
      try {
        const section = book.spine.get(previousText.index);
        if (!section) continue;
        await section.load(book.load.bind(book));
        const image = section.document?.body
          ? imageBetweenSnippets(section.document.body, before.text, after.text)
          : null;
        if (image) {
          gaps.push({ startSeconds, endSeconds: after.startSeconds, href: section.href, cfi: section.cfiFromElement(image) });
        }
      } catch {
        // An unreadable section must not interrupt ordinary text following.
      }
      continue;
    }

    if (nextText.index <= previousText.index + 1) continue;
    const pictures: string[] = [];
    try {
      for (let index = previousText.index + 1; index < nextText.index; index += 1) {
        const section = book.spine.get(index);
        if (!section) break;
        await section.load(book.load.bind(book));
        if (!imageOnlyBody(section.document?.body)) break;
        pictures.push(section.href);
      }
    } catch {
      // An unreadable section must not interrupt ordinary text following.
    }
    if (pictures.length !== nextText.index - previousText.index - 1) continue;

    const internalMarkers = chapterStarts.filter((start) => start > startSeconds && start < after.startSeconds - 5);
    const boundaries = internalMarkers.length >= pictures.length - 1
      ? internalMarkers.slice(0, pictures.length - 1)
      : pictures.slice(1).map((_, index) =>
        startSeconds + (after.startSeconds - startSeconds) * (index + 1) / pictures.length
      );
    pictures.forEach((href, index) => {
      gaps.push({
        startSeconds: index === 0 ? startSeconds : boundaries[index - 1],
        endSeconds: boundaries[index] ?? after.startSeconds,
        href
      });
    });
  }

  // A brief, unspoken part or interlude page still has a place in the book.
  // Show it during the pause before the next audio chapter starts. These
  // pauses are often under five seconds, so the narrated-picture threshold
  // above intentionally does not catch them.
  for (let index = 0; index + 1 < fragments.length; index += 1) {
    const before = fragments[index];
    const after = fragments[index + 1];
    const duration = after.startSeconds - before.endSeconds;
    if (before.href === after.href || duration < 2 || duration >= 15) continue;
    const marker = chapterStarts.find((start) => start > before.endSeconds + 1.5 && start < after.startSeconds);
    if (marker === undefined) continue;
    const previousText = book.spine.get(before.href);
    const nextText = book.spine.get(after.href);
    if (!previousText || !nextText || nextText.index <= previousText.index + 1) continue;
    let picture: string | null = null;
    let allPictures = true;
    try {
      for (let sectionIndex = previousText.index + 1; sectionIndex < nextText.index; sectionIndex += 1) {
        const section = book.spine.get(sectionIndex);
        if (!section) { allPictures = false; break; }
        await section.load(book.load.bind(book));
        if (!imageOnlyBody(section.document?.body)) { allPictures = false; break; }
        picture ??= section.href;
      }
    } catch {
      allPictures = false;
    }
    if (allPictures && picture) {
      gaps.push({ startSeconds: before.endSeconds, endSeconds: after.startSeconds, href: picture, divider: true });
    }
  }

  // Some forced maps place ordinary text fragments inside a separately
  // narrated picture chapter. Its audio boundaries are a stronger signal than
  // the map's apparent silence (which can be only a second long).
  for (let index = 0; index < sortedChapters.length; index += 1) {
    const chapter = sortedChapters[index];
    if (!illustratedAudioTitle(chapter.title)) continue;
    const endSeconds = sortedChapters[index + 1]?.startSeconds ?? chapter.endSeconds;
    if (endSeconds === undefined || endSeconds === null || endSeconds - chapter.startSeconds < 10) continue;
    let lastBefore: SyncFragment | undefined;
    for (let fragmentIndex = fragments.length - 1; fragmentIndex >= 0; fragmentIndex -= 1) {
      if (fragments[fragmentIndex].endSeconds <= chapter.startSeconds) {
        lastBefore = fragments[fragmentIndex];
        break;
      }
    }
    const previousText = lastBefore ? book.spine.get(lastBefore.href) : null;
    if (previousText && lastBefore && chapter.startSeconds - lastBefore.endSeconds <= 10) {
      try {
        await previousText.load(book.load.bind(book));
        const picture = previousText.document?.body
          ? imageBetweenSnippets(previousText.document.body, lastBefore.text)
          : null;
        if (picture) {
          gaps = overlayGap(gaps, {
            startSeconds: chapter.startSeconds,
            endSeconds,
            href: previousText.href,
            cfi: previousText.cfiFromElement(picture)
          });
          continue;
        }
      } catch {
        // A trailing figure is optional; try the separate-page form below.
      }
    }
    const firstAfter = fragments.find((fragment) => fragment.startSeconds >= endSeconds);
    const nextText = firstAfter ? book.spine.get(firstAfter.href) : null;
    const illustration = nextText ? book.spine.get(nextText.index - 1) : null;
    if (!illustration) continue;
    try {
      await illustration.load(book.load.bind(book));
      if (!imageOnlyBody(illustration.document?.body)) continue;
      const picture = pictureNamedByChapter(illustration.document?.body, chapter.title);
      if (picture) {
        gaps = overlayGap(gaps, {
          startSeconds: chapter.startSeconds, endSeconds, href: illustration.href,
          cfi: illustration.cfiFromElement(picture)
        });
        continue;
      }
      if (!gaps.some((gap) => gap.href === illustration.href
        && gap.startSeconds <= chapter.startSeconds && gap.endSeconds >= endSeconds)) {
        gaps.push({ startSeconds: chapter.startSeconds, endSeconds, href: illustration.href });
      }
    } catch {
      // Keep the text map when this picture cannot be read.
    }
  }

  // Chapter names printed in a heading image are narrated before the first
  // mapped sentence. Follow the audio chapter marker even when the gap is only
  // a few seconds, or the previous fragment's timing overlaps that marker.
  const checkedHeadings = new Map<string, boolean>();
  for (let index = 0; index + 1 < fragments.length; index += 1) {
    const before = fragments[index];
    const after = fragments[index + 1];
    if (before.href === after.href) continue;
    const pictureGap = gaps.find((gap) => gap.endSeconds === after.startSeconds && gap.href !== after.href);
    const marker = chapterStarts.filter((start) => start > before.startSeconds && start < after.startSeconds).pop();
    const nearMarker = marker !== undefined && after.startSeconds - marker <= 12 ? marker : null;
    if (pictureGap?.divider && nearMarker !== null && after.startSeconds - nearMarker < 2) continue;
    const headingStart = nearMarker ?? (pictureGap ? after.startSeconds - 5 : null);
    if (headingStart === null || headingStart <= before.startSeconds) continue;
    const section = book.spine.get(after.href);
    if (!section) continue;
    let hasHeading = checkedHeadings.get(after.href);
    if (hasHeading === undefined) {
      try {
        await section.load(book.load.bind(book));
        hasHeading = leadingImage(section.document?.body);
      } catch {
        hasHeading = false;
      }
      checkedHeadings.set(after.href, hasHeading);
    }
    if (!hasHeading) continue;
    for (const gap of gaps) {
      if (gap.href !== after.href && gap.startSeconds < after.startSeconds && gap.endSeconds > headingStart) {
        gap.endSeconds = Math.max(gap.startSeconds, headingStart);
      }
    }
    gaps.push({ startSeconds: headingStart, endSeconds: after.startSeconds, href: after.href, heading: true });
  }

  // The aligner can start a new EPUB section before its audio chapter begins.
  // The two fragments around the marker then have the same href, even though
  // the narrator is reading that section's image heading right now.
  for (const chapter of sortedChapters) {
    if (illustratedAudioTitle(chapter.title)) continue;
    const firstAfter = fragments.find((fragment) => fragment.startSeconds >= chapter.startSeconds);
    if (!firstAfter || firstAfter.startSeconds - chapter.startSeconds > 20
      || firstAfter.startSeconds <= chapter.startSeconds) continue;
    if (firstAfter.startSeconds - chapter.startSeconds < 2
      && gaps.some((gap) => gap.divider && gap.startSeconds < chapter.startSeconds
        && gap.endSeconds === firstAfter.startSeconds)) continue;
    const section = book.spine.get(firstAfter.href);
    if (!section) continue;
    let hasHeading = checkedHeadings.get(firstAfter.href);
    if (hasHeading === undefined) {
      try {
        await section.load(book.load.bind(book));
        hasHeading = leadingImage(section.document?.body);
      } catch {
        hasHeading = false;
      }
      checkedHeadings.set(firstAfter.href, hasHeading);
    }
    if (!hasHeading || gaps.some((gap) => gap.heading && gap.href === firstAfter.href
      && gap.endSeconds === firstAfter.startSeconds)) continue;
    for (const gap of gaps) {
      if (gap.href !== firstAfter.href && gap.startSeconds < chapter.startSeconds && gap.endSeconds > chapter.startSeconds) {
        gap.endSeconds = chapter.startSeconds;
      }
    }
    gaps.push({
      startSeconds: chapter.startSeconds,
      endSeconds: firstAfter.startSeconds,
      href: firstAfter.href,
      heading: true
    });
  }

  // A forced map can assign text fragments to the audio of an image-only
  // chapter, leaving no timing gap to discover. A matching EPUB contents entry
  // and audiobook chapter marker give that page a more reliable interval.
  try {
    const navigation = await book.loaded.navigation;
    const entries: Array<{ href: string; label: string }> = [];
    const collect = (items: typeof navigation.toc) => {
      for (const item of items) {
        entries.push(item);
        collect(item.subitems ?? []);
      }
    };
    collect(navigation.toc);
    for (let index = 0; index < sortedChapters.length; index += 1) {
      const chapter = sortedChapters[index];
      const endSeconds = sortedChapters[index + 1]?.startSeconds ?? chapter.endSeconds;
      if (endSeconds === null || endSeconds <= chapter.startSeconds) continue;
      const title = normalizeReadalongText(chapter.title);
      const matches = entries.filter((entry) => {
        const label = normalizeReadalongText(entry.label);
        return (label.length >= 3 && title === label)
          || (label.length >= 10 && title.endsWith(` ${label}`));
      });
      if (matches.length !== 1) continue;
      const section = book.spine.get(matches[0].href.split("#")[0]);
      if (!section) continue;
      try {
        await section.load(book.load.bind(book));
        if (!imageOnlyBody(section.document?.body)) continue;
      } catch {
        continue;
      }
      const picture = pictureNamedByChapter(section.document?.body, chapter.title);
      gaps = overlayGap(gaps, {
        startSeconds: chapter.startSeconds,
        endSeconds,
        href: section.href,
        ...(picture ? { cfi: section.cfiFromElement(picture) } : {})
      });
    }
  } catch {
    // An unavailable contents list leaves the fragment-based gaps intact.
  }
  return gaps.filter((gap) => gap.endSeconds > gap.startSeconds).sort((a, b) => a.startSeconds - b.startSeconds);
}

export function illustrationGapAt(gaps: IllustrationGap[], seconds: number): IllustrationGap | null {
  return gaps.find((gap) => seconds >= gap.startSeconds && seconds < gap.endSeconds) ?? null;
}
