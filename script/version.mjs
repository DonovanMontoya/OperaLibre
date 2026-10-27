// The one place OperaLibre's version is changed. Every package carries the
// version of the stable release tag it ships as; this script writes and checks
// all of them together. AGENTS.md "Versions" describes the release flow.
//
//   node script/version.mjs check [--tag X.Y.Z]  every file agrees (and matches the tag)
//   node script/version.mjs set X.Y.Z            next release; app builds restart at 1
//   node script/version.mjs build [N]            re-upload the same release as build N
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
  serverLock: [/(name = "operalibre-server"\nversion = ")([^"]+)(")/, "serverLock"],
  launcher: [CARGO_VERSION, "launcher"],
  launcherLock: [/(name = "operalibre-launcher"\nversion = ")([^"]+)(")/, "launcherLock"],
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
export function versionProblems(fields, tag) {
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
  const tagVersion = tag?.replace(/^v/, "");
  if (tagVersion && tagVersion !== version) {
    problems.push(`The release tag is ${tag} but this source is version ${version}. Run \`node script/version.mjs set ${tagVersion}\` on main first.`);
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
    const tagIndex = args.indexOf("--tag");
    const problems = versionProblems(fields, tagIndex >= 0 ? args[tagIndex + 1] : undefined);
    if (problems.length) fail(problems.join("\n"));
    console.log(`${fields.server} (build ${fields.iosBuild})`);
  } else if (command === "set") {
    const version = args[0]?.replace(/^v/, "");
    parseVersion(version);
    const released = git("tag", "--list").split("\n").filter((tag) => STABLE.test(tag));
    const highest = released.sort(compareStableTags).at(-1);
    if (highest && compareStableTags(version, highest) <= 0) {
      fail(`${version} is not newer than the latest release tag ${highest}. Fetch tags if that looks wrong.`);
    }
    const changes = { ...Object.fromEntries(VERSION_FIELDS.map((name) => [name, version])), ...buildFields(version, 1) };
    save(texts, writeFields(texts, changes));
    console.log(`Set every package to ${version}, app build 1.`);
  } else if (command === "build") {
    const version = fields.server;
    const tags = git("tag", "--points-at", "HEAD").split("\n");
    if (!tags.includes(version)) fail(`App builds come from a release tag; check out ${version} first.`);
    const build = args[0] ? Number(args[0]) : Number(fields.iosBuild) + 1;
    save(texts, writeFields(texts, buildFields(version, build)));
    console.log(`${version} app build ${build}. Record it in docs/ios-changelog.md on main.`);
  } else {
    fail("usage: node script/version.mjs check [--tag X.Y.Z] | set X.Y.Z | build [N]");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
}
