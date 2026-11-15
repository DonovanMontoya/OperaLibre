// The one place OperaLibre's versions are changed. There are two independent
// lines; AGENTS.md "Versions" describes them.
//
//   server: the server and launcher crates. It follows the stable release
//           tags (0.5.0, then 0.5.1-nightly.* until 0.5.1). Release builds
//           report the tag they ship as; the crate version is what a source
//           build reports.
//   app:    the iOS and Android apps, versioned for the stores (1.3.2). Both
//           share one build number; Android's versionCode packs version and
//           build into one rising integer.
//
//   node script/version.mjs check            each line agrees with itself
//   node script/version.mjs set server X.Y.Z
//   node script/version.mjs set app X.Y.Z    app builds restart at 1
//   node script/version.mjs build [N]        next app build, or build N
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareStableTags } from "./resolve_release.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const MAX_BUILD = 99;

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
  if (!match) throw new Error(`${version} is not a version such as 1.3.2.`);
  return match.slice(1).map(Number);
}

export function androidVersionCode(version, build) {
  const [major, minor, patch] = parseVersion(version);
  if (minor > 99 || patch > 99) throw new Error(`${version}: minor and patch must stay below 100 for Android version codes.`);
  if (!Number.isInteger(build) || build < 1 || build > MAX_BUILD) throw new Error(`App build numbers run from 1 to ${MAX_BUILD}.`);
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
// The fields that carry each line's version. The app line's build lives in
// iosBuild and androidCode.
export const LINES = {
  server: ["server", "serverLock", "launcher", "launcherLock"],
  app: ["iosVersion", "androidName"]
};

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

// Returns the problems within each line; empty when each line agrees with
// itself. The two lines are not compared with each other or with git tags.
export function versionProblems(fields) {
  const problems = [];
  for (const [line, names] of Object.entries(LINES)) {
    const version = fields[names[0]];
    try {
      parseVersion(version);
    } catch (error) {
      problems.push(`${line}: ${error.message}`);
      continue;
    }
    for (const name of names.slice(1)) {
      if (fields[name] !== version) problems.push(`${line}: ${name} is ${fields[name]}, expected ${version} like ${names[0]}.`);
    }
  }
  const version = fields.iosVersion;
  if (!/^[1-9]\d*$/.test(fields.iosBuild) || Number(fields.iosBuild) > MAX_BUILD) {
    problems.push(`app: iOS build is ${fields.iosBuild}; app builds run from 1 to ${MAX_BUILD}.`);
  } else if (STABLE.test(version)) {
    try {
      const expected = androidVersionCode(version, Number(fields.iosBuild));
      if (Number(fields.androidCode) !== expected) {
        problems.push(`app: Android versionCode is ${fields.androidCode}, expected ${expected} for ${version} build ${fields.iosBuild}.`);
      }
    } catch (error) {
      problems.push(`app: ${error.message}`);
    }
  }
  return problems;
}

// The changes for `set server`, `set app`, and `build`. Each throws when the
// request would break its line's rules.
export function setServer(fields, version) {
  parseVersion(version);
  return Object.fromEntries(LINES.server.map((name) => [name, version]));
}

// Store versions and Android version codes can only rise, so a new app
// version must be above the current one.
export function setApp(fields, version) {
  androidVersionCode(version, 1);
  try {
    parseVersion(fields.iosVersion);
  } catch {
    throw new Error(`The current app version ${fields.iosVersion} is not X.Y.Z; fix the iOS project before setting a new one.`);
  }
  if (compareStableTags(version, fields.iosVersion) <= 0) {
    throw new Error(`App version ${version} is not above the current ${fields.iosVersion}; store versions can only rise.`);
  }
  return { iosVersion: version, androidName: version, ...appBuild(version, 1) };
}

export function bumpBuild(fields, requested) {
  const current = Number(fields.iosBuild);
  const build = requested === undefined ? current + 1 : Number(requested);
  if (!Number.isInteger(build)) {
    throw new Error(`Build ${requested} is not a whole number.`);
  }
  if (build <= current) {
    throw new Error(`Build ${requested ?? build} is not above the current build ${current}; each upload of ${fields.iosVersion} needs a higher number.`);
  }
  return appBuild(fields.iosVersion, build);
}

function appBuild(version, build) {
  return { androidCode: androidVersionCode(version, build), iosBuild: build };
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

function releaseTags() {
  try {
    const output = execFileSync("git", ["-C", ROOT, "tag", "--list"], { encoding: "utf8" });
    return output.split("\n").map((tag) => tag.trim().replace(/^v/, "")).filter((tag) => STABLE.test(tag));
  } catch {
    return [];
  }
}

const USAGE = "usage: node script/version.mjs check | set server X.Y.Z | set app X.Y.Z | build [N]";

function main([command, ...args]) {
  const texts = load();
  const fields = readFields(texts);
  const summary = (f) => `server ${f.server}, app ${f.iosVersion} (build ${f.iosBuild})`;
  if (command === "check") {
    const problems = versionProblems(fields);
    if (problems.length) throw new Error(problems.join("\n"));
    console.log(summary(fields));
    return;
  }
  let changes;
  if (command === "set" && args[0] === "server" && args[1]) {
    const version = args[1].replace(/^v/, "");
    changes = setServer(fields, version);
    // The server line follows the release tags; a version with no tag yet is
    // allowed (the release stamps the tag into its builds) but worth a note.
    if (!releaseTags().includes(version)) console.warn(`Note: no ${version} release tag here yet. Fetch tags if that looks wrong.`);
    if (compareStableTags(version, fields.server) < 0) console.warn(`Note: ${version} is below the current server version ${fields.server}.`);
  } else if (command === "set" && args[0] === "app" && args[1]) {
    changes = setApp(fields, args[1]);
  } else if (command === "build" && args.length <= 1) {
    changes = bumpBuild(fields, args[0]);
  } else {
    throw new Error(USAGE);
  }
  const next = writeFields(texts, changes);
  save(texts, next);
  console.log(summary(readFields(next)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
