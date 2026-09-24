// Ed25519 signatures for release assets.
//
//   node script/release_signing.mjs generate <private-key-file>
//     Writes a new private key (base64 of the 32-byte seed) to the file, mode
//     0600, and prints the matching public key (base64 of 32 bytes). The
//     private key becomes the OPERALIBRE_RELEASE_SIGNING_KEY secret; the
//     public key is built into the server and the macOS app.
//
//   node script/release_signing.mjs sign <asset-dir> <release-tag>
//     Signs every package an in-app updater downloads (see isUpdaterAsset)
//     with the key in OPERALIBRE_RELEASE_SIGNING_KEY, writing <file>.sig
//     beside each. Packages people download by hand are covered by
//     SHA256SUMS.txt and the build-provenance attestation instead.
//
// A signature covers the release tag, the asset name and the asset's SHA-256
// (see signingMessage), so it cannot be moved to another file or replayed
// from an older release. Verifiers rebuild the same message; keep them in
// step: apps/server/src/updates.rs and
// apps/macos/Sources/OperaLibre/FrontendUpdater.swift.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SIGNATURE_SUFFIX = ".sig";
const MESSAGE_DOMAIN = "operalibre-release-asset-v1";
// Must match the public key built into the server and macOS updater.
export const RELEASE_SIGNING_PUBLIC_KEY = "FhUko6re8/stEbHmAlnNv3+SwIzMSXNMUpPVl8BVifk=";
// DER prefixes that wrap a raw 32-byte Ed25519 seed or public key.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// The packages the server and macOS updaters fetch, each with its .sig. Keep
// in step with the asset names in apps/server/src/updates.rs and
// apps/macos/Sources/OperaLibre/FrontendUpdater.swift: an updater refuses a
// package whose signature is missing.
const UPDATER_ASSET_PATTERNS = [
  /^operalibre-[^/]+-frontend\.zip$/,
  /^operalibre-[^/]+-update-[a-z0-9]+-[a-z0-9]+\.zip$/,
  /^operalibre-readalong-sync-[^/]+-[a-z0-9]+-[a-z0-9]+\.zip$/
];

export function isUpdaterAsset(name) {
  return UPDATER_ASSET_PATTERNS.some((pattern) => pattern.test(name));
}

export function signingMessage(tag, assetName, sha256Hex) {
  return Buffer.from(`${MESSAGE_DOMAIN}\n${tag}\n${assetName}\n${sha256Hex.toLowerCase()}`, "utf8");
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

export function requireReleaseSigningKey(privateKey) {
  if (publicKeyBase64(privateKey) !== RELEASE_SIGNING_PUBLIC_KEY) {
    throw new Error("OPERALIBRE_RELEASE_SIGNING_KEY does not match the public key built into the updaters.");
  }
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
    if (!isUpdaterAsset(name) || !(await stat(file)).isFile()) continue;
    const signature = signAsset(privateKey, tag, name, await fileSha256Hex(file));
    await writeFile(`${file}${SIGNATURE_SUFFIX}`, `${signature}\n`);
    signed.push(name);
  }
  return signed;
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
  if (command === "sign" && args.length === 2) {
    const seed = process.env.OPERALIBRE_RELEASE_SIGNING_KEY;
    if (!seed?.trim()) {
      throw new Error("OPERALIBRE_RELEASE_SIGNING_KEY is not set; refusing to publish unsigned assets.");
    }
    const privateKey = privateKeyFromSeed(seed);
    requireReleaseSigningKey(privateKey);
    const [directory, tag] = args;
    const signed = await signDirectory(directory, tag, privateKey);
    if (signed.length === 0) throw new Error(`No updater packages to sign in ${directory}.`);
    console.log(`Signed ${signed.length} updater packages for ${tag} with key ${publicKeyBase64(privateKey)}.`);
    return;
  }
  throw new Error("Usage: release_signing.mjs generate <private-key-file> | sign <asset-dir> <release-tag>");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
