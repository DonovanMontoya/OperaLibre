// The one place OperaLibre's version is changed. Every package carries the
// version of the stable release tag it ships as; this script writes and checks
// all of them together. AGENTS.md "Versions" describes the release flow.
//
//   node script/version.mjs check [--tag X.Y.Z] [--nightly TAG]
//       every file agrees, and matches a release tag (promoted from nightly TAG)
//   node script/version.mjs set X.Y.Z    next release; app builds restart at 1
//   node script/version.mjs build [N]    re-upload the same release as build N
//
// iOS and Android share the build number: the iOS bundle version is N, and
// Android's versionCode packs version and build into one rising integer.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareStableTags } from "./resolve_release.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
// Release tags may carry a leading v (see resolve_release.mjs); versions never do.
const RELEASE_TAG = /^v?\d+\.\d+\.\d+$/;
const tagVersion = (tag) => tag.replace(/^v/, "");

const FILES = {
  server: "apps/server/Cargo.toml",
  serverLock: "apps/server/Cargo.lock",
  launcher: "apps/launcher/Cargo.toml",
  launcherLock: "apps/launcher/Cargo.lock",
  android: "apps/web/android/app/build.gradle",
  ios: "apps/web/ios/App/App.xcodeproj/project.pbxproj"
};

export function parseVersion(version) {
  const match = STABLE.exec(version);
  if (!match) throw new Error(`${version} is not a stable version such as 1.3.2.`);
  const parts = match.slice(1).map(Number);
  if (parts[1] > 99 || parts[2] > 99) throw new Error(`${version}: minor and patch must stay below 100 for Android version codes.`);
  return parts;
}

export function androidVersionCode(version, build) {
  const [major, minor, patch] = parseVersion(version);
  if (!Number.isInteger(build) || build < 1 || build > 99) throw new Error("App build numbers run from 1 to 99.");
  return major * 1_000_000 + minor * 10_000 + patch * 100 + build;
}

