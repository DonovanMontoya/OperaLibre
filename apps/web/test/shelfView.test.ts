import assert from "node:assert/strict";
import test from "node:test";
import {
  SHELF_VIEW_MODE_STORAGE_KEY,
  readShelfViewMode,
  writeShelfViewMode
} from "../src/shelfView.ts";
import type { ShelfViewMode } from "../src/shelfView.ts";
import { memoryStorage } from "./memoryStorage.ts";

test("a shelf nobody has set a density on opens roomy", () => {
  assert.equal(readShelfViewMode(memoryStorage()), "list");
});

test("a density nothing writes any more does not survive as one", () => {
  assert.equal(readShelfViewMode(memoryStorage(SHELF_VIEW_MODE_STORAGE_KEY, "cozy")), "list");
  assert.equal(readShelfViewMode(memoryStorage(SHELF_VIEW_MODE_STORAGE_KEY, "")), "list");
});

test("each density round-trips, so the choice outlives the session", () => {
  for (const mode of ["list", "compact", "grid"] as ShelfViewMode[]) {
    const storage = memoryStorage();
    writeShelfViewMode(storage, mode);
    assert.equal(storage.getItem(SHELF_VIEW_MODE_STORAGE_KEY), mode);
    assert.equal(readShelfViewMode(storage), mode);
  }
});
