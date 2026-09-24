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
  addSignature,
  envelopeMessage,
  isLegacyUpdaterAsset,
  isValidRoot,
  keyId,
  privateKeyFromSeed,
  publicKeyBase64,
  readTrust,
  signAsset,
  signDirectory,
  signEnvelope,
  signingMessage,
  verifyManifestEnvelope
} from "./release_signing.mjs";
import { manifestPayload, releasePackages, syncAddonPackages } from "./release_manifest.mjs";

// Test-only keys: the seeds are the bytes 0..31 and 32..63. The Rust and
// Swift verifiers check the same vectors, so a change to a message format that
// only one side picks up fails there too.
const TEST_SEED = Buffer.from([...Array(32).keys()]).toString("base64");
const OTHER_SEED = Buffer.from([...Array(32).keys()].map((byte) => byte + 32)).toString("base64");
const TEST_PUBLIC_KEY = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
const TEST_FRONTEND_SIGNATURE =
  "S+dfVq5MbRa7X9TiSmWdMb8qv4UBayZ3Pyvq3czipsJY4dwCmJrHejnU9Rh8MFjW7I0vDGxFpDSb3AP0dfZTBQ==";
const FIXTURE = fileURLToPath(new URL("./fixtures/update-manifest.json", import.meta.url));
const SIGNER = fileURLToPath(new URL("./release_signing.mjs", import.meta.url));

function publicKeyObject(base64) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(base64, "base64")]),
    format: "der",
    type: "spki"
  });
}

function testPackage(overrides) {
  return {
    version: "1.2.3",
    url: "https://example.com/package",
    sha256: "b".repeat(64),
    size: 1024,
    format: "zip",
    ...overrides
  };
}

