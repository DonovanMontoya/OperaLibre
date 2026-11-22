# 0017. Recover Android downloads by attempt

Status: Accepted.

## Context

Android can stop a background worker while it is downloading or between publishing a file and saving its progress. Cancellation and a later replacement can use the same book ID.

## Decision

- Drain the persisted queue with one WorkManager job. Keep a worker already draining it. A chain of work requests would propagate cancellation or permanent failure from one book to later books. Schedule the worker again when a caller finds an existing live job. A worker stopped by the system returns its book to the queue without charging a failed attempt. The oldest queued or interrupted job resumes first.
- Give each enqueue its own attempt ID. A job from before that field was added can match its original worker and cannot match a new attempt. Use one store lock for cancellation, enqueue, and final publication. Invalidate the old job before deleting its files. An invalidated worker cleans up only its own partial file, since a replacement can already own the final paths.
- Verify required files and byte counts on disk before reporting completion. After a restart, recalculate progress from retained files and resume at the first missing required one. Reuse a published file after the current attempt cleared leftovers from its predecessor. Include files published just before a crash in the download budget.
- Use WorkManager backoff for transient failures and leave the book failed when attempts run out. When failure status cannot be persisted, remove the current job to avoid an indefinite retry. A stop partway through an optional file keeps it pending. Request identity encoding and reject an incomplete response against its declared size.
- Persist the connected server's origin and optional base path. Older jobs that lack the saved address retain same-origin handling. Check every source and redirect hop against the saved server or the authorized Libro.fm hosts. Parse escaped paths consistently when applying the base-path check. Libro.fm credentials stay native and its archive stream materializes regular files only. On Android, use the supported atomic rename for publication.

## Consequences

Cancellation leaves later books eligible to run, and a restarted worker can recover already published data. The worker retirement race is tracked in [#542](https://github.com/DonovanMontoya/OperaLibre/issues/542).

See [OfflineDownloadWorker](../../apps/web/android/app/src/main/java/com/operalibre/mobile/OfflineDownloadWorker.java), [BackgroundDownloadPlugin](../../apps/web/android/app/src/main/java/com/operalibre/mobile/BackgroundDownloadPlugin.java), [DownloadSourcePolicy](../../apps/web/android/app/src/main/java/com/operalibre/mobile/DownloadSourcePolicy.java), and [LibroDevicePlugin](../../apps/web/android/app/src/main/java/com/operalibre/mobile/LibroDevicePlugin.java).
