// Ed25519 signing for OperaLibre updates. The contract lives in
// docs/update-manifest.md; the verifiers are apps/server/src/update_manifest.rs
// and apps/macos/Sources/OperaLibre/ReleaseSignature.swift. Keep all three in step.
//
//   node script/release_signing.mjs generate <private-key-file>
//     Writes a new private key (base64 of the 32-byte seed) to the file, mode
//     0600, and prints the matching public key (base64 of 32 bytes).
//
//   node script/release_signing.mjs sign-envelope <manifest|root> <payload-file> <envelope-file>
//     Signs the payload file's exact bytes with the key in
//     OPERALIBRE_RELEASE_SIGNING_KEY. The signature is added to the envelope
//     file, which is created when missing, so a root rotation can collect the
//     signatures of both the old and the new keys. A manifest envelope also
//     carries the rotations listed in release/update-trust.json.
//
//   node script/release_signing.mjs verify-manifest <envelope-file> [<asset-dir>]
//     Checks a signed manifest the way the updaters do, and that every package
//     it lists from the asset directory matches that file's size and SHA-256.
//
//   node script/release_signing.mjs sign <asset-dir> <release-tag>
//     Legacy per-file signatures (<file>.sig) for servers older than the
//     update manifest. Only used while release/update-policy.json keeps
//     legacyAssets on; see docs/update-manifest.md.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SIGNATURE_SUFFIX = ".sig";
const LEGACY_MESSAGE_DOMAIN = "operalibre-release-asset-v1";
const ENVELOPE_DOMAIN = "operalibre-signed-v1";
const TRUST_FILE = fileURLToPath(new URL("../release/update-trust.json", import.meta.url));
// The key the release workflow signs with. It must be one of the root keys.
export const RELEASE_SIGNING_PUBLIC_KEY = "FhUko6re8/stEbHmAlnNv3+SwIzMSXNMUpPVl8BVifk=";
// DER prefixes that wrap a raw 32-byte Ed25519 seed or public key.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// The packages servers older than the update manifest fetch, each with its
// .sig. They look these names up in the latest release.
const LEGACY_UPDATER_ASSET_PATTERNS = [
  /^operalibre-[^/]+-frontend\.zip$/,
  /^operalibre-[^/]+-update-[a-z0-9]+-[a-z0-9]+\.zip$/
];

export function isLegacyUpdaterAsset(name) {
  return LEGACY_UPDATER_ASSET_PATTERNS.some((pattern) => pattern.test(name));
}

export function signingMessage(tag, assetName, sha256Hex) {
  return Buffer.from(`${LEGACY_MESSAGE_DOMAIN}\n${tag}\n${assetName}\n${sha256Hex.toLowerCase()}`, "utf8");
}

/// What an envelope signature covers: the domain, the payload type and the
/// payload's exact bytes, so a root can never pass for a manifest.
export function envelopeMessage(type, payload) {
  return Buffer.concat([Buffer.from(`${ENVELOPE_DOMAIN}\n${type}\n`, "utf8"), Buffer.from(payload, "utf8")]);
}

/// First 8 bytes of the SHA-256 of the raw public key, as hex.
export function keyId(publicKeyBase64) {
  return createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex").slice(0, 16);
}

export function privateKeyFromSeed(seedBase64) {
  const seed = Buffer.from(seedBase64.trim(), "base64");
  if (seed.length !== 32) {
    throw new Error("The release signing key must be the base64 of a 32-byte Ed25519 seed.");
  }
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

export function publicKeyBase64(privateKey) {
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return spki.subarray(SPKI_ED25519_PREFIX.length).toString("base64");
}

export async function readTrust() {
  return JSON.parse(await readFile(TRUST_FILE, "utf8"));
}

export async function requireRootKey(privateKey) {
  const key = publicKeyBase64(privateKey);
  const trust = await readTrust();
  const current = trust.rotations.length === 0
    ? trust.rootKeys
    : JSON.parse(trust.rotations.at(-1).payload).keys.map((entry) => entry.publicKey);
  if (!current.includes(key)) {
    throw new Error("OPERALIBRE_RELEASE_SIGNING_KEY is not one of the current update root keys.");
  }
}

function publicKeyObject(base64) {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(base64, "base64")]),
    format: "der",
    type: "spki"
  });
}

/// A root the server and macOS verifiers would accept: a threshold from one
/// to the number of keys, and each key a 32-byte key under its own key id.
export function isValidRoot(root) {
  return root?.type === "root"
    && Number.isInteger(root.version)
    && Array.isArray(root.keys)
    && Number.isInteger(root.threshold)
    && root.threshold >= 1
    && root.threshold <= root.keys.length
    && root.keys.every((key) => typeof key?.publicKey === "string"
      && Buffer.from(key.publicKey, "base64").length === 32
      && key.keyid === keyId(key.publicKey));
}

function envelopeVerifies(envelope, type, root) {
  const verified = new Set();
  for (const { keyid, sig } of envelope.signatures ?? []) {
    const key = root.keys.find((entry) => entry.keyid === keyid);
    if (!key || verified.has(keyid)) continue;
    if (verify(null, envelopeMessage(type, envelope.payload), publicKeyObject(key.publicKey), Buffer.from(sig, "base64"))) {
      verified.add(keyid);
    }
  }
  return verified.size >= root.threshold;
}

