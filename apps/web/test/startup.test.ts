import assert from "node:assert/strict";
import test from "node:test";
import {
  canResolveStartupNavigation,
  canRestoreCachedNativeSession,
  shouldAcceptNativeTrackChange,
  shouldRefreshMediaCredential,
  startupDestinationAfterLoad
} from "../src/startup.ts";

test("downloaded books restore from the cached account without a media token", () => {
  assert.equal(canRestoreCachedNativeSession(true, "session-token", true), true);
  assert.equal(canRestoreCachedNativeSession(true, null, true), false);
  assert.equal(canRestoreCachedNativeSession(false, "session-token", true), false);
});

test("reconnecting refreshes credentials only for an incomplete server session", () => {
  assert.equal(shouldRefreshMediaCredential(true, "session-token", null, true, false, false), true);
  assert.equal(shouldRefreshMediaCredential(false, "session-token", null, true, false, false), false);
  assert.equal(shouldRefreshMediaCredential(true, "session-token", "media-token", true, false, false), false);
  assert.equal(shouldRefreshMediaCredential(true, null, null, true, false, false), false);
  assert.equal(shouldRefreshMediaCredential(true, "session-token", null, false, false, false), false);
  assert.equal(shouldRefreshMediaCredential(true, "session-token", null, true, true, false), false);
  assert.equal(shouldRefreshMediaCredential(true, "session-token", null, true, false, true), false);
});

test("a cached shelf can open offline without a saved playback session", () => {
  assert.equal(canResolveStartupNavigation(null, null, false, false), true);
});

test("startup waits when a cached shelf may be missing the saved playback book", () => {
  assert.equal(canResolveStartupNavigation(null, "saved-book", false, false), false);
  assert.equal(canResolveStartupNavigation(null, "saved-book", false, true), true);
});

test("a restored or present playback book resolves startup immediately", () => {
  assert.equal(canResolveStartupNavigation("saved-book", "saved-book", true, false), true);
  assert.equal(canResolveStartupNavigation(null, "finished-book", true, false), true);
});

test("paused native queue churn cannot replace restored startup progress", () => {
  assert.equal(shouldAcceptNativeTrackChange(false, false), false);
});

test("live playback and post-startup track changes remain authoritative", () => {
  assert.equal(shouldAcceptNativeTrackChange(false, true), true);
  assert.equal(shouldAcceptNativeTrackChange(true, false), true);
});

test("the first conclusive load picks the launch tab", () => {
  // Reading waits for the restore to reveal; the Shelf reveals at once.
  assert.deepEqual(
    startupDestinationAfterLoad(false, false, "saved-book", "saved-book", true, false),
    { tab: "reading", reveal: false }
  );
  assert.deepEqual(
    startupDestinationAfterLoad(false, false, null, null, false, false),
    { tab: "shelf", reveal: true }
  );
  assert.equal(startupDestinationAfterLoad(false, false, null, "saved-book", false, false), null);
});

test("a live listing that drops the restoring book reveals the Shelf", () => {
  // Cached shelf: in progress, so Reading was chosen and the restore started.
  // Live shelf: finished elsewhere, which cancels that restore before it
  // could reveal the view.
  assert.deepEqual(
    startupDestinationAfterLoad(true, false, null, "finished-book", true, true),
    { tab: "shelf", reveal: true }
  );
});

test("later loads leave a resolved or revealed launch alone", () => {
  assert.equal(startupDestinationAfterLoad(true, false, "saved-book", "saved-book", true, true), null);
  assert.equal(startupDestinationAfterLoad(true, true, null, "finished-book", true, true), null);
  assert.equal(startupDestinationAfterLoad(false, true, "saved-book", "saved-book", true, true), null);
});
