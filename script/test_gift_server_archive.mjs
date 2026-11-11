import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const fixture = process.env.OPERALIBRE_GIFT_NATIVE_ARCHIVE_FIXTURE;
const root = fileURLToPath(new URL("../", import.meta.url));
test("actual Rust HTTP selected archive imports through the Android host extractor", { skip: !fixture }, async () => {
  const value = JSON.parse(await readFile(fixture, "utf8"));
  assert.ok(Array.isArray(value.assets) && value.assets.length > 0 && value.assets.length <= 256);
  const scratch = await mkdtemp(path.join(tmpdir(), "operalibre-gift-interop-"));
  const archive = path.join(scratch, "selected.zip");
  await writeFile(archive, Buffer.from(value.archiveBase64, "base64"));
  const sources = ["apps/web/android/app/src/main/java/com/operalibre/mobile/GiftArchiveExtractor.java", "apps/web/android/tests/GiftServerArchiveInteropTest.java"];
  const java = process.env.OPERALIBRE_TEST_JAVA ?? "java";
  const compiler = process.env.OPERALIBRE_TEST_JAVA_COMPILER_MODULE === "1" ? java : "javac";
  const compilerArgs = process.env.OPERALIBRE_TEST_JAVA_COMPILER_MODULE === "1" ? ["--module", "jdk.compiler/com.sun.tools.javac.Main"] : [];
  const built = spawnSync(compiler, [...compilerArgs, "-d", scratch, ...sources], { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.equal(built.error, undefined); assert.equal(built.status, 0, built.stderr);
  const args = value.assets.flatMap(asset => {
    assert.equal(typeof asset.name, "string"); assert.ok(asset.name.length <= 255 && !/[\\/\x00-\x1f\x7f]/.test(asset.name));
    assert.ok(Number.isSafeInteger(asset.size) && asset.size >= 0); assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    return [asset.name, String(asset.size), asset.sha256];
  });
  const extracted = spawnSync(java, ["-cp", scratch, "GiftServerArchiveInteropTest", archive, ...args], { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.equal(extracted.error, undefined); assert.equal(extracted.status, 0, extracted.stderr);
  assert.match(extracted.stdout, /Actual server-selected ZIP extracted and verified/);
});
