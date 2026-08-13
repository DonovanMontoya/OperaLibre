import assert from "node:assert/strict";
import test from "node:test";

import { isLeftEdgeBackSwipe } from "../src/nativeNavigation.ts";

test("recognizes a deliberate rightward swipe beginning at the left edge", () => {
  assert.equal(
    isLeftEdgeBackSwipe({ clientX: 12, clientY: 180 }, { clientX: 102, clientY: 191 }),
    true
  );
});

test("ignores swipes that are not left-edge, far enough, or horizontal", () => {
  assert.equal(
    isLeftEdgeBackSwipe({ clientX: 36, clientY: 180 }, { clientX: 140, clientY: 180 }),
    false
  );
  assert.equal(
    isLeftEdgeBackSwipe({ clientX: 12, clientY: 180 }, { clientX: 70, clientY: 180 }),
    false
  );
  assert.equal(
    isLeftEdgeBackSwipe({ clientX: 12, clientY: 180 }, { clientX: 90, clientY: 250 }),
    false
  );
});
