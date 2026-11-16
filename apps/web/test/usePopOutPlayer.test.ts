import assert from "node:assert/strict";
import test from "node:test";
import { nextPresetSpeed, popOutKeyAction } from "../src/usePopOutPlayer.ts";

test("the pop-out speed button steps through the presets and wraps", () => {
  assert.equal(nextPresetSpeed(1), 1.25);
  assert.equal(nextPresetSpeed(1.75), 2);
  assert.equal(nextPresetSpeed(2), 0.75);
  // A custom speed from the main player moves to the next preset above it.
  assert.equal(nextPresetSpeed(1.1), 1.25);
});

test("pop-out shortcuts leave keys to the control that has focus", () => {
  assert.equal(popOutKeyAction(" ", { tagName: "MAIN" }), "toggle");
  assert.equal(popOutKeyAction("ArrowLeft", null), "back");
  assert.equal(popOutKeyAction("ArrowRight", { tagName: "BUTTON" }), "forward");
  // A focused button already answers Space, so pressing it must not toggle twice.
  assert.equal(popOutKeyAction(" ", { tagName: "BUTTON" }), null);
  // The scrubber moves with the arrow keys.
  assert.equal(popOutKeyAction("ArrowLeft", { tagName: "INPUT" }), null);
  assert.equal(popOutKeyAction("Enter", { tagName: "MAIN" }), null);
});
