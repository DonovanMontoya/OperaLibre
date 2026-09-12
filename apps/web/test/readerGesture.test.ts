import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPageGesture } from "../src/readerPagination.ts";

test("a leftward swipe turns forward and a rightward swipe turns back", () => {
  assert.equal(classifyPageGesture(-120, 8, 180), "next");
  assert.equal(classifyPageGesture(120, -8, 180), "prev");
});

test("a thumb's arcing swipe still turns the page", () => {
  // Wider than the old 45px vertical band, but mostly sideways.
  assert.equal(classifyPageGesture(-140, 70, 260), "next");
  assert.equal(classifyPageGesture(-90, -60, 220), "next");
});

test("a short quick flick turns the page but a slow short drift does not", () => {
  assert.equal(classifyPageGesture(-30, 4, 60), "next");
  assert.equal(classifyPageGesture(-30, 4, 400), null);
});

test("a still finger is a tap only when it lifts promptly", () => {
  assert.equal(classifyPageGesture(3, -5, 150), "tap");
  assert.equal(classifyPageGesture(3, -5, 900), null);
});

test("a mostly vertical drag turns nothing", () => {
  assert.equal(classifyPageGesture(-60, 120, 200), null);
});
