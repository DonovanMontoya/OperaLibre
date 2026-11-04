import assert from "node:assert/strict";
import test from "node:test";
import { shouldDismissSheet } from "../src/sheetSwipe.ts";

test("a long pull down closes the sheet", () => {
  assert.equal(shouldDismissSheet(130, 0.1, 600), true);
  assert.equal(shouldDismissSheet(70, 0.1, 200), true);
});

test("a quick flick closes the sheet once past the dead zone", () => {
  assert.equal(shouldDismissSheet(40, 0.8, 600), true);
  assert.equal(shouldDismissSheet(12, 2, 600), false);
});

test("a short slow pull or an upward drag springs back", () => {
  assert.equal(shouldDismissSheet(60, 0.2, 600), false);
  assert.equal(shouldDismissSheet(0, 1, 600), false);
  assert.equal(shouldDismissSheet(-50, 1, 600), false);
});
