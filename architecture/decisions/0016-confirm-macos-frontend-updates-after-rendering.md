# 0016. Confirm macOS frontend updates after rendering

Status: Accepted.

## Context

The macOS host can replace its web frontend independently of its executable. A downloaded release can pass signature and file checks and still fail to render.

## Decision

- Compare the bundled web root with the fingerprint recorded when it was copied. The fingerprint includes the content-hashed entry page and version marker. A rebuilt bundle takes precedence over a downloaded update, while a restart with the same bundle can keep the working update.
- Copy new content into a private staging wrapper and validate it before replacement. Give the wrapper a current timestamp because the copy can inherit older timestamps from the bundle. Sweep old staging trees even when there is no reset to perform. The minimum age protects a concurrent copy. If a swap fails, serve the read-only bundle and track the version of the root actually being served.
- Follow a limited number of manifest redirects or compatibility bridges. Bound downloads as they stream, including the unsigned manifest before verification. Check HTTP status before decoding and use the verified manifest's URL, size, and hash. Re-read the saved trust state at verification time and persist a verified rotation before using it.
- Identify a release by version and package digest, allowing a corrected republish of the same version. Mark a new web root unconfirmed before it can become live and keep one previous root. The marker moves with its tree. Bind render confirmation and failure to the release key captured at navigation start so an earlier page cannot settle a successor.
- Roll back an unconfirmed root immediately if its scripts cannot load. On the first timeout for a blank page, allow another launch to try the release because the machine may have been busy. Reject it after a second timeout on a separate launch. Record rejections so a subsequent check can skip them. Recover an interrupted rollback before serving the root again. Mark a restored root before promoting it so a second failure can return to the bundle.

## Consequences

A downloaded release becomes proven only when its own page loads successfully. The previous root or read-only bundle remains available during recovery.

See [FrontendUpdater](../../apps/macos/Sources/OperaLibre/FrontendUpdater.swift) and [update manifest](../../docs/update-manifest.md).