/// The manifest a v1 updater would accept, verified from the built-in root
/// keys through the rotations the envelope carries.
export async function verifyManifestEnvelope(envelope, rootKeys) {
  let root = {
    version: 1,
    threshold: 1,
    keys: (rootKeys ?? (await readTrust()).rootKeys).map((publicKey) => ({ keyid: keyId(publicKey), publicKey }))
  };
  for (const rotation of envelope.roots ?? []) {
    const next = JSON.parse(rotation.payload);
    if (!isValidRoot(next) || next.version !== root.version + 1) continue;
    if (envelopeVerifies(rotation, "root", root) && envelopeVerifies(rotation, "root", next)) root = next;
  }
  if (!envelopeVerifies(envelope, "manifest", root)) {
    throw new Error("The manifest is not signed by a current update root key.");
  }
  const manifest = JSON.parse(envelope.payload);
  if (manifest.type !== "manifest" || manifest.schema !== 1) {
    throw new Error("The signed file is not a schema 1 manifest.");
  }
  return manifest;
}

export function signEnvelope(privateKey, type, payload) {
  const publicKey = publicKeyBase64(privateKey);
  return {
    keyid: keyId(publicKey),
    sig: sign(null, envelopeMessage(type, payload), privateKey).toString("base64")
  };
}

/// Adds a signature to an envelope, replacing an earlier one by the same key.
export function addSignature(envelope, signature) {
  return {
    ...envelope,
    signatures: [...envelope.signatures.filter((entry) => entry.keyid !== signature.keyid), signature]
  };
}

export async function fileSha256Hex(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function signAsset(privateKey, tag, assetName, sha256Hex) {
  return sign(null, signingMessage(tag, assetName, sha256Hex), privateKey).toString("base64");
}

export async function signDirectory(directory, tag, privateKey) {
  const signed = [];
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name);
    if (!isLegacyUpdaterAsset(name) || !(await stat(file)).isFile()) continue;
    const signature = signAsset(privateKey, tag, name, await fileSha256Hex(file));
    await writeFile(`${file}${SIGNATURE_SUFFIX}`, `${signature}\n`);
    signed.push(name);
  }
  return signed;
}

function environmentKey() {
  const seed = process.env.OPERALIBRE_RELEASE_SIGNING_KEY;
  if (!seed?.trim()) {
    throw new Error("OPERALIBRE_RELEASE_SIGNING_KEY is not set; refusing to publish unsigned updates.");
  }
  return privateKeyFromSeed(seed);
}

async function readEnvelope(file, payload) {
  try {
    const envelope = JSON.parse(await readFile(file, "utf8"));
    if (envelope.payload !== payload) {
      throw new Error(`${file} holds a different payload; remove it or sign the same payload.`);
    }
    return envelope;
  } catch (error) {
    if (error.code === "ENOENT") return { payload, signatures: [] };
    throw error;
  }
}

async function main([command, ...args]) {
  if (command === "generate" && args.length === 1) {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
    const seed = pkcs8.subarray(PKCS8_ED25519_PREFIX.length).toString("base64");
    await writeFile(args[0], `${seed}\n`, { mode: 0o600, flag: "wx" });
    console.log(publicKeyBase64(privateKey));
    return;
  }
  if (command === "sign-envelope" && args.length === 3) {
    const [type, payloadFile, envelopeFile] = args;
    if (!["manifest", "root"].includes(type)) throw new Error(`Unknown envelope type: ${type}`);
    const payload = await readFile(payloadFile, "utf8");
    if (JSON.parse(payload).type !== type) throw new Error(`The payload is not a ${type}.`);
    if (type === "root" && !isValidRoot(JSON.parse(payload))) {
      throw new Error("A root needs a threshold from 1 to its key count, and each key under its own key id.");
    }
    const privateKey = environmentKey();
    // A new root is signed by the keys it introduces as well as the current
    // ones, so only a manifest is held to the current root here.
    if (type === "manifest") await requireRootKey(privateKey);
    let envelope = addSignature(await readEnvelope(envelopeFile, payload), signEnvelope(privateKey, type, payload));
    if (type === "manifest") envelope = { ...envelope, roots: (await readTrust()).rotations };
    await writeFile(envelopeFile, `${JSON.stringify(envelope, null, 2)}\n`);
    console.log(`Signed the ${type} with key ${keyId(publicKeyBase64(privateKey))}.`);
    return;
  }
  if (command === "verify-manifest" && (args.length === 1 || args.length === 2)) {
    const manifest = await verifyManifestEnvelope(JSON.parse(await readFile(args[0], "utf8")));
    for (const entry of manifest.packages) {
      const name = decodeURIComponent(new URL(entry.url).pathname.split("/").at(-1));
      if (!args[1] || !(await stat(path.join(args[1], name)).catch(() => null))) continue;
      const file = path.join(args[1], name);
      if ((await stat(file)).size !== entry.size || (await fileSha256Hex(file)) !== entry.sha256) {
        throw new Error(`${name} does not match its manifest entry.`);
      }
    }
    console.log(`Verified the ${manifest.version} manifest and its ${manifest.packages.length} packages.`);
    return;
  }
  if (command === "sign" && args.length === 2) {
    const privateKey = environmentKey();
    await requireRootKey(privateKey);
    const [directory, tag] = args;
    const signed = await signDirectory(directory, tag, privateKey);
    if (signed.length === 0) throw new Error(`No legacy updater packages to sign in ${directory}.`);
    console.log(`Signed ${signed.length} legacy updater packages for ${tag}.`);
    return;
  }
  throw new Error(
    "Usage: release_signing.mjs generate <private-key-file> | sign-envelope <manifest|root> <payload-file> <envelope-file> | sign <asset-dir> <release-tag>"
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
