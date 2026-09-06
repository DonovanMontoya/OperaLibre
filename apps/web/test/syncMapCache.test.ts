import assert from "node:assert/strict";
import test from "node:test";
import { syncMapCacheReducer } from "../src/syncMapCache.ts";

test("manual edit invalidation reloads an open reader, including repeated edits before loading", () => {
  const original = { maps: { edited: null, other: null }, revision: 0 };
  const invalidated = syncMapCacheReducer(original, { type: "invalidate", bookId: "edited" });
  assert.deepEqual(invalidated, { maps: { other: null }, revision: 1 });
  const repeated = syncMapCacheReducer(invalidated, { type: "invalidate", bookId: "edited" });
  assert.equal(repeated.revision, 2);
  assert.deepEqual(original.maps, { edited: null, other: null });
});

test("publishing cached or refreshed maps does not trigger another fetch; generation reset does", () => {
  const loaded = syncMapCacheReducer({ maps: {}, revision: 2 }, { type: "loaded", bookId: "book", map: null });
  assert.equal(loaded.revision, 2);
  assert.deepEqual(syncMapCacheReducer(loaded, { type: "reset" }), { maps: {}, revision: 3 });
});
