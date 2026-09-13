import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { removeHighlight } from "../src/readerAnnotations.ts";

// Mirrors epub.js 0.3.93 Annotations: removal prunes the section list only
// for views on screen, and a page render attaches every listed hash.
function fakeAnnotations() {
  const marks: string[] = [];
  const store = {
    views: [] as number[],
    _annotations: {} as Record<string, { cfi: string; section: number }>,
    _annotationsBySectionIndex: {} as Record<string, string[]>,
    highlight(cfi: string) {
      const hash = encodeURI(cfi + "highlight");
      store._annotations[hash] = { cfi, section: 0 };
      (store._annotationsBySectionIndex[0] ??= []).push(hash);
      if (store.views.includes(0)) marks.push(cfi);
    },
    remove(cfi: string, type: string) {
      const hash = encodeURI(cfi + type);
      if (!(hash in store._annotations)) return;
      for (const view of store.views) {
        store._annotationsBySectionIndex[view] = store._annotationsBySectionIndex[view].filter((h) => h !== hash);
        const at = marks.indexOf(cfi);
        if (at >= 0) marks.splice(at, 1);
      }
      delete store._annotations[hash];
    },
    render() {
      store.views = [0];
      for (const hash of store._annotationsBySectionIndex[0] ?? []) marks.push(store._annotations[hash].cfi);
    }
  };
  return { store, marks };
}

describe("readalong highlight removal", () => {
  it("leaves no stray copy when a highlight is redrawn during a relayout", () => {
    const { store, marks } = fakeAnnotations();
    store.render();
    store.highlight("first");
    // Rotation clears the pages, then the highlight is redrawn before the new page renders.
    store.views = [];
    marks.length = 0;
    removeHighlight(store, "first");
    store.highlight("first");
    store.render();
    assert.deepEqual(marks, ["first"]);

    // The narration moves on; the earlier sentence must be gone.
    removeHighlight(store, "first");
    store.highlight("second");
    assert.deepEqual(marks, ["second"]);
  });
});
