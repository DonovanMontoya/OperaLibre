import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

test("nightly manifests sign the stable return contract and refuse missing compatibility", async () => {
  const options = { version: "1.2.4-nightly.20260927.12", tag: "1.2.4-nightly.20260927.12",
    repository: "o/r", notes: "Nightly", packages: [], policy: {}, published: "2026-09-27T00:00:00Z",
    compatibility: { databaseSchema: 3, storageVersion: 1 }, stableVersion: "1.2.3" };
  assert.throws(() => manifestPayload({ ...options, compatibility: undefined }));
  assert.throws(() => manifestPayload({ ...options, stableVersion: undefined }));
  const payload = JSON.stringify(manifestPayload(options));
  const envelope = { payload, signatures: [signEnvelope(privateKeyFromSeed(TEST_SEED), "manifest", payload)] };
  const verified = await verifyManifestEnvelope(envelope, [TEST_PUBLIC_KEY]);
  assert.deepEqual(verified.dataCompatibility, options.compatibility);
  assert.equal(verified.stableVersion, "1.2.3");
  await assert.rejects(verifyManifestEnvelope({ ...envelope,
    payload: payload.replace('"storageVersion":1', '"storageVersion":2') }, [TEST_PUBLIC_KEY]));
});

const INSTALLER = await readFile(fileURLToPath(new URL("./install.sh", import.meta.url)), "utf8");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function installerFunction(name) {
  const definition = INSTALLER.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"));
  assert.ok(definition, `Missing installer function ${name}`);
  return definition[0];
}

test("the installer trusts the current update root", async () => {
  // install.sh keeps no state between runs, so it pins the newest root rather
  // than walking rotations from root version 1.
  const trust = await readTrust();
  const root = trust.rotations.length === 0
    ? { keys: trust.rootKeys, threshold: 1 }
    : (({ keys, threshold }) => ({ keys: keys.map((key) => key.publicKey), threshold }))(
      JSON.parse(trust.rotations.at(-1).payload));
  const declared = INSTALLER.match(/^MANIFEST_KEYS="([^"]*)"\nMANIFEST_THRESHOLD=(\d+)$/m);
  assert.ok(declared, "install.sh declares its manifest keys");
  const keys = declared[1].split(/\s+/).map((spki) => {
    const der = Buffer.from(spki, "base64");
    assert.deepEqual(der.subarray(0, SPKI_PREFIX.length), SPKI_PREFIX);
    return der.subarray(SPKI_PREFIX.length).toString("base64");
  });
  assert.deepEqual({ keys, threshold: Number(declared[2]) }, root);
});

// Ask the installer's own self-check, which verifies a known-good signature
// with the same openssl command it uses for the manifest.
const ed25519OpenSsl = await (async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "operalibre-installer-openssl-"));
  try {
    return spawnSync("sh", ["-c", [installerFunction("need"), installerFunction("ed25519_verify"),
      installerFunction("find_ed25519_openssl"), "find_ed25519_openssl >/dev/null"].join("\n")],
    { env: { ...process.env, WORK_DIR: work } }).status === 0;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
})();

