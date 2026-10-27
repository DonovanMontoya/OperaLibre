import assert from "node:assert/strict";
import test from "node:test";
import { androidVersionCode, bumpBuild, readFields, setApp, setServer, versionProblems, writeFields } from "./version.mjs";

const texts = {
  server: '[package]\nname = "operalibre-server"\nversion = "0.5.0"\n\n[dependencies.foo]\nversion = "9.9.9"\n',
  serverLock: '[[package]]\nname = "operalibre-server"\nversion = "0.5.0"\n',
  launcher: '[package]\nname = "operalibre-launcher"\nversion = "0.5.0"\n',
  launcherLock: '[[package]]\nname = "operalibre-launcher"\nversion = "0.5.0"\n',
  android: '        versionCode 1030201\n        versionName "1.3.2"\n',
  ios: ["Debug", "Release"].map(() => "CURRENT_PROJECT_VERSION = 1;\nMARKETING_VERSION = 1.3.2;\n").join("")
};
const fields = readFields(texts);
const apply = (changes) => readFields(writeFields(texts, changes));

test("Android version codes keep rising across builds and app versions", () => {
  assert.equal(androidVersionCode("1.3.2", 1), 1030201);
  // Play needs the code to rise; the last code published before this scheme was 14.
  assert.ok(androidVersionCode("1.3.2", 1) > 14);
  assert.ok(androidVersionCode("1.3.2", 99) < androidVersionCode("1.3.3", 1));
  assert.ok(androidVersionCode("1.99.99", 99) < androidVersionCode("2.0.0", 1));
  assert.throws(() => androidVersionCode("1.3.2", 100));
  assert.throws(() => androidVersionCode("1.100.0", 1));
});

test("the server and app lines are checked separately", () => {
  assert.equal(fields.server, "0.5.0");
  assert.equal(fields.iosVersion, "1.3.2");
  assert.deepEqual(versionProblems(fields), []);
});

test("a line that disagrees with itself is reported", () => {
  const android = readFields({ ...texts, android: texts.android.replace('"1.3.2"', '"0.2.6"') });
  assert.match(versionProblems(android).join(), /app: androidName is 0.2.6/);
  const launcher = readFields({ ...texts, launcher: texts.launcher.replace("0.5.0", "0.4.17") });
  assert.match(versionProblems(launcher).join(), /server: launcher is 0.4.17/);
  const code = readFields({ ...texts, android: texts.android.replace("1030201", "1030202") });
  assert.match(versionProblems(code).join(), /versionCode is 1030202, expected 1030201/);
  assert.throws(() => readFields({ ...texts, ios: texts.ios.replace("MARKETING_VERSION = 1.3.2", "MARKETING_VERSION = 1.2.6") }),
    /differs between build configurations/);
});

test("set server changes only the crates and lockfiles", () => {
  const next = writeFields(texts, setServer(fields, "0.5.1"));
  const after = readFields(next);
  assert.equal(after.server, "0.5.1");
  assert.equal(after.launcherLock, "0.5.1");
  assert.equal(next.android, texts.android);
  assert.equal(next.ios, texts.ios);
  assert.match(next.server, /\[dependencies.foo\]\nversion = "9.9.9"/);
  assert.deepEqual(versionProblems(after), []);
});

test("set app restarts the build at 1 and can only go up", () => {
  const built = apply(bumpBuild(fields));
  const next = writeFields(writeFields(texts, bumpBuild(fields)), setApp(built, "1.4.0"));
  const after = readFields(next);
  assert.equal(after.iosVersion, "1.4.0");
  assert.equal(after.iosBuild, "1");
  assert.equal(after.androidCode, "1040001");
  assert.equal(after.server, "0.5.0");
  assert.equal(next.ios.match(/MARKETING_VERSION = 1.4.0/g).length, 2);
  assert.deepEqual(versionProblems(after), []);
  assert.throws(() => setApp(fields, "1.3.2"), /not above/);
  assert.throws(() => setApp(fields, "1.3.1"), /not above/);
  assert.throws(() => setApp(fields, "0.5.1"), /not above/);
});

test("build raises the shared build number without touching versions", () => {
  const next = apply(bumpBuild(fields));
  assert.equal(next.iosBuild, "2");
  assert.equal(next.androidCode, "1030202");
  assert.equal(next.iosVersion, "1.3.2");
  assert.equal(apply(bumpBuild(fields, "5")).androidCode, "1030205");
  assert.throws(() => bumpBuild(fields, "1"), /not above/);
  assert.throws(() => bumpBuild(fields, "abc"), /not above/);
  assert.throws(() => bumpBuild(apply(bumpBuild(fields, "99"))), /1 to 99/);
});

test("Windows line endings in lockfiles are still read", () => {
  const crlf = { ...texts, serverLock: texts.serverLock.replaceAll("\n", "\r\n") };
  assert.equal(readFields(crlf).serverLock, "0.5.0");
});
