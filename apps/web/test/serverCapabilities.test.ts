import assert from "node:assert/strict";
import test from "node:test";
import { serverCapabilities } from "../src/serverCapabilities.ts";

test("Jellyfin permissions apply to administrators too, and unknown cached permissions do not offer downloads", () => {
  for (const isAdmin of [false, true]) {
    for (const canDownload of [false, undefined, true]) {
      const capabilities = serverCapabilities("jellyfin", { isAdmin, canDownload });
      assert.equal(capabilities.downloads, canDownload === true);
      assert.equal(capabilities.progressSync, true);
      assert.equal(capabilities.completion, true);
      for (const feature of ["administration", "metadataEditing", "uploads", "bookArchive", "statistics", "sharedActivity", "imports", "sentenceAlignment"] as const) {
        assert.equal(capabilities[feature], false, feature);
      }
    }
  }
});

test("OperaLibre account roles gate mutations without taking away listener features", () => {
  const reader = serverCapabilities("operalibre", { isAdmin: false });
  assert.equal(reader.downloads, true);
  assert.equal(reader.statistics, true);
  assert.equal(reader.readingFiles, true);
  assert.equal(reader.administration, false);
  assert.equal(reader.metadataEditing, false);
  const owner = serverCapabilities("operalibre", { isAdmin: true });
  assert.equal(owner.administration, true);
  assert.equal(owner.uploads, true);
});

test("device and demo modes do not acquire server permissions from a saved account", () => {
  for (const mode of [{ local: true }, { demo: true }]) {
    const capabilities = serverCapabilities("operalibre", { isAdmin: true }, mode);
    for (const feature of ["downloads", "progressSync", "administration", "imports", "sentenceAlignment", "sharedActivity"] as const) {
      assert.equal(capabilities[feature], false, feature);
    }
    assert.equal(capabilities.readingFiles, true);
    assert.equal(capabilities.statistics, true, "retain the device-only ledger");
  }
});
