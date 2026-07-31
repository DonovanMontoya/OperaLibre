import assert from "node:assert/strict";
import test from "node:test";

import {
  isIPadNavigator,
  readStoredRotationLock,
  supportsRotationLock
} from "../src/rotationLock.ts";

const iphoneNavigator = {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
  platform: "iPhone",
  maxTouchPoints: 5
};

const ipadNavigator = {
  userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)",
  platform: "iPad",
  maxTouchPoints: 5
};

test("recognizes iPads using their native user agent", () => {
  assert.equal(isIPadNavigator(ipadNavigator), true);
});

test("recognizes iPads that identify as a touch-capable Mac", () => {
  assert.equal(isIPadNavigator({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
    platform: "MacIntel",
    maxTouchPoints: 5
  }), true);
});

test("does not mistake a Mac or iPhone for an iPad", () => {
  assert.equal(isIPadNavigator({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
    platform: "MacIntel",
    maxTouchPoints: 0
  }), false);
  assert.equal(isIPadNavigator(iphoneNavigator), false);
});

test("offers rotation lock on native phones but not on iPad or the web", () => {
  assert.equal(supportsRotationLock(true, "ios", iphoneNavigator), true);
  assert.equal(supportsRotationLock(true, "android", iphoneNavigator), true);
  assert.equal(supportsRotationLock(true, "ios", ipadNavigator), false);
  assert.equal(supportsRotationLock(false, "ios", iphoneNavigator), false);
});

test("reads only valid persisted lock orientations", () => {
  const storage = {
    value: "landscape-secondary" as string | null,
    getItem() { return this.value; },
    setItem(_key: string, value: string) { this.value = value; },
    removeItem() { this.value = null; }
  };

  assert.equal(readStoredRotationLock(storage), "landscape-secondary");
  storage.value = "true";
  assert.equal(readStoredRotationLock(storage), null);
});
