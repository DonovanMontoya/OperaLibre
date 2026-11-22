package com.operalibre.mobile;

import java.io.File;

final class DownloadAttemptPolicy {
    private DownloadAttemptPolicy() {}

    static boolean sameAttempt(String stored, String worker) {
        return stored.equals(worker);
    }

    static File partialFile(File destination, String attemptId) {
        return new File(destination.getPath() + ".part" + (attemptId.isEmpty() ? "" : "." + attemptId));
    }

    static boolean usableFile(File file, long expectedBytes) {
        return file.isFile() && file.length() > 0 && (expectedBytes < 0 || file.length() == expectedBytes);
    }
}
