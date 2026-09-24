import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RELEASE_SIGNING_PUBLIC_KEY,
  isUpdaterAsset,
  privateKeyFromSeed,
  publicKeyBase64,
  signAsset,
  signDirectory,
  signingMessage
} from "./release_signing.mjs";

// Test-only key: the seed is the bytes 0..31. The same vector is checked by
// the Rust and Swift verifiers, so a change to the message format that only
// one side picks up fails there too.
const TEST_SEED = Buffer.from([...Array(32).keys()]).toString("base64");
const TEST_PUBLIC_KEY = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
const TEST_FRONTEND_SIGNATURE =
  "S+dfVq5MbRa7X9TiSmWdMb8qv4UBayZ3Pyvq3czipsJY4dwCmJrHejnU9Rh8MFjW7I0vDGxFpDSb3AP0dfZTBQ==";

function publicKeyObject(base64) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(base64, "base64")]),
    format: "der",
    type: "spki"
  });
}

test("the shared test vector is stable", () => {
  const key = privateKeyFromSeed(TEST_SEED);
  assert.equal(publicKeyBase64(key), TEST_PUBLIC_KEY);
  assert.equal(
    signAsset(key, "v1.2.3", "operalibre-1.2.3-frontend.zip", "b".repeat(64)),
    TEST_FRONTEND_SIGNATURE
  );
});

test("the signer expects the public key embedded in both updaters", async () => {
  for (const source of [
    "../apps/server/src/updates.rs",
    "../apps/macos/Sources/OperaLibre/ReleaseSignature.swift"
  ]) {
    const contents = await readFile(fileURLToPath(new URL(source, import.meta.url)), "utf8");
    assert.ok(contents.includes(`"${RELEASE_SIGNING_PUBLIC_KEY}"`), source);
  }
});

test("a signature binds the tag, the asset name and the digest", () => {
  const publicKey = publicKeyObject(TEST_PUBLIC_KEY);
  const signature = Buffer.from(TEST_FRONTEND_SIGNATURE, "base64");
  const verifies = (tag, name, digest) => verify(null, signingMessage(tag, name, digest), publicKey, signature);
  assert.ok(verifies("v1.2.3", "operalibre-1.2.3-frontend.zip", "b".repeat(64)));
  assert.ok(verifies("v1.2.3", "operalibre-1.2.3-frontend.zip", "B".repeat(64)), "digest case is normalized");
  assert.ok(!verifies("v1.2.2", "operalibre-1.2.3-frontend.zip", "b".repeat(64)));
  assert.ok(!verifies("v1.2.3", "operalibre-1.2.3-update-linux-x64.zip", "b".repeat(64)));
  assert.ok(!verifies("v1.2.3", "operalibre-1.2.3-frontend.zip", "c".repeat(64)));
});

test("only the packages an updater downloads are signed", () => {
  for (const name of [
    "operalibre-1.2.3-frontend.zip",
    "operalibre-1.2.3-update-linux-x64.zip",
    "operalibre-1.2.3-update-windows-x64.zip",
    "operalibre-readalong-sync-1.0.0-macos-arm64.zip"
  ]) {
    assert.ok(isUpdaterAsset(name), name);
  }
  for (const name of [
    "operalibre-1.2.3-combined-linux-x64.tar.gz",
    "operalibre-1.2.3-server-windows-x64.zip",
    "operalibre-1.2.3-android-unsigned.apk",
    "operalibre-1.2.3-frontend.zip.sig",
    "SHA256SUMS.txt"
  ]) {
    assert.ok(!isUpdaterAsset(name), name);
  }
});

test("signing a directory writes a verifiable signature beside every updater package", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "operalibre-signing-test-"));
  try {
    await writeFile(path.join(directory, "operalibre-1.2.3-frontend.zip"), "frontend bytes");
    await writeFile(path.join(directory, "operalibre-1.2.3-update-linux-x64.zip"), "update bytes");
    await writeFile(path.join(directory, "operalibre-1.2.3-combined-linux-x64.tar.gz"), "combined bytes");
    const signed = await signDirectory(directory, "v1.2.3", privateKeyFromSeed(TEST_SEED));
    assert.deepEqual(signed, ["operalibre-1.2.3-frontend.zip", "operalibre-1.2.3-update-linux-x64.zip"]);

    // Signing again does not sign the signatures.
    assert.deepEqual(await signDirectory(directory, "v1.2.3", privateKeyFromSeed(TEST_SEED)), signed);

    const publicKey = publicKeyObject(TEST_PUBLIC_KEY);
    for (const name of signed) {
      const bytes = await readFile(path.join(directory, name));
      const digest = createHash("sha256").update(bytes).digest("hex");
      const signature = Buffer.from((await readFile(path.join(directory, `${name}.sig`), "utf8")).trim(), "base64");
      assert.ok(verify(null, signingMessage("v1.2.3", name, digest), publicKey, signature), name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a seed of the wrong length is refused", () => {
  assert.throws(() => privateKeyFromSeed(Buffer.alloc(16).toString("base64")), /32-byte/);
});

test("the signing command refuses a mismatched secret before writing signatures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "operalibre-signing-key-test-"));
  try {
    await writeFile(path.join(directory, "update.zip"), "update bytes");
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./release_signing.mjs", import.meta.url)), "sign", directory, "v1.2.3"
    ], {
      encoding: "utf8",
      env: { ...process.env, OPERALIBRE_RELEASE_SIGNING_KEY: TEST_SEED }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match the public key/);
    assert.deepEqual(await readdir(directory), ["update.zip"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
