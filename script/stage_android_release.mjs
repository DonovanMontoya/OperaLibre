import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { androidVersionCode } from "./version.mjs";

export function androidReleaseName(badging, gradle) {
  const manifest = badging.split(/\r?\n/).find((line) => line.startsWith("package: "));
  const attribute = (name) => manifest?.match(new RegExp(`\\b${name}='([^']*)'`))?.[1];
  const version = attribute("versionName");
  const code = attribute("versionCode");
  assert.equal(attribute("name"), "com.operalibre.mobile", "Unexpected APK package");
  assert.match(version ?? "", /^\d+\.\d+\.\d+$/, "Invalid APK version");
  assert.match(code ?? "", /^[1-9]\d*$/, "Invalid APK version code");
  const build = Number(code) % 100;
  assert.equal(Number(code), androidVersionCode(version, build), "Invalid APK build number");
  assert.equal(version, gradle.match(/\bversionName "([^"]+)"/)?.[1], "APK version differs from source");
  assert.equal(code, gradle.match(/\bversionCode (\d+)/)?.[1], "APK build differs from source");
  return `operalibre-app-${version}-build.${build}-android-unsigned.apk`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [apk, aapt, output = "dist"] = process.argv.slice(2);
  assert.ok(apk && aapt, "Usage: stage_android_release.mjs APK AAPT [OUTPUT]");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const badging = execFileSync(aapt, ["dump", "badging", apk], { encoding: "utf8" });
  const gradle = readFileSync(join(root, "apps/web/android/app/build.gradle"), "utf8");
  const destination = join(output, androidReleaseName(badging, gradle));
  mkdirSync(output, { recursive: true });
  copyFileSync(apk, destination);
  console.log(`Staged ${basename(destination)}`);
}
