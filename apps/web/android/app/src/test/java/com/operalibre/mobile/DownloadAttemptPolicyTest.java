package com.operalibre.mobile;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.file.Files;

import static org.junit.Assert.*;

public class DownloadAttemptPolicyTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test public void cancelledAttemptCannotWriteIntoRestartedBook() {
        assertTrue(DownloadAttemptPolicy.sameAttempt("first", "first"));
        assertFalse(DownloadAttemptPolicy.sameAttempt("second", "first"));
        assertFalse(DownloadAttemptPolicy.sameAttempt("second", ""));
        assertTrue(DownloadAttemptPolicy.sameAttempt("", ""));
    }

    @Test public void oldPartialCleanupCannotDeleteReplacementPartial() throws Exception {
        File destination = new File(folder.getRoot(), "audio.m4b");
        File first = DownloadAttemptPolicy.partialFile(destination, "first");
        File second = DownloadAttemptPolicy.partialFile(destination, "second");
        Files.write(first.toPath(), new byte[] {1});
        Files.write(second.toPath(), new byte[] {2, 3});
        assertTrue(first.delete());
        assertArrayEquals(new byte[] {2, 3}, Files.readAllBytes(second.toPath()));
        assertEquals(destination.getPath() + ".part", DownloadAttemptPolicy.partialFile(destination, "").getPath());
    }

    @Test public void persistedCompletionRequiresAnIntactFile() throws Exception {
        File destination = new File(folder.getRoot(), "audio.m4b");
        assertFalse(DownloadAttemptPolicy.usableFile(destination, -1));
        assertTrue(destination.createNewFile());
        assertFalse(DownloadAttemptPolicy.usableFile(destination, -1));
        Files.write(destination.toPath(), new byte[] {1, 2, 3});
        assertTrue(DownloadAttemptPolicy.usableFile(destination, 3));
        assertTrue(DownloadAttemptPolicy.usableFile(destination, -1));
        assertFalse(DownloadAttemptPolicy.usableFile(destination, 4));
        assertTrue(destination.delete());
        assertFalse(DownloadAttemptPolicy.usableFile(destination, 3));
    }
}