test("the installer accepts only an archive its signed manifest lists", { skip: !ed25519OpenSsl && "openssl cannot verify Ed25519" }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "operalibre-installer-manifest-"));
  try {
    const release = path.join(fixture, "release");
    const work = path.join(fixture, "work");
    const bin = path.join(fixture, "bin");
    await mkdir(bin);
    const archive = "operalibre-1.2.3-combined-linux-x64.tar.gz";
    const contents = Buffer.from("the release package");
    const baseUrl = "https://github.com/DonovanMontoya/OperaLibre/releases/download/1.2.3";
    const entry = (name, data) => ({
      component: "server", platform: "linux-x64", version: "1.2.3", url: `${baseUrl}/${name}`,
      sha256: createHash("sha256").update(data).digest("hex"), size: data.length,
      format: "tar.gz", root: name.replace(/\.tar\.gz$/, "")
    });
    // The notes exercise every escape JSON.stringify writes, and raw UTF-8.
    const notes = "## What's new\n\n- \"Quoted\" C:\\path\ttab\u0001 caf\u00e9 \u2014 \ud83c\udfa7\n";
    // Written the way `release_signing.mjs sign-envelope manifest` writes it.
    const signed = (version, packages, seed = TEST_SEED) => {
      const payload = `${JSON.stringify(manifestPayload({
        version, tag: version, repository: "DonovanMontoya/OperaLibre", notes, packages,
        policy: { bridges: [] }, published: "2026-01-01T00:00:00.000Z"
      }), null, 2)}\n`;
      const envelope = addSignature({ payload, signatures: [] },
        signEnvelope(privateKeyFromSeed(seed), "manifest", payload));
      return `${JSON.stringify({ ...envelope, roots: [] }, null, 2)}\n`;
    };
    const testKey = Buffer.concat([SPKI_PREFIX, Buffer.from(TEST_PUBLIC_KEY, "base64")]).toString("base64");
    const script = [
      "set -eu",
      "say() { printf '%s\\n' \"$*\"; }",
      "fail() { printf 'Error: %s\\n' \"$*\" >&2; exit 1; }",
      `MANIFEST_KEYS="${testKey}"`,
      "MANIFEST_THRESHOLD=1",
      "if command -v sha256sum >/dev/null 2>&1; then SHA_TOOL=sha256sum; else SHA_TOOL=shasum; fi",
      // Serve the release from a folder; a missing asset fails like a 404.
      'fetch() { cp "$RELEASE/${1##*/}" "$2"; }',
      ...["need", "digest_of", "ed25519_verify", "find_ed25519_openssl", "manifest_message",
        "manifest_package", "missing_verifier", "verify_manifest"].map(installerFunction),
      'if verify_manifest; then echo VERIFIED; else echo "UNVERIFIED $?"; fi'
    ].join("\n");
    const run = async ({ manifest, download = contents, searchPath = process.env.PATH }) => {
      await rm(release, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await mkdir(release);
      await mkdir(work);
      if (manifest !== undefined) await writeFile(path.join(release, "operalibre-manifest-v1.json"), manifest);
      await writeFile(path.join(work, archive), download);
      return spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, PATH: searchPath, RELEASE: release, WORK_DIR: work,
          BASE_URL: baseUrl, VERSION: "1.2.3", ARCHIVE: archive }
      });
    };
    const good = signed("1.2.3", [entry("operalibre-1.2.3-combined-linux-arm64.tar.gz", Buffer.from("other")),
      entry(archive, contents)]);

    const accepted = await run({ manifest: good });
    assert.equal(accepted.stdout, "VERIFIED\n", accepted.stderr);

    for (const [label, options, message] of [
      ["replaced archive", { manifest: good, download: Buffer.from("the release packagE") },
        "does not match the signed release manifest"],
      ["missing manifest", {}, "Could not download the signed manifest"],
      ["unknown signing key", { manifest: signed("1.2.3", [entry(archive, contents)], OTHER_SEED) },
        "not signed by an OperaLibre release key"],
      ["edited payload", { manifest: good.replace("C:\\\\\\\\path", "C:\\\\\\\\pat") },
        "not signed by an OperaLibre release key"],
      ["an older release's manifest", { manifest: signed("1.2.2", [entry(archive, contents)]) },
        "for a different release"],
      ["archive not listed", { manifest: signed("1.2.3", [entry("operalibre-1.2.3-combined-macos-arm64.tar.gz", contents)]) },
        "is not listed in the signed manifest"]
    ]) {
      const result = await run(options);
      assert.notEqual(result.status, 0, label);
      assert.doesNotMatch(result.stdout, /VERIFIED/, label);
      assert.match(result.stderr, new RegExp(message), label);
    }

    // An openssl that cannot check Ed25519 stops the install. Homebrew's
    // OpenSSL on a developer's Mac would still verify.
    const homebrew = await Promise.any(["/opt/homebrew/opt/openssl@3/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl"]
      .map((file) => access(file))).then(() => true, () => false);
    if (!homebrew) {
      await writeFile(path.join(bin, "openssl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const unverified = await run({ manifest: good, searchPath: `${bin}${path.delimiter}${process.env.PATH}` });
      assert.notEqual(unverified.status, 0);
      assert.doesNotMatch(unverified.stdout, /VERIFIED/);
      assert.match(unverified.stderr, /signature could not be checked\. Nothing was installed/);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

// Runs the installer from its download through extraction, with the release
// served from a folder.
function runInstallerFlow({ release, work, manifestKey, noVerifier = false, platform = "linux" }) {
  const flow = INSTALLER.slice(INSTALLER.indexOf('say "Downloading ${ARCHIVE}..."'),
    INSTALLER.indexOf('STAGED="${WORK_DIR}/extract/${PACKAGE}"'));
  assert.ok(flow.includes("verify_manifest") && flow.includes("tar -xzf"));
  const script = [
    "set -eu",
    "say() { printf '%s\\n' \"$*\"; }",
    "fail() { printf 'Error: %s\\n' \"$*\" >&2; exit 1; }",
    `MANIFEST_KEYS="${manifestKey}"`,
    "MANIFEST_THRESHOLD=1",
    "if command -v sha256sum >/dev/null 2>&1; then SHA_TOOL=sha256sum; else SHA_TOOL=shasum; fi",
    'fetch() { cp "$RELEASE/${1##*/}" "$2"; }',
    ...["need", "digest_of", "ed25519_verify", "find_ed25519_openssl", "manifest_message",
      "manifest_package", "missing_verifier", "verify_manifest"].map(installerFunction),
    ...(noVerifier ? ["find_ed25519_openssl() { return 1; }"] : []),
    flow,
    "echo EXTRACTED"
  ].join("\n");
  return spawnSync("sh", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, RELEASE: release, WORK_DIR: work, os: platform,
      BASE_URL: "https://github.com/DonovanMontoya/OperaLibre/releases/download/1.2.3",
      VERSION: "1.2.3", ARCHIVE: "operalibre-1.2.3-combined-linux-x64.tar.gz" }
  });
}

async function installerFlowFixture(test) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "operalibre-installer-flow-"));
  try {
    const archive = "operalibre-1.2.3-combined-linux-x64.tar.gz";
    const release = path.join(fixture, "release");
    const source = path.join(fixture, "source", "operalibre-1.2.3-combined-linux-x64");
    await mkdir(source, { recursive: true });
    await mkdir(release);
    await writeFile(path.join(source, "VERSION.txt"), "1.2.3\n");
    const tar = spawnSync("tar", ["-czf", path.join(release, archive), "-C", path.dirname(source), path.basename(source)]);
    assert.equal(tar.status, 0, String(tar.stderr));
    const contents = await readFile(path.join(release, archive));
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await writeFile(path.join(release, "SHA256SUMS.txt"), `${sha256}  ${archive}\n`);
    const manifest = (seed) => {
      const payload = `${JSON.stringify(manifestPayload({
        version: "1.2.3", tag: "1.2.3", repository: "DonovanMontoya/OperaLibre", notes: "",
        packages: [{ component: "server", platform: "linux-x64", version: "1.2.3",
          url: `https://github.com/DonovanMontoya/OperaLibre/releases/download/1.2.3/${archive}`,
          sha256, size: contents.length, format: "tar.gz", root: archive.replace(/\.tar\.gz$/, "") }],
        policy: { bridges: [] }, published: "2026-01-01T00:00:00.000Z"
      }), null, 2)}\n`;
      const envelope = addSignature({ payload, signatures: [] },
        signEnvelope(privateKeyFromSeed(seed), "manifest", payload));
      return `${JSON.stringify({ ...envelope, roots: [] }, null, 2)}\n`;
    };
    const run = async ({ seed = TEST_SEED, ...options } = {}) => {
      const work = path.join(fixture, "work");
      await rm(work, { recursive: true, force: true });
      await mkdir(work);
      await writeFile(path.join(release, "operalibre-manifest-v1.json"), manifest(seed));
      const manifestKey = Buffer.concat([SPKI_PREFIX, Buffer.from(TEST_PUBLIC_KEY, "base64")]).toString("base64");
      const result = runInstallerFlow({ release, work, manifestKey, ...options });
      const extracted = await access(path.join(work, "extract")).then(() => true, () => false);
      return { ...result, extracted };
    };
    await test(run);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test("the installer extracts nothing without an Ed25519 verifier", () => installerFlowFixture(async (run) => {
  // Needs no openssl, so it also covers hosts where the tests above are skipped.
  for (const [platform, advice] of [["macos", /brew install openssl@3/], ["linux", /package manager/]]) {
    const result = await run({ noVerifier: true, platform });
    assert.notEqual(result.status, 0, platform);
    assert.doesNotMatch(result.stdout, /verified|EXTRACTED/, platform);
    assert.match(result.stderr, advice, platform);
    assert.match(result.stderr, /signature could not be checked\. Nothing was installed/, platform);
    assert.equal(result.extracted, false, platform);
  }
}));

test("the installer extracts only a release with a valid signature", { skip: !ed25519OpenSsl && "openssl cannot verify Ed25519" },
  () => installerFlowFixture(async (run) => {
    const rejected = await run({ seed: OTHER_SEED });
    assert.notEqual(rejected.status, 0);
    assert.doesNotMatch(rejected.stdout, /EXTRACTED/);
    assert.match(rejected.stderr, /not signed by an OperaLibre release key/);
    assert.equal(rejected.extracted, false);

    const accepted = await run();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Release signature and digest verified\.\nEXTRACTED\n$/);
    assert.equal(accepted.extracted, true);
  }));
