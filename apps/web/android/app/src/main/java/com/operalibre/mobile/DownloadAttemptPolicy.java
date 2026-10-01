package com.operalibre.mobile;

import java.io.File;

/** Shared decisions for persisted jobs and their on-disk checkpoints. */
final class DownloadAttemptPolicy {
    private DownloadAttemptPolicy() {}

    static boolean sameAttempt(String stored, String worker) {
        // Empty tokens are only for jobs queued by older app versions.
        return stored.equals(worker);
    }

    static File partialFile(File destination, String attemptId) {
        return new File(destination.getPath() + ".part" + (attemptId.isEmpty() ? "" : "." + attemptId));
    }

    static boolean usableFile(File file, long expectedBytes) {
        return file.isFile() && file.length() > 0 && (expectedBytes < 0 || file.length() == expectedBytes);
    }
}
