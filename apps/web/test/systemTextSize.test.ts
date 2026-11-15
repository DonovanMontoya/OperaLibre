import assert from "node:assert/strict";
import test from "node:test";
import { textScaleFor } from "../src/systemTextSize.ts";

test("the default iOS text size keeps the root size", () => {
  assert.equal(textScaleFor(17), 1);
});

test("larger and smaller system sizes scale within the caps", () => {
  assert.equal(textScaleFor(19), 19 / 17);
  assert.equal(textScaleFor(53), 2);
  assert.equal(textScaleFor(14), 0.9);
});

test("an unusable probe reading falls back to the root size", () => {
  assert.equal(textScaleFor(Number.NaN), 1);
  assert.equal(textScaleFor(0), 1);
});
