import assert from "node:assert/strict";
import test from "node:test";
import { serverCapabilities } from "../src/serverCapabilities.ts";

test("account roles gate mutations without taking away listener features", () => {
  const reader = serverCapabilities({ isAdmin: false });
  assert.equal(reader.downloads, true);
  assert.equal(reader.progressSync, true);
  assert.equal(reader.sentenceAlignment, true);
  assert.equal(reader.administration, false);
  assert.equal(reader.metadataEditing, false);
  assert.equal(reader.uploads, false);
  const owner = serverCapabilities({ isAdmin: true });
  assert.equal(owner.administration, true);
  assert.equal(owner.metadataEditing, true);
  assert.equal(owner.uploads, true);
});

test("device and demo modes do not acquire server permissions from a saved account", () => {
  for (const mode of [{ local: true }, { demo: true }]) {
    const capabilities = serverCapabilities({ isAdmin: true }, mode);
    for (const feature of ["downloads", "progressSync", "completion", "administration", "imports", "sharedActivity"] as const) {
      assert.equal(capabilities[feature], false, feature);
    }
    assert.equal(capabilities.sentenceAlignment, "demo" in mode);
  }
});
