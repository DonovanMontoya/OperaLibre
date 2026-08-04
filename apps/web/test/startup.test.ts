import assert from "node:assert/strict";
import test from "node:test";
import { shouldAcceptNativeTrackChange } from "../src/startup.ts";

test("paused native queue churn cannot replace restored startup progress", () => {
  assert.equal(shouldAcceptNativeTrackChange(false, false), false);
});

test("live playback and post-startup track changes remain authoritative", () => {
  assert.equal(shouldAcceptNativeTrackChange(false, true), true);
  assert.equal(shouldAcceptNativeTrackChange(true, false), true);
});
