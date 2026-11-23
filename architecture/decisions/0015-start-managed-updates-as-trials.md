# 0015. Start managed updates as trials

Status: Accepted.

## Context

A new server may take time to publish its first catalogue. It also may migrate data before it is ready. Managed updates need to recover if preparation, readiness, or installation fails.

## Decision

- Read port and data location with the server's configuration precedence. Resolve relative data paths from the configuration directory. Accept repeated keys using the last value and handle the server's quoting, key spelling, and environment fallback. Reuse a server already starting. Wait through catalogue readiness and report a tracked child's exit immediately. A legacy server's health response can stand in for explicit catalogue readiness.
- Hold the update lock through process retirement and PID publication. Retire the old PID record before stopping the process so the stop cannot remove a replacement server's record. Wait for exit before replacing files, and stop the process group or tree so helpers exit too. An exited zombie counts as gone. Replace a launcher inode so a waiting systemd starter can keep using its original executable.
- Stage binaries, launchers, and version markers as one update, independently of whether the installation includes the web bundle. Legacy calls that lack a layout flag assume the combined installation. Use the update completion signal instead of watching the version marker, which can change several times during a transaction.
- Start the new build as a trial. Return retryable unavailable responses from dynamic routes before authentication. Serve health and static frontend content. Defer work that writes outside the rollback snapshot. On a local, authenticated commit, restore the read-along queue before opening routes. Serialize commits and allow a repeat after success. Before opening routes, durably record the commit with the trial's token in the data directory. The launcher asks again when a commit gets no status line. Once the trial has stopped, a recorded commit means it may have accepted changes, so the launcher keeps the data and starts the new build again instead of rolling back. A legacy build that lacks trial support can finish starting, with the risk recorded in the launcher log.
- Prepare a verified SQLite snapshot and restore copies before the trial can migrate data. Save the compatible identity index as well. Use SQLite's consistent copy operation even after shutdown because a write-ahead log can still contain committed pages. Reserve restore copies to survive a failed build filling the disk. Allocate separate generations for updates that start in the same second.
- Record the pre-update version and journal each staged file. A staging failure restores just what moved. On rollback, stop the failed server, restore original installed files, and keep the current state when the previous format can still read it. When a format advanced or the failed data is unreadable, restore the database and identity snapshot together and discard the failed database's companion files. Restore through per-file replacements and retain the snapshot for a repeat attempt.
- Prepare the failed-data directory and recovery marker before starting the trial. Preserve failed data on a best-effort basis. Record the rollback decision before replacing the live state so a second attempt makes the same decision. Prepared copies make the first restore independent of free space. A later restore can copy again from the retained snapshot.

## Consequences

The server starts accepting new user changes after it commits. Rollback preserves post-update progress when both builds use compatible storage. A lost commit response never leads to a restore over changes made after the commit.

See [launcher](../../apps/launcher/src/main.rs), [update trial](../../apps/server/src/update_trial.rs), and [update manifest](../../docs/update-manifest.md).
