---
title: Update Manifest
nav_order: 13
---

# Update Manifest

Every OperaLibre updater (the server's **Update server**, **Update frontend** and sync add-on install, and the macOS app's frontend updater) reads one signed file to learn about releases:

```text
https://github.com/DonovanMontoya/OperaLibre/releases/latest/download/operalibre-manifest-v1.json
```

GitHub redirects that address to the newest release's copy, and it does not count against the GitHub API rate limit. Nothing else about a release is built into the updaters: the manifest says which packages exist, where they are, how large they are, and their SHA-256. So file names, how many files a release has, and where they are hosted can all change without an updater change.

The signer is `script/release_signing.mjs` and the manifest builder is `script/release_manifest.mjs`. The verifiers are `apps/server/src/update_manifest.rs` and `apps/macos/Sources/OperaLibre/ReleaseSignature.swift`. All of them are tested against `script/fixtures/update-manifest.json`, so a format change that reaches only one side fails CI.

## The signed file

```json
{
  "payload": "<the manifest, as JSON text>",
  "signatures": [{ "keyid": "<16 hex characters>", "sig": "<base64 Ed25519 signature>" }],
  "roots": ["<signed key rotations, oldest first>"]
}
```

A signature covers the bytes `operalibre-signed-v1\n<type>\n<payload>`, where the type is `manifest` or `root`, so a key rotation can never pass for a manifest. Signing the payload's exact text means no JSON canonicalization is needed. A key id is the first 8 bytes of the SHA-256 of the raw 32-byte public key, as hex.

## The manifest (schema 1)

```json
{
  "type": "manifest",
  "schema": 1,
  "version": "0.5.0",
  "published": "2026-10-01T00:00:00.000Z",
  "releaseUrl": "https://github.com/DonovanMontoya/OperaLibre/releases/tag/0.5.0",
  "notes": "Release notes in Markdown",
  "notice": { "message": "Shown when no package fits", "url": "https://…" },
  "redirect": "https://… another manifest to read instead",
  "bridges": [{ "component": "server", "below": "0.5.0", "manifest": "https://…/0.4.9/operalibre-manifest-v1.json" }],
  "packages": [
    {
      "component": "server",
      "platform": "linux-x64",
      "version": "0.5.0",
      "url": "https://github.com/…/operalibre-0.5.0-combined-linux-x64.tar.gz",
      "sha256": "…",
      "size": 11504569,
      "format": "tar.gz",
      "root": "operalibre-0.5.0-combined-linux-x64"
    }
  ]
}
```

| Component | Platforms | What it is |
| --- | --- | --- |
| `server` | `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, `windows-x64` | The combined package. It carries `operalibre-updater` and `UPDATE.json`, so it is also the update. A server-only installation applies everything except `web/`. |
| `frontend` | `any` | The standalone web app. |
| `readalong-sync` | the five above | The optional sync add-on, from its own `readalong-sync-v<version>` release. `protocol` is its ADDON.json `protocolVersion`. |

`root` is the single folder the archive extracts to. `format` is `zip` or `tar.gz`.

## Rules that keep old installs working

These are what let the update system change later without a new client:

1. **Additions never break a client.** Unknown fields, components, platforms and formats are ignored. A package entry a client cannot use is skipped, and the next matching entry is tried. So a new format can be listed before an old one, and a new sync add-on `protocol` beside the old one.
2. **Breaking changes get a new file.** A manifest a schema 1 client could misread is published as `operalibre-manifest-v2.json` beside the v1 file, never instead of it. Keep publishing v1 for as long as v1 clients matter.
3. **Bridges route old installs through a stepping stone.** When an install is older than a bridge's `below` version, the client reads the bridge's manifest instead: the last release that can still update it. It updates there, and its next check reads the latest manifest. Old manifests stay valid forever, because they are signed files at fixed release URLs. Add bridges in `release/update-policy.json`.
4. **`redirect` moves the manifest.** A client reads the redirected manifest instead. Following redirects and bridges stops after eight hops.
5. **`notice` is the last resort.** When a manifest has no package an install can use, its notice is shown in Administration, for example to ask for one manual update.
6. **Downgrades cannot happen.** Clients install only a newer version than they run.

## Keys and rotation

Clients start from root version 1: the keys in `release/update-trust.json` → `rootKeys`, which the server and macOS app build in as `ROOT_KEYS` and `releaseRootKeys`. A manifest is accepted when a current root key signed it. The release workflow signs with the `OPERALIBRE_RELEASE_SIGNING_KEY` secret.

Keep a **backup root key** offline. It signs nothing day to day, but if the release key is lost or leaked it is what signs the rotation to a new key. Without it, a lost key means every installation has to be updated by hand once.

To add the backup key before the first manifest release:

1. Run `node script/release_signing.mjs generate ~/operalibre-backup-release-signing-key.txt` on a trusted computer. It prints the public key.
2. Store the private key file offline (a password manager or an encrypted drive), then delete the copy.
3. Add the public key to `rootKeys` in `release/update-trust.json`, `ROOT_KEYS` in `apps/server/src/update_manifest.rs`, and `releaseRootKeys` in `apps/macos/Sources/OperaLibre/ReleaseSignature.swift`. A test fails if the three disagree.

To rotate keys later:

1. Write the new root payload: `{"type":"root","version":2,"threshold":1,"keys":[{"keyid":"…","publicKey":"…"}]}`, listing every key the new root trusts. The version is one more than the current root's.
2. Sign it with a current key and with every new key, into one envelope:
   `OPERALIBRE_RELEASE_SIGNING_KEY=<key> node script/release_signing.mjs sign-envelope root root.json root.envelope.json`, once per key.
3. Append the envelope to `rotations` in `release/update-trust.json`. Every later manifest carries the list, so clients of any age walk from their built-in root to the current one.
4. Update the `OPERALIBRE_RELEASE_SIGNING_KEY` secret to a key in the new root.

## Legacy assets and the bridge release

Servers from before the manifest (0.1.2 to 0.4.x) look up `operalibre-<version>-update-<platform>.zip` in the latest release, and 0.4.5 also needs its `.sig`. While `legacyAssets` is `true` in `release/update-policy.json`, releases also publish those files and the frontend's `.sig`. The first such release is the bridge: every older server updates to it the old way, and from then on reads the manifest.

After the bridge release has been out long enough for the installations you care about to update, set `legacyAssets` to `false`. Older servers then show an update as unavailable, and updating them takes one manual install.

## Checking a manifest by hand

```bash
node script/release_signing.mjs verify-manifest operalibre-manifest-v1.json [folder-with-packages]
```

This applies the same checks as the updaters and, given a folder, confirms that every package in it matches its manifest entry. The release workflow runs it before publishing, and it refuses to publish a release missing the manifest, a platform package, the frontend package, or, while legacy assets are on, the files older servers need.
