# 0018. Stage native gifts before publishing the library entry

Status: Accepted.

## Context

Gift transfer and extraction cross the WebView, native file I/O, and the local library index. A WebView can close mid-operation, and archive metadata and bearer records must be handled within their separate trust boundaries.

## Decision

- Keep the experimental native entry points gated. Extract only selected manifest entries into a private staging directory. Use the operating system's lease to serialize operations on one gift and publish validated files with a same-filesystem rename. Publish the local library index separately and recover if the application stops between those operations.
- Bound the single-disk ZIP64 directory before a library allocates its index. Check the signed range before arithmetic and handle sentinel fields in the specified order. Bound extensible metadata and compare the selected central and streamed entries with their receipts. Accept an archive with an ordinary-sized directory and ZIP64 local headers when the server's large-file writer emits that form.
- Keep bearer state and staging outside device backups. On iOS apply locked-device protection. Keep record data and paths out of logs and JavaScript errors. Anchor reads to the held staging directory and return data only after the file matches its receipt. Refuse unexpected file types or identities during recovery.
- Take the staging lease before the record lock. Preserve lock files so every holder coordinates on the same inode. Native locks cover multiple processes and same-process checks cover multiple plugin instances. Drain calls from an abandoned WebView before releasing its leases. On iOS, distinguish a Capacitor bridge reset from a JavaScript listener call.
- Use conditional record writes, treating an absent previous record as create-if-absent. Validate a leftover temporary file before replacing it. Require the record and directory state to be durable. If a write reports an error after rename, reload and reconcile its actual outcome. Reuse an orphan staging file only when it is empty and there is no committed or ambiguous record.

## Consequences

Recovery can reconcile an interrupted transfer or library publication without accepting an unchecked archive entry or erasing an active transfer. The WebView does not own the native lease.

See [iOS gift extraction](../../apps/web/ios/App/App/GiftArchiveExtractor.swift), [Android gift extraction](../../apps/web/android/app/src/main/java/com/operalibre/mobile/GiftArchiveExtractor.java), [Android recovery state](../../apps/web/android/app/src/main/java/com/operalibre/mobile/GiftRecoveryStore.java), and [Android staging](../../apps/web/android/app/src/main/java/com/operalibre/mobile/GiftStagingStore.java).
