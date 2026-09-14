/** The parts of epub.js's annotation store that removal has to reach. */
export interface AnnotationStore {
  remove(cfiRange: string, type: string): void;
  _annotationsBySectionIndex?: Record<string, string[]>;
}

/**
 * Removes a highlight completely. epub.js forgets which section held an
 * annotation only while that section's page is on screen. A relayout (a
 * rotation or resize) clears the pages first, so a highlight removed in that
 * gap stays listed. Adding the same sentence back then lists it twice, the
 * next page render draws it twice, and the extra copy can never be removed:
 * it stays on the page after the narration moves on.
 */
export function removeHighlight(annotations: AnnotationStore, cfiRange: string): void {
  annotations.remove(cfiRange, "highlight");
  const bySection = annotations._annotationsBySectionIndex;
  if (!bySection) return;
  const hash = encodeURI(cfiRange + "highlight");
  for (const section of Object.keys(bySection)) {
    bySection[section] = bySection[section].filter((entry) => entry !== hash);
  }
}

/** A marks-pane mark, as epub.js draws it over a page. */
interface PaneMark {
  className?: string;
}

/** The parts of an epub.js page view that hold its drawn highlights. */
export interface MarkedView {
  pane?: { marks: PaneMark[]; removeMark(mark: PaneMark): void };
  highlights?: Record<string, { mark: PaneMark }>;
}

/**
 * Erases highlights of the given class that their page no longer tracks. A
 * page keeps one mark per sentence, so drawing a sentence it already shows
 * replaces the entry and leaves the first mark on the page with no way to
 * remove it. A relayout gives epub.js several chances to do that: the redraw
 * lands while the new page is loading and the page's first render draws the
 * sentence again, or a rotation reports more than one size in a row.
 */
export function pruneUntrackedHighlights(views: Iterable<MarkedView>, className: string): void {
  for (const view of views) {
    const pane = view.pane;
    if (!pane) continue;
    const tracked = new Set(Object.values(view.highlights ?? {}).map((entry) => entry.mark));
    for (const mark of [...pane.marks]) {
      if (mark.className === className && !tracked.has(mark)) {
        pane.removeMark(mark);
      }
    }
  }
}
