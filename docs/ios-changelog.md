---
layout: default
title: iOS Release Changelog
nav_order: 12
---

# iOS release changelog

Release history for the OperaLibre iPhone and iPad app, starting with **1.1.0 (0)**.
Entries use **version (build)** and appear newest first. iOS versions are tracked
independently of the server releases.

## Unreleased

No changes recorded yet.

## 1.1.0 (0)

Tracking started: September 8, 2026.

- Starting baseline for the iOS changelog. Earlier releases have not been
  reconstructed, and existing features are not listed as new in this version.

## Maintaining this changelog

1. Add a short, user-facing note under **Unreleased** when a change affects the
   shipped iOS app, including changes to its bundled web interface. Link the
   relevant pull request or commit so the note can be checked later.
2. When distributing a build through TestFlight or the App Store, move only the
   notes included in that build into a new **version (build)** entry. Record its
   distribution date, channel, and source commit. Keep a separate entry for each
   distributed build, even when the version stays the same.
3. Use those notes for TestFlight's “What to Test” or the App Store's “What's New”.
   Keep **Unreleased** at the top for the next build, and preserve previous entries.

The initial version and build above were supplied when tracking began; its
distribution date, channel, and archived source commit have not been recorded.
For future entries, verify the version and build against the distributed archive.
