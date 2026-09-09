---
layout: default
title: Client compatibility
---

# Audiobookshelf and OPDS compatibility

OperaLibre provides an Audiobookshelf API subset at `/abs` and an OPDS 1.2 catalog at `/api/opds`. They are separate protocols. Compatibility with BookPlayer does not establish compatibility with every Audiobookshelf client.

## BookPlayer

Choose **Audiobookshelf** in BookPlayer, use `https://your-server/abs`, and sign in with your OperaLibre username and password. A reverse proxy must forward `/abs/` to the server. BookPlayer's inspected source has Audiobookshelf and Jellyfin integrations but no OPDS implementation.

Source inspected: [BookPlayer revision 154895b](https://github.com/TortugaPower/BookPlayer/tree/154895b90b5b3612b77972923bd1d22fde49fffa), on September 8, 2026. This is a development-branch snapshot, not a guarantee about every App Store version.

### Findings repaired

- **Library decoding failed after successful login.** `AudiobookShelfLibrary` requires `folders`, `displayOrder`, and `icon`; OperaLibre omitted them. The response now includes an empty folder list, display order, and library icon without exposing server filesystem paths.
- **Series metadata and ordering information disappeared.** Current BookPlayer reads `media.metadata.series`, while OperaLibre supplied only a top-level series field. Both are now provided, and series IDs agree with filter data, so selecting a series can use the same identifier.
- **Tags and saved progress disappeared.** BookPlayer reads `media.tags` and `userMediaProgress`. The connector now supplies those fields alongside its existing aliases. This changes response serialization, not the underlying progress write rules.
- **Disconnect did not revoke the session.** BookPlayer posts to `/logout` relative to its server URL. `/abs/logout` now uses OperaLibre's existing session-revocation handler.
- Structured authors and narrators are now included alongside the existing name strings.

### Validation

The opt-in Rust test `bookplayer_live_contract` starts a real HTTP listener on an ephemeral loopback port with a disposable two-book WAV library and a fixture owner. A Python wrapper extracts the unchanged library, item, search, filter, collection, and detail response declarations from a BookPlayer checkout and compiles them with Swift. A Foundation URLSession harness checks:

- Public discovery, local sign-in, and authenticated library decoding.
- Book decoding, pagination, expanded files, series IDs/sequence, tags, filters, search, and empty collections.
- A progress update through the OperaLibre ABS endpoint and the nested response consumed by BookPlayer.
- An authenticated item download with a `.zip` response filename and archive integrity validation.
- Logout and subsequent rejection of the revoked token.
- Separately, OPDS XML parsing, navigation using the feed's media token, and an HTTP byte-range audio download.

Run on macOS with Swift installed:

```sh
git clone --depth 1 https://github.com/TortugaPower/BookPlayer.git /tmp/bookplayer
BOOKPLAYER_CHECKOUT=/tmp/bookplayer cargo test --locked \
  --manifest-path apps/server/Cargo.toml bookplayer_live_contract -- --ignored --nocapture
```

The test passed against the revision above. The server suite also passed: 369 tests, four opt-in tests ignored; Clippy with warnings denied passed. The BookPlayer contract test was run separately and passed.

**Validation boundary:** this compiles upstream response models, not the full BookPlayer app or its connection service. The HTTP harness mirrors the inspected requests. iOS UI navigation, Keychain persistence, archive import into BookPlayer, playback, CarPlay, physical devices, production proxies, and large M4B downloads remain unverified. The progress test verifies the server contract; it does not establish automatic BookPlayer-to-OperaLibre playback synchronization. The inspected BookPlayer connector downloads books for local import and does not implement ABS progress writes.

Remaining display limitations include missing original library timestamps (so recent sorting cannot reflect actual addition dates), ignored server-side sort parameters, absent total sizes, and zero placeholder file sizes. Existing clients may show unknown sizes or an unexpected ordering.

## Other Audiobookshelf clients

The [official mobile client revision 7292e36](https://github.com/advplyr/audiobookshelf-app/tree/7292e367d21deb4bfb364d72081e2a5bbb86b709) uses routes beyond the current connector:

| Client behavior | Required capability | OperaLibre status |
| --- | --- | --- |
| Reconnect/authorize | `POST /api/authorize` | Missing under `/abs`. |
| Home shelves | `GET /api/libraries/{id}/personalized` | Missing. |
| Report streaming progress | `POST /api/session/{id}/sync` and `/close` | Missing. Opening `/items/{id}/play` currently returns a descriptor without a managed ABS session lifecycle. |
| Upload offline listening | `/api/session/local` and `/local-all` | Missing. |
| Live updates | Socket.IO at the configured server path | Missing. |

Evidence: `layouts/default.vue`, `pages/bookshelf/index.vue`, `plugins/server.js`, `ios/App/Shared/util/ApiClient.swift`, and `android/app/src/main/java/com/audiobookshelf/app/server/ApiHandler.kt` in that checkout. These are source findings; the official app was not run.

Universal drop-in compatibility is therefore not supported. The next substantial compatibility effort should target a named streaming client, implement its authorization and session lifecycle with user/book access checks and the existing stale-progress protections, and validate reconnect, seek, offline replay, and cross-device resume. Returning success from an unimplemented session endpoint would hide lost progress.

## OPDS

For an OPDS-capable reader, use `https://your-server/api/opds?token=MEDIA_TOKEN`. Both feed navigation and track acquisition links carry the read-only media credential. Normal bearer authentication is also accepted; HTTP Basic is not implemented.

The current feed provides a separate acquisition per track. Client handling of multiple audio acquisitions varies, so a successful XML parse alone does not establish complete-book import. There is no aggregate audiobook acquisition or playback-progress protocol in this feed. BookPlayer cannot consume it through its existing connectors; use `/abs` for BookPlayer.
