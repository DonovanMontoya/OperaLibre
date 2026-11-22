# 0006. Separate release triggers from publication

Status: Accepted.

## Context

A stable release, rebuild, and nightly can be ready at the same time. Some installations still update through per-file signatures. Read-along runtime bundles are large and change independently of application releases.

## Decision

- Publish one update package per platform with the server, web app, and launchers. Server-only installs turn off the frontend through configuration. Require the assets a running installation needs before publishing the release.
- Use the signed update manifest to identify packages. Retain separately signed packages for older clients while legacy compatibility is enabled. Put the read-along runtime in its own versioned release. Reuse an existing complete runtime release and verify runtime assets against the hashes listed in the signed manifest. The runtime release does not become GitHub's default latest release.
- Rebuild old tags from their source. Use current workflow tools, trust files, and tests when that tag predates the staging or manifest machinery. Validate the package against the source at the release tag.
- Run an hourly nightly trigger against the evening Eastern-time boundary. GitHub can delay or drop a single scheduled run. Keep the trigger outside the publication concurrency group and defer dispatch while another publication is active or queued. Retry a cancelled dispatch on a later check and leave a failed release for a maintainer. When stable publication calls for a nightly from the same source, keep both jobs in the publication run.
- Cancel obsolete PR checks. Give main, scheduled, and manual runs distinct concurrency keys. Keep the required check names available when only a subset of jobs is selected. Compile the disabled iOS gift bridge separately from feature enablement, signing, and publication. Use deterministic tests on ordinary PRs and generated audio for recognition jobs that load models. Scheduled upgrade tests use known releases, and publication tests the newly built candidate.

## Consequences

One publication run owns the release lock. A queued manual release can keep its place, and most release runs reuse the runtime bundle for their selected version.

See [release workflow](../../.github/workflows/release.yml), [nightly trigger](../../.github/workflows/nightly.yml), [release build](../../.github/workflows/build-release.yml), [CI](../../.github/workflows/ci.yml), and [update manifest](../../docs/update-manifest.md).
