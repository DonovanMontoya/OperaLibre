# 0022. Preserve local state when installing a release

Status: Accepted.

## Context

The same installer sets up fresh servers and upgrades existing ones. It can run from a shell pipeline or unattended session, and operators can choose a combined or server-only installation.

## Decision

- Verify the release manifest with the pinned Ed25519 trust root when a compatible verifier is available. The installer keeps no trust state across runs and pins the current root from the release trust file. Select a verifier using a known test vector. The manifest binds archive size and hash. Decode only the envelope syntax produced by the release signer and reject unsupported encodings.
- Resolve GitHub download paths with the reported tag. Use a stripped version for display and package naming. Keep the installed layout unless the user explicitly changes it. Detect a server-only installation from its installed configuration and package files because a custom web directory is also possible. Use health checks that work without an installed frontend.
- Keep relative data paths tied to the configuration directory. Read and write keys with the server's spelling, quoting, and precedence. Preserve existing configuration during an upgrade. Make sure the installed server is stopped before replacing files and verify that a saved PID still refers to that specific installation.
- Stage new files on the destination filesystem before parking existing entries. Restore what moved if the swap fails and keep the recovery files available. Defer signals through the rename sequence and let the exit trap handle cleanup. Remove a backup directory only when it is empty. A server-only package uses installer-created start and stop helpers, so it still has both actions.
- Use the controlling terminal for prompts because standard input can hold the script itself. Probe the terminal by opening it, since permission checks alone can pass without a controlling terminal. Warn about running as root. Use the API readiness result even if opening a browser failed on a headless machine.
- Keep an existing Libation setup until the owner changes it. Explicitly disabling the import overrides an old path. Seed the minimal settings files so its CLI can run before its desktop setup. Unpack the Linux payload locally and resolve ICU separately. An unattended run may install ICU only when the user explicitly chose Libation.

## Consequences

The installer can replace release files while keeping library settings and user data. It can recover from a partial swap without assuming that a failed browser launch means the server failed.

Requiring an authenticated release on hosts without a verifier is tracked in [#543](https://github.com/DonovanMontoya/OperaLibre/issues/543).

See [installer](../../script/install.sh), [release workflow](0006-separate-release-triggers-from-publication.md), and [update manifest](../../docs/update-manifest.md).