// Each field is [pattern, file key]; patterns capture the value as group 2
// so a write keeps everything around it. Global patterns cover the Debug and
// Release configurations, which must agree.
const CARGO_VERSION = /^(version = ")([^"]+)(")/m;
const FIELDS = {
  server: [CARGO_VERSION, "server"],
  serverLock: [/(name = "operalibre-server"\r?\nversion = ")([^"]+)(")/, "serverLock"],
  launcher: [CARGO_VERSION, "launcher"],
  launcherLock: [/(name = "operalibre-launcher"\r?\nversion = ")([^"]+)(")/, "launcherLock"],
  androidName: [/(versionName ")([^"]+)(")/, "android"],
  androidCode: [/(versionCode )(\d+)()/, "android"],
  iosVersion: [/(MARKETING_VERSION = )([^;]+)(;)/g, "ios"],
  iosBuild: [/(CURRENT_PROJECT_VERSION = )([^;]+)(;)/g, "ios"]
};
// Fields that must all equal the release version; the rest carry the build.
const VERSION_FIELDS = ["server", "serverLock", "launcher", "launcherLock", "androidName", "iosVersion"];

function buildFields(version, build) {
  return { androidCode: androidVersionCode(version, build), iosBuild: build };
}

export function readFields(texts) {
  const fields = {};
  for (const [name, [pattern, file]] of Object.entries(FIELDS)) {
    const values = pattern.global ? [...texts[file].matchAll(pattern)].map((m) => m[2]) : [pattern.exec(texts[file])?.[2]].filter(Boolean);
    if (values.length === 0) throw new Error(`${FILES[file]}: no ${name} found.`);
    if (new Set(values).size > 1) throw new Error(`${FILES[file]}: ${name} differs between build configurations (${values.join(", ")}).`);
    fields[name] = values[0];
  }
  return fields;
}

// Returns the problems with a checkout's versions; empty when they all agree.
export function versionProblems(fields, tag, sourceNightly) {
  const problems = [];
  const version = fields.server;
  try {
    parseVersion(version);
  } catch (error) {
    return [error.message];
  }
  for (const name of VERSION_FIELDS) {
    if (fields[name] !== version) problems.push(`${name} is ${fields[name]}, expected ${version}.`);
  }
  const build = Number(fields.iosBuild);
  if (!/^[1-9]\d?$/.test(fields.iosBuild)) {
    problems.push(`iOS build is ${fields.iosBuild}; app builds run from 1 to 99.`);
  } else if (Number(fields.androidCode) !== androidVersionCode(version, build)) {
    problems.push(`Android versionCode is ${fields.androidCode}, expected ${androidVersionCode(version, build)} for ${version} build ${build}.`);
  }
  if (tag && tagVersion(tag) !== version) {
    // A blank dispatch tag picks the next patch, which is behind main after a
    // minor or major bump, so point at the tag rather than at moving main back.
    // A promoted nightly's source cannot change, so behind it is only a hint.
    const behind = !(RELEASE_TAG.test(tag) && compareStableTags(version, tag) > 0);
    problems.push(`The release tag is ${tag} but this source is version ${version}. ${
      !behind ? `Dispatch the release with tag ${version}.`
        : sourceNightly ? `${sourceNightly} was built before main was set to ${tagVersion(tag)}; promote a nightly built after that change.`
          : `Run \`node script/version.mjs set ${tagVersion(tag)}\` on main first.`}`);
  }
  return problems;
}

export function writeFields(texts, changes) {
  const next = { ...texts };
  for (const [name, value] of Object.entries(changes)) {
    const [pattern, file] = FIELDS[name];
    next[file] = next[file].replace(pattern, (_, before, _old, after) => `${before}${value}${after}`);
  }
  return next;
}

function load() {
  return Object.fromEntries(Object.entries(FILES).map(([key, path]) => [key, readFileSync(join(ROOT, path), "utf8")]));
}

function save(before, after) {
  for (const [key, path] of Object.entries(FILES)) {
    if (after[key] !== before[key]) writeFileSync(join(ROOT, path), after[key]);
  }
}

function git(...args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main([command, ...args]) {
  const texts = load();
  const fields = readFields(texts);
  if (command === "check") {
    const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined) || undefined;
    const problems = versionProblems(fields, option("--tag"), option("--nightly"));
    if (problems.length) fail(problems.join("\n"));
    console.log(`${fields.server} (build ${fields.iosBuild})`);
  } else if (command === "set") {
    const version = tagVersion(args[0] ?? "");
    parseVersion(version);
    const released = git("tag", "--list").split("\n").filter((tag) => RELEASE_TAG.test(tag));
    const highest = released.sort(compareStableTags).at(-1);
    if (highest && compareStableTags(version, highest) <= 0) {
      fail(`${version} is not newer than the latest release tag ${highest}. Fetch tags if that looks wrong.`);
    }
    // Store versions and Android version codes can only rise.
    if (compareStableTags(version, fields.server) < 0) fail(`${version} is older than this source's version ${fields.server}.`);
    const changes = { ...Object.fromEntries(VERSION_FIELDS.map((name) => [name, version])), ...buildFields(version, 1) };
    save(texts, writeFields(texts, changes));
    console.log(`Set every package to ${version}, app build 1.`);
  } else if (command === "build") {
    const version = fields.server;
    const tags = git("tag", "--points-at", "HEAD").split("\n").map(tagVersion);
    if (!tags.includes(version)) fail(`App builds come from a release tag; check out ${version} first.`);
    const build = args[0] ? Number(args[0]) : Number(fields.iosBuild) + 1;
    save(texts, writeFields(texts, buildFields(version, build)));
    console.log(`${version} app build ${build}. Record it in docs/ios-changelog.md on main.`);
  } else {
    fail("usage: node script/version.mjs check [--tag X.Y.Z [--nightly TAG]] | set X.Y.Z | build [N]");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
}
