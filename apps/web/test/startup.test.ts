import assert from "node:assert/strict";
import test from "node:test";
import {
  canResolveStartupNavigation,
  canRestoreCachedNativeSession,
  shouldAcceptNativeTrackChange,
  shouldRefreshMediaCredential
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
