import assert from "node:assert/strict";
import test from "node:test";
import { androidReleaseName } from "./stage_android_release.mjs";

const gradle = 'versionCode 1030206\nversionName "1.3.2"\n';
const badging = "package: name='com.operalibre.mobile' versionCode='1030206' versionName='1.3.2' platformBuildVersionName='16'\n";

test("the download names the embedded app version and build independently of the server release", () => {
  assert.equal(androidReleaseName(badging, gradle), "operalibre-app-1.3.2-build.6-android-unsigned.apk");
});

test("a stale or mismatched APK cannot be published", () => {
  assert.throws(() => androidReleaseName(badging.replace("1030206", "1030205"), gradle), /build differs/);
  assert.throws(() => androidReleaseName(badging.replaceAll("1.3.2", "1.3.1").replace("1030206", "1030106"), gradle), /version differs/);
  assert.throws(() => androidReleaseName(badging.replace("com.operalibre.mobile", "another.app"), gradle), /package/);
  assert.throws(() => androidReleaseName("", gradle), /package/);
  assert.throws(() => androidReleaseName(badging.replace("1.3.2", "../../bad"), gradle), /Invalid APK version/);
  assert.throws(() => androidReleaseName(badging.replace("1030206", "1030200"), gradle), /build numbers/);
});
