# 0002. Keep CarPlay templates responsive during playback

Status: Accepted.

## Context

Drivers use the library and Now Playing while the phone can be locked, offline, or backgrounded. CarPlay also caps how many rows a template can present.

## Decision

- Order the library sections the same way as the shelf and apply CarPlay's list cap before giving it a template. Mark books that need the server with a cloud. Use system book and headphone symbols for the same destinations as on the phone.
- Return cached artwork or draw the same stand-in spine as the shelf, then load artwork outside the list refresh. Resize cached covers to bound memory use. Include a hash in the filename so IDs that differ in punctuation do not share artwork. Read artwork metadata on the serial work queue so it incorporates earlier writes. Logout queues disk cleanup after older work and increments the cache generation so an in-flight result cannot reappear in memory.
- List rows redraw when the playing book or its playback state changes. Explicit refreshes handle changes outside that state, such as finishing a book or clearing the library. Track whether Now Playing is displayed locally to avoid a duplicate push and a synchronous read from the car.
- Selecting the book already loaded resumes from the live position. Use the duration label for time left and a clock-style label for chapter positions. Both the phone and the car offer the same playback speed choices. The CarPlay button displays the selected speed when paused, while Now Playing publishes zero playback rate to keep the lock-screen clock stopped. Update the button from the selection immediately because the engine applies the change on a later turn. Supply the button image as a dark variant so CarPlay can recolor it.

## Consequences

Artwork can appear on a later refresh. The initial list is available without waiting on the server, and playback updates that leave the playing row unchanged do not rebuild the list.

See [CarPlayScene](../../apps/web/ios/App/App/CarPlayScene.swift), [CarLibrary](../../apps/web/ios/App/App/CarLibrary.swift), [CarLibraryStore](../../apps/web/ios/App/App/CarLibraryStore.swift), and [CarPlayCoordinator](../../apps/web/ios/App/App/CarPlayCoordinator.swift).