/// Covers everything a verifier has to handle, including entries a v1 client
/// must skip: an unknown component, an unknown format listed ahead of a known
/// one, a second interface version of the sync add-on and unknown fields.
function fixtureManifest(version, packages) {
  return `${JSON.stringify({
    type: "manifest",
    schema: 1,
    version,
    published: "2026-01-01T00:00:00.000Z",
    releaseUrl: `https://github.com/DonovanMontoya/OperaLibre/releases/tag/${version}`,
    notes: "Test notes",
    futureField: { ignored: true },
    bridges: [{ component: "server", below: "1.0.0", manifest: "https://example.com/bridge.json" }],
    packages
  }, null, 2)}\n`;
}

function buildFixture() {
  const key = privateKeyFromSeed(TEST_SEED);
  const other = privateKeyFromSeed(OTHER_SEED);
  const otherKey = publicKeyBase64(other);
  const packages = [
    testPackage({ component: "server", platform: "linux-x64", format: "tar.gz", root: "operalibre-1.2.3-combined-linux-x64" }),
    testPackage({ component: "server", platform: "windows-x64", format: "tar.zst", root: "operalibre-1.2.3-combined-windows-x64" }),
    testPackage({ component: "server", platform: "windows-x64", root: "operalibre-1.2.3-combined-windows-x64" }),
    testPackage({ component: "frontend", platform: "any", root: "operalibre-1.2.3-frontend" }),
    testPackage({ component: "future-component", platform: "linux-x64", root: "future" }),
    testPackage({ component: "readalong-sync", platform: "linux-x64", version: "1.0.0", root: "operalibre-readalong-sync-1.0.0-linux-x64", protocol: 1 }),
    testPackage({ component: "readalong-sync", platform: "linux-x64", version: "2.0.0", root: "operalibre-readalong-sync-2.0.0-linux-x64", protocol: 2 })
  ];
  const direct = fixtureManifest("1.2.3", packages);
  const rotation = `${JSON.stringify({
    type: "root",
    version: 2,
    threshold: 1,
    keys: [{ keyid: keyId(otherKey), publicKey: otherKey }]
  }, null, 2)}\n`;
  const rotated = fixtureManifest("1.2.4", packages);
  let rootEnvelope = { payload: rotation, signatures: [] };
  rootEnvelope = addSignature(rootEnvelope, signEnvelope(key, "root", rotation));
  rootEnvelope = addSignature(rootEnvelope, signEnvelope(other, "root", rotation));
  return {
    rootKeys: [TEST_PUBLIC_KEY],
    otherKey,
    direct: { payload: direct, signatures: [signEnvelope(key, "manifest", direct)] },
    rotated: { payload: rotated, signatures: [signEnvelope(other, "manifest", rotated)], roots: [rootEnvelope] }
  };
}

test("the shared legacy test vector is stable", () => {
  const key = privateKeyFromSeed(TEST_SEED);
  assert.equal(publicKeyBase64(key), TEST_PUBLIC_KEY);
  assert.equal(
    signAsset(key, "v1.2.3", "operalibre-1.2.3-frontend.zip", "b".repeat(64)),
    TEST_FRONTEND_SIGNATURE
  );
});

test("the checked-in manifest fixture matches the signer", async () => {
  const expected = `${JSON.stringify(buildFixture(), null, 2)}\n`;
  if (process.env.UPDATE_FIXTURES === "1") await writeFile(FIXTURE, expected);
  assert.equal(await readFile(FIXTURE, "utf8"), expected,
    "Run UPDATE_FIXTURES=1 node --test script/release_signing.test.mjs after changing the format.");
});

test("an envelope signature binds the type and the exact payload", () => {
  const key = privateKeyFromSeed(TEST_SEED);
  const publicKey = publicKeyObject(TEST_PUBLIC_KEY);
  const signature = Buffer.from(signEnvelope(key, "manifest", "{}").sig, "base64");
  assert.ok(verify(null, envelopeMessage("manifest", "{}"), publicKey, signature));
  assert.ok(!verify(null, envelopeMessage("root", "{}"), publicKey, signature));
  assert.ok(!verify(null, envelopeMessage("manifest", "{} "), publicKey, signature));
  assert.equal(signEnvelope(key, "manifest", "{}").keyid, keyId(TEST_PUBLIC_KEY));
});

test("adding a signature replaces an earlier one from the same key", () => {
  const key = privateKeyFromSeed(TEST_SEED);
  const once = addSignature({ payload: "{}", signatures: [] }, signEnvelope(key, "root", "{}"));
  const twice = addSignature(once, signEnvelope(key, "root", "{}"));
  assert.equal(twice.signatures.length, 1);
});

test("the signer and every verifier trust the same root keys", async () => {
  const trust = await readTrust();
  assert.ok(trust.rootKeys.includes(RELEASE_SIGNING_PUBLIC_KEY));
  const quoted = trust.rootKeys.map((key) => `"${key}"`);
  for (const source of [
    "../apps/server/src/update_manifest.rs",
    "../apps/macos/Sources/OperaLibre/ReleaseSignature.swift"
  ]) {
    const contents = await readFile(fileURLToPath(new URL(source, import.meta.url)), "utf8");
    const declared = contents.match(/ROOT_KEYS[^=]*=\s*&?\[([^\]]*)\]|releaseRootKeys[^=]*=\s*\[([^\]]*)\]/);
    assert.ok(declared, `${source} declares its root keys`);
    const keys = (declared[1] ?? declared[2]).match(/"[^"]+"/g);
    assert.deepEqual(keys, quoted, source);
  }
});

test("legacy signatures cover only the packages older servers download", () => {
  for (const name of ["operalibre-1.2.3-frontend.zip", "operalibre-1.2.3-update-linux-x64.zip"]) {
    assert.ok(isLegacyUpdaterAsset(name), name);
  }
  for (const name of [
    "operalibre-1.2.3-combined-linux-x64.tar.gz",
    "operalibre-readalong-sync-1.0.0-macos-arm64.zip",
    "operalibre-manifest-v1.json",
    "operalibre-1.2.3-frontend.zip.sig"
  ]) {
    assert.ok(!isLegacyUpdaterAsset(name), name);
  }
});

test("signing a directory writes a verifiable legacy signature beside each package", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "operalibre-signing-test-"));
  try {
    await writeFile(path.join(directory, "operalibre-1.2.3-frontend.zip"), "frontend bytes");
    await writeFile(path.join(directory, "operalibre-1.2.3-update-linux-x64.zip"), "update bytes");
    await writeFile(path.join(directory, "operalibre-1.2.3-combined-linux-x64.tar.gz"), "combined bytes");
    const signed = await signDirectory(directory, "v1.2.3", privateKeyFromSeed(TEST_SEED));
    assert.deepEqual(signed, ["operalibre-1.2.3-frontend.zip", "operalibre-1.2.3-update-linux-x64.zip"]);
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

test("signing refuses a key that is not a current root key before writing anything", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "operalibre-signing-key-test-"));
  try {
    await writeFile(path.join(directory, "operalibre-1.2.3-frontend.zip"), "frontend bytes");
    await writeFile(path.join(directory, "payload.json"), fixtureManifest("1.2.3", []));
    const env = { ...process.env, OPERALIBRE_RELEASE_SIGNING_KEY: TEST_SEED };
    for (const args of [
      ["sign", directory, "v1.2.3"],
      ["sign-envelope", "manifest", path.join(directory, "payload.json"), path.join(directory, "manifest.json")]
    ]) {
      const result = spawnSync(process.execPath, [SIGNER, ...args], { encoding: "utf8", env });
      assert.equal(result.status, 1, args[0]);
      assert.match(result.stderr, /not one of the current update root keys/);
    }
    assert.deepEqual((await readdir(directory)).sort(), ["operalibre-1.2.3-frontend.zip", "payload.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a root rotation collects signatures from each key into one envelope", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "operalibre-rotation-test-"));
  try {
    const payload = path.join(directory, "root.json");
    const envelope = path.join(directory, "root.envelope.json");
    const keys = [TEST_SEED, OTHER_SEED].map((seed) => {
      const publicKey = publicKeyBase64(privateKeyFromSeed(seed));
      return { keyid: keyId(publicKey), publicKey };
    });
    await writeFile(payload, `${JSON.stringify({ type: "root", version: 2, threshold: 1, keys })}\n`);
    for (const seed of [TEST_SEED, OTHER_SEED]) {
      const result = spawnSync(process.execPath, [SIGNER, "sign-envelope", "root", payload, envelope], {
        encoding: "utf8",
        env: { ...process.env, OPERALIBRE_RELEASE_SIGNING_KEY: seed }
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const signed = JSON.parse(await readFile(envelope, "utf8"));
    assert.equal(signed.payload, await readFile(payload, "utf8"));
    assert.equal(signed.signatures.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the release verifier accepts exactly what the updaters accept", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8"));
  assert.equal((await verifyManifestEnvelope(fixture.direct, fixture.rootKeys)).version, "1.2.3");
  assert.equal((await verifyManifestEnvelope(fixture.rotated, fixture.rootKeys)).version, "1.2.4");
  await assert.rejects(verifyManifestEnvelope({ ...fixture.rotated, roots: [] }, fixture.rootKeys));
  await assert.rejects(verifyManifestEnvelope(fixture.direct, [fixture.otherKey]));
});

test("a release manifest lists each platform package, the frontend and the sync add-on", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "operalibre-manifest-test-"));
  try {
    for (const name of [
      "operalibre-1.2.3-combined-linux-x64.tar.gz",
      "operalibre-1.2.3-combined-windows-x64.zip",
      "operalibre-1.2.3-frontend.zip",
      "operalibre-1.2.3-update-linux-x64.zip",
      "operalibre-1.2.3-android-unsigned.apk"
    ]) {
      await writeFile(path.join(directory, name), name);
    }
    const packages = [
      ...await releasePackages({ assets: directory, version: "1.2.3", tag: "1.2.3", repository: "o/r" }),
      ...syncAddonPackages({
        assets: [{
          name: "operalibre-readalong-sync-1.0.0-linux-x64.zip",
          browser_download_url: "https://example.com/sync.zip",
          size: 5,
          digest: `sha256:${"a".repeat(64)}`
        }]
      })
    ];
    assert.deepEqual(packages.map(({ component, platform, format, root }) => [component, platform, format, root]), [
      ["server", "linux-x64", "tar.gz", "operalibre-1.2.3-combined-linux-x64"],
      ["server", "windows-x64", "zip", "operalibre-1.2.3-combined-windows-x64"],
      ["frontend", "any", "zip", "operalibre-1.2.3-frontend"],
      ["readalong-sync", "linux-x64", "zip", "operalibre-readalong-sync-1.0.0-linux-x64"]
    ]);
    const linux = packages[0];
    assert.equal(linux.url, "https://github.com/o/r/releases/download/1.2.3/operalibre-1.2.3-combined-linux-x64.tar.gz");
    assert.equal(linux.size, "operalibre-1.2.3-combined-linux-x64.tar.gz".length);
    assert.equal(linux.sha256, createHash("sha256").update("operalibre-1.2.3-combined-linux-x64.tar.gz").digest("hex"));

    const payload = `${JSON.stringify(manifestPayload({
      version: "1.2.3", tag: "1.2.3", repository: "o/r", notes: "Notes", packages,
      policy: { bridges: [], notice: null }, published: "2026-01-01T00:00:00.000Z"
    }), null, 2)}\n`;
    const key = privateKeyFromSeed(TEST_SEED);
    const envelope = { payload, signatures: [signEnvelope(key, "manifest", payload)] };
    const manifest = await verifyManifestEnvelope(envelope, [TEST_PUBLIC_KEY]);
    assert.equal(manifest.packages.length, 4);
    assert.deepEqual(manifest.bridges, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the checked-in update policy is well formed", async () => {
  const policy = JSON.parse(await readFile(new URL("../release/update-policy.json", import.meta.url), "utf8"));
  assert.equal(typeof policy.legacyAssets, "boolean");
  assert.ok(Array.isArray(policy.bridges));
  for (const bridge of policy.bridges) {
    assert.match(bridge.below, /^\d+\.\d+\.\d+$/);
    assert.match(bridge.manifest, /^https:\/\//);
  }
});

test("a rotation the updaters would reject is refused by the release verifier too", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8"));
  const key = privateKeyFromSeed(TEST_SEED);
  const other = privateKeyFromSeed(OTHER_SEED);
  const otherKey = publicKeyBase64(other);
  const payload = fixture.rotated.payload;
  const good = { type: "root", version: 2, threshold: 1, keys: [{ keyid: keyId(otherKey), publicKey: otherKey }] };
  // Signed by the rotated-in key, so accepting any of these roots would
  // accept the manifest; only a valid rotation may.
  const envelopeWith = (root) => {
    const rotation = JSON.stringify(root);
    return {
      payload,
      signatures: [signEnvelope(other, "manifest", payload)],
      roots: [{ payload: rotation, signatures: [signEnvelope(key, "root", rotation), signEnvelope(other, "root", rotation)] }]
    };
  };
  assert.ok(isValidRoot(good));
  assert.equal((await verifyManifestEnvelope(envelopeWith(good), fixture.rootKeys)).version, "1.2.4");
  for (const root of [
    { ...good, threshold: 0 },
    { ...good, threshold: 0, keys: [] },
    { ...good, threshold: 2 },
    { ...good, keys: [{ keyid: "0000000000000000", publicKey: otherKey }] }
  ]) {
    assert.ok(!isValidRoot(root), JSON.stringify(root));
    await assert.rejects(verifyManifestEnvelope(envelopeWith(root), fixture.rootKeys), JSON.stringify(root));
  }
  // The zero-threshold case the review found: no manifest signature at all.
  const unsigned = { ...envelopeWith({ ...good, threshold: 0 }), signatures: [] };
  await assert.rejects(verifyManifestEnvelope(unsigned, fixture.rootKeys));
});

test("signing refuses a root the updaters would reject", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "operalibre-bad-root-test-"));
  try {
    const payload = path.join(directory, "root.json");
    await writeFile(payload, `${JSON.stringify({ type: "root", version: 2, threshold: 0, keys: [] })}\n`);
    const result = spawnSync(process.execPath, [SIGNER, "sign-envelope", "root", payload, path.join(directory, "out.json")], {
      encoding: "utf8",
      env: { ...process.env, OPERALIBRE_RELEASE_SIGNING_KEY: TEST_SEED }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /threshold from 1/);
    assert.deepEqual(await readdir(directory), ["root.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
