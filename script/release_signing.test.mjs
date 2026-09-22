import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
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

test("signing a directory writes a verifiable signature beside every asset", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "operalibre-signing-test-"));
  try {
    await writeFile(path.join(directory, "operalibre-1.2.3-frontend.zip"), "frontend bytes");
    await writeFile(path.join(directory, "operalibre-1.2.3-update-linux-x64.zip"), "update bytes");
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
