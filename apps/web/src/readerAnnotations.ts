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
