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
3. **Bridges route old installs through a stepping stone.** When an install is older than a bridge's `below` version, the client reads the bridge's manifest instead: the last release that can still update it. It updates there, and its next check reads the latest manifest. Old manifests stay valid for as long as a key that signed them is still trusted, because they are signed files at fixed release URLs. Add bridges in `release/update-policy.json`.
4. **`redirect` moves the manifest.** A client reads the redirected manifest instead. Following redirects and bridges stops after eight hops.
5. **`notice` is the last resort.** When a manifest has no package an install can use, its notice is shown in Administration, for example to ask for one manual update.
6. **Normal updates move forward.** Server updates within a channel install only newer versions. An owner can explicitly select the other channel and install its older version only when signed data compatibility matches. Standalone frontend and native updaters continue to use the stable feed and only install newer versions.

## Keys and rotation

Clients start from root version 1: the keys in `release/update-trust.json` → `rootKeys`, which the server and macOS app build in as `ROOT_KEYS` and `releaseRootKeys`. A manifest is accepted when a current root key signed it.

A client remembers every rotation it accepts: the server in `update-roots.json` in its data folder, the macOS app beside its installed web files. Its later checks start from the newest root it has seen, so a manifest that leaves a rotation out is refused even when a key that rotation retired signed it. The saved rotations are verified again each time they are read, and deleting the file only makes the client learn them again from the next manifest. An installation that has never seen a rotation still starts from root version 1, so updating promptly after a rotation is what protects it.

The release workflow signs with the `OPERALIBRE_RELEASE_SIGNING_KEY` secret.

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
5. If the rotation retires a key, sign every manifest a client can still be sent to again with a current key, with the rotation in its `roots`, and replace the published file: the current stable manifest, the nightly feed, and each manifest a bridge points to. A client that has accepted the rotation from one of them refuses any other signed only by the retired key, so a nightly server would lose its sync add-on check until the next stable release.

## Legacy assets and the bridge release

Servers from before the manifest (0.1.2 to 0.4.x) look up `operalibre-<version>-update-<platform>.zip` in the latest release, and 0.4.5 also needs its `.sig`. While `legacyAssets` is `true` in `release/update-policy.json`, releases also publish those files and the frontend's `.sig`. The first such release is the bridge: every older server updates to it the old way, and from then on reads the manifest.

After the bridge release has been out long enough for the installations you care about to update, set `legacyAssets` to `false`. Older servers then show an update as unavailable, and updating them takes one manual install.

## Checking a manifest by hand

```bash
node script/release_signing.mjs verify-manifest operalibre-manifest-v1.json [folder-with-packages]
```

This applies the same checks as the updaters and, given a folder, confirms that every package in it matches its manifest entry. The release workflow runs it before publishing, and it refuses to publish a release missing the manifest, a platform package, the frontend package, or, while legacy assets are on, the files older servers need.

## Testing packaged upgrades

Before uploading each platform's packages, the release workflow runs `script/test_release_upgrade.py`. It starts a real 0.4.6 server in a temporary installation and applies the newly built combined archive using its packaged updater. The baseline stays pinned to the first manifest release so this also tests skipping releases. The baseline archive is checked against its signed manifest before any executable is run.

Rebuilds of historical tags through 0.4.6 skip this gate because they predate the launcher fixes it exercises. Releases from 0.4.7 onward run it.

Each platform tests combined and server-only installations, with both a successful upgrade and rollback after a deliberately invalid new server cannot start. Checks cover server and web versions, the installed binary, health after restart, the authenticated account session, exact configuration preservation, and sample data/library files. Duplicate port settings and the blank-port `PORT` fallback are exercised as well. A failure blocks publication.

Changes to the harness and release workflow also run the `Release upgrade tests` PR checks on all five platforms, using the published 0.4.6 and 0.4.7 packages. These checks validate the test harness without publishing a release; the release gate is what validates newly built application code.

To run against downloaded packages locally (Python 3.12 or later):

```bash
python3 script/test_release_upgrade.py \
  --baseline /path/to/operalibre-0.4.6-combined-macos-arm64.tar.gz \
  --candidate /path/to/operalibre-0.4.7-combined-macos-arm64.tar.gz
```

Use the packages for the machine running the test; Windows packages are ZIPs. The script only runs disposable installations and stops their servers afterward. On Windows, cleanup checks the executable path and terminates that process directly; it does not validate the packaged Stop launcher. Verify downloaded packages before running it yourself.

This gate tests package installation and recovery directly, before a candidate is signed or public. It does not exercise update discovery, signature rejection, populated-library migrations, or the entire Administration UI. Manifest/signature unit tests and the existing Linux managed-service handoff tests remain separate checks. Periodic tests through the real published update API are still useful; a healthy startup alone cannot establish that every feature or data migration works.

## Nightly web/server releases

Stable keeps the existing `releases/latest/download/operalibre-manifest-v1.json` address. Nightly uses `releases/download/nightly/operalibre-manifest-v1.json`. The latter is a feed-only prerelease: its signed manifest points to packages in an immutable release such as `0.5.1-nightly.20260927.123`. Packages stay in draft until all uploads finish. Retrying publication preserves an already published nightly's assets and copies its original signed manifest to the feed. Neither the feed nor nightly builds are marked as GitHub's latest release. Native app and sync add-on publication remains on the stable release path.

The manifest may add `dataCompatibility`, an object with `databaseSchema` and `storageVersion`, and `stableVersion`, the stable version a nightly was tested against. Existing manifest readers ignore these fields. A server requires matching compatibility before entering nightly or installing an older version on the other channel. A missing compatibility declaration refuses a switch; it never implies compatibility. Package `UPDATE.json` also carries the compatibility declaration.

`release/data-compatibility.json` defines this build's contract. Its database schema must match the server's schema; a unit test enforces that. Increase `storageVersion` when stored JSON, configuration, or other persisted semantics stop being safely readable **and writable** by the old build. New fields must survive older readers rewriting records. API changes must remain compatible with stable clients. A schema match alone does not prove those behaviors.

Before each nightly is published, every server platform must pass the existing upgrade and failed-start rollback tests plus `script/test_release_upgrade.py --round-trip` against the current stable package. The round trip writes progress, volume settings, metadata, and an account on nightly, returns to stable, and verifies those writes along with the original session, configuration, library files, and bundled web version. All fixtures are disposable. This is a release gate, not permission to make incompatible format changes: new persistent features need corresponding coverage. An incompatible change requires a compatibility release on stable first, or must wait outside the public nightly channel.

The initial rollout requires a stable release containing channel selection and compatibility metadata. Nightly publication refuses older baselines. An hourly check starts each nightly build, usually within an hour after 8:17 p.m. Eastern time (following daylight saving time), and the build skips unchanged source when the feed is current; a missing or stale feed triggers another build. Manual dispatch with `channel=nightly` can build on demand. For a stable promotion, dispatch with `channel=stable` and `source_nightly` set to the immutable tested nightly tag; leave `tag` blank to use that nightly's intended stable version. The packages are rebuilt from that exact source commit with stable versioning and pass the normal release checks. Leaving `source_nightly` blank preserves the usual stable release workflow.
