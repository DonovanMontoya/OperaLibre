# 0020. Reconcile iOS background downloads with retained files

Status: Accepted.

## Context

URLSession can continue writing while the WebView is suspended. An enqueue can replace the requested file list while existing tasks finish. Completion and quota accounting have to use the files and tasks that belong to the current request.

## Decision

- Save the connected server's origin and base path with the job. Jobs written before proxied subpaths use an empty base path. Permit the accompanying reading copies, covers, and maps along with audio. Prepare the download directory once and recreate it if it disappears. Exclude re-downloadable files from backups.
- Keep existing live tasks by destination when replacing a job, including a task using an older still-valid token. Compute completion from the replacement's retained files and let still-active tasks contribute when they settle. If a move already landed before its callback, do not count it twice. A retry fills missing companion files even when audio is present.
- Reconcile task registration after recording the job so the next queue head can start even if the previous one finished during registration. Promote the next book when cancelling the current one. Wait for optional tasks to settle before final completion can cancel outstanding tasks.
- Use the job lock for final-file moves, quota reservation, cancellation, and cleanup. A stale callback cannot publish into an invalidated job. Count retained pieces and URLSession's outstanding temporary files in quota high-water marks. Reconcile older jobs that lack saved reservations before declaring them complete.
- Preserve stored records written by another app version that the current build cannot decode. Keep their files and tasks available for the build that understands them.

## Consequences

Jobs can recover across replacement or restart without counting one file twice or publishing the output of a cancelled task.

See [BackgroundDownloads](../../apps/web/ios/App/App/BackgroundDownloads.swift) and [BackgroundDownloadPolicy](../../apps/web/ios/App/App/BackgroundDownloadPolicy.swift).
