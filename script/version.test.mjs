import assert from "node:assert/strict";
import test from "node:test";
import { androidVersionCode, readFields, versionProblems, writeFields } from "./version.mjs";

const texts = {
  server: '[package]\nname = "operalibre-server"\nversion = "1.3.2"\n\n[dependencies.foo]\nversion = "9.9.9"\n',
  serverLock: '[[package]]\nname = "operalibre-server"\nversion = "1.3.2"\n',
  launcher: '[package]\nname = "operalibre-launcher"\nversion = "1.3.2"\n',
  launcherLock: '[[package]]\nname = "operalibre-launcher"\nversion = "1.3.2"\n',
  android: '        versionCode 1030201\n        versionName "1.3.2"\n',
  ios: ["Debug", "Release"].map(() => "CURRENT_PROJECT_VERSION = 1;\nMARKETING_VERSION = 1.3.2;\n").join("")
};

test("Android version codes keep rising across builds and releases", () => {
  assert.equal(androidVersionCode("1.3.2", 1), 1030201);
  assert.ok(androidVersionCode("1.3.2", 99) < androidVersionCode("1.3.3", 1));
  assert.ok(androidVersionCode("1.99.99", 99) < androidVersionCode("2.0.0", 1));
  assert.throws(() => androidVersionCode("1.3.2", 100));
  assert.throws(() => androidVersionCode("1.100.0", 1));
});

test("a consistent checkout passes and must match the release tag", () => {
  const fields = readFields(texts);
  assert.deepEqual(versionProblems(fields), []);
  assert.deepEqual(versionProblems(fields, "1.3.2"), []);
  assert.equal(versionProblems(fields, "1.3.3").length, 1);
});

test("a hand-edited native version is reported", () => {
  const drifted = readFields({ ...texts, android: texts.android.replace('"1.3.2"', '"0.2.6"') });
  assert.match(versionProblems(drifted).join(), /androidName is 0.2.6/);
  assert.throws(() => readFields({ ...texts, ios: texts.ios.replace("MARKETING_VERSION = 1.3.2", "MARKETING_VERSION = 1.2.6") }),
    /differs between build configurations/);
});

test("setting a version changes every package and nothing else", () => {
  const next = writeFields(texts, { server: "1.4.0", serverLock: "1.4.0", launcher: "1.4.0", launcherLock: "1.4.0",
    androidName: "1.4.0", androidCode: androidVersionCode("1.4.0", 1), iosVersion: "1.4.0", iosBuild: 1 });
  assert.deepEqual(versionProblems(readFields(next), "1.4.0"), []);
  assert.match(next.server, /\[dependencies.foo\]\nversion = "9.9.9"/);
  assert.equal(next.ios.match(/MARKETING_VERSION = 1.4.0/g).length, 2);
});

test("release tags are compared without their optional v prefix", () => {
  assert.deepEqual(versionProblems(readFields(texts), "v1.3.2"), []);
  assert.equal(versionProblems(readFields(texts), "v1.3.3").length, 1);
});
