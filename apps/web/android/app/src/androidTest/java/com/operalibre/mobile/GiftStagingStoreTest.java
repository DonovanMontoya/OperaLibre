package com.operalibre.mobile;

import android.content.Context;
import android.system.Os;
import android.util.Base64;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.Locale;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import static org.junit.Assert.*;

/** Requires an Android device/emulator: real OS file locks, no-follow opens,
 * fsync, ownership and cleanup. The disabled production plugin is not enabled. */
@RunWith(AndroidJUnit4.class)
public final class GiftStagingStoreTest {
    private static final String ID = "gift____________";
    private final Object first = new Object(), other = new Object();
    private File root, incoming;
    private interface Checked { void run() throws Exception; }
    private static void rejects(Checked action) throws Exception {
        try { action.run(); fail("operation accepted"); } catch (Exception expected) { }
    }
    private static void put(File file, byte[] bytes) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); }
    }
    private static String hash(byte[] bytes) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format(Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
    private static void remove(File file) throws Exception {
        if (file.getCanonicalFile().equals(file.getAbsoluteFile()) && file.isDirectory()) {
            File[] children = file.listFiles(); if (children != null) for (File child : children) remove(child);
        }
        assertTrue(file.delete());
    }
    @Before public void setup() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        root = new File(context.getCacheDir(), "gift-lease-test-" + UUID.randomUUID());
        incoming = new File(root, "gift-incoming"); assertTrue(incoming.mkdirs());
    }
    @After public void teardown() throws Exception {
        GiftStagingStore.releaseOwner(first); GiftStagingStore.releaseOwner(other);
        remove(root);
    }

    @Test public void nativeLeaseExcludesAnotherOwnerAndCleanupUntilRelease() throws Exception {
        GiftStagingStore.Acquired held = GiftStagingStore.acquire(root, first, ID, true, 10);
        assertEquals(43, held.lease.length()); assertEquals(0, held.offset);
        rejects(() -> GiftStagingStore.acquire(root, other, ID, false, 10));
        rejects(() -> GiftStagingStore.cleanup(root, ID));
        rejects(() -> GiftStagingStore.withInactive(root, ID, parent -> null));
        rejects(() -> GiftStagingStore.append(root, other, ID, held.lease, 0, "AQ=="));
        rejects(() -> GiftStagingStore.append(root, first, ID, held.lease, 1, "AQ=="));
        assertEquals(1, GiftStagingStore.append(root, first, ID, held.lease, 0, "AQ=="));
        GiftStagingStore.verify(root, first, ID, held.lease, 1, hash(new byte[]{1}));
        rejects(() -> GiftStagingStore.append(root, first, ID, held.lease, 1, "Ag=="));
        GiftStagingStore.release(root, first, ID, held.lease);
        GiftStagingStore.Acquired next = GiftStagingStore.acquire(root, other, ID, false, 10);
        assertNotEquals(held.lease, next.lease);
        rejects(() -> GiftStagingStore.release(root, first, ID, held.lease));
        GiftStagingStore.release(root, other, ID, next.lease);
        GiftStagingStore.cleanup(root, ID);
        assertFalse(new File(incoming, ID + ".zip").exists());
        assertTrue(new File(incoming, ".staging-" + ID + ".lock").isFile());
    }

    @Test public void selectedMetadataIsBoundedReceiptVerifiedStrictUtf8AndNoFollow() throws Exception {
        File directory = new File(root, "device-library/gift-" + ID); assertTrue(directory.mkdirs());
        File descriptor = new File(directory, "metadata.json");
        byte[] bytes = "{\"version\":1,\"title\":\"Gift\"}".getBytes(StandardCharsets.UTF_8);
        put(descriptor, bytes);
        GiftArchiveExtractor.Asset asset = new GiftArchiveExtractor.Asset("metadata.json", bytes.length, hash(bytes));
        assertEquals(new String(bytes, StandardCharsets.UTF_8), GiftStagingStore.withInactive(root, ID, parent -> GiftStagingStore.readMetadata(directory, asset)));
        put(descriptor, new byte[bytes.length]);
        rejects(() -> GiftStagingStore.withInactive(root, ID, parent -> GiftStagingStore.readMetadata(directory, asset)));
        byte[] invalidUtf8 = new byte[]{(byte) 0xc3, (byte) 0x28}; put(descriptor, invalidUtf8);
        rejects(() -> GiftStagingStore.readMetadata(directory, new GiftArchiveExtractor.Asset("metadata.json", invalidUtf8.length, hash(invalidUtf8))));
        rejects(() -> GiftStagingStore.readMetadata(directory, new GiftArchiveExtractor.Asset("metadata.json", 256 * 1024 + 1, hash(bytes))));
        assertTrue(descriptor.delete());
        File outside = new File(root, "private-metadata.json"); put(outside, bytes);
        Os.symlink(outside.getPath(), descriptor.getPath());
        rejects(() -> GiftStagingStore.readMetadata(directory, asset));
    }

    @Test public void emptyOrphanCanBeReusedButAmbiguousOrNonemptyStateCannot() throws Exception {
        File archive = new File(incoming, ID + ".zip"); put(archive, new byte[0]);
        GiftStagingStore.Acquired held = GiftStagingStore.acquire(root, first, ID, true, 10);
        GiftStagingStore.release(root, first, ID, held.lease);
        File pending = new File(incoming, ".recovery-" + ID + ".tmp"); put(pending, new byte[]{1});
        rejects(() -> GiftStagingStore.acquire(root, first, ID, true, 10)); assertTrue(pending.delete());
        put(archive, new byte[]{1}); rejects(() -> GiftStagingStore.acquire(root, first, ID, true, 10)); assertEquals(1, archive.length());
    }

    @Test public void chunksAreBoundedCanonicalAndCannotCrossTheMaximum() throws Exception {
        GiftStagingStore.Acquired held = GiftStagingStore.acquire(root, first, ID, true, 1);
        rejects(() -> GiftStagingStore.append(root, first, ID, held.lease, 0, ""));
        rejects(() -> GiftStagingStore.append(root, first, ID, held.lease, 0, "AQ"));
        rejects(() -> GiftStagingStore.append(root, first, ID, held.lease, 0, Base64.encodeToString(new byte[65537], Base64.NO_WRAP)));
        rejects(() -> GiftStagingStore.append(root, first, ID, held.lease, 0, "AQI="));
        assertEquals(1, GiftStagingStore.append(root, first, ID, held.lease, 0, "AQ=="));
    }

    @Test public void teardownReleasesTheOSLockAndOldTokenCannotAppend() throws Exception {
        GiftStagingStore.Acquired held = GiftStagingStore.acquire(root, first, ID, true, 10);
        GiftStagingStore.releaseOwner(first);
        GiftStagingStore.Acquired next = GiftStagingStore.acquire(root, other, ID, false, 10);
        rejects(() -> GiftStagingStore.append(root, first, ID, held.lease, 0, "AQ=="));
        GiftStagingStore.release(root, other, ID, next.lease);
    }

    @Test public void symlinkAndChangedArchiveIdentityAreRejectedWithoutDeletingTargets() throws Exception {
        File archive = new File(incoming, ID + ".zip"), target = new File(root, "target"); put(target, new byte[]{7});
        Os.symlink(target.getPath(), archive.getPath());
        rejects(() -> GiftStagingStore.acquire(root, first, ID, false, 10));
        rejects(() -> GiftStagingStore.cleanup(root, ID)); assertEquals(1, target.length()); assertTrue(archive.delete());
        GiftStagingStore.Acquired held = GiftStagingStore.acquire(root, first, ID, true, 10);
        assertTrue(archive.delete()); Os.symlink(target.getPath(), archive.getPath());
        rejects(() -> GiftStagingStore.append(root, first, ID, held.lease, 0, "AQ=="));
        GiftStagingStore.release(root, first, ID, held.lease); assertEquals(1, target.length());
    }

    @Test public void directorySyncRejectsFilesAndSymlinks() throws Exception {
        GiftRecoveryStore.syncDirectory(incoming);
        File file = new File(root, "regular-file"); put(file, new byte[]{7});
        File link = new File(root, "directory-link"); Os.symlink(incoming.getPath(), link.getPath());
        rejects(() -> GiftRecoveryStore.syncDirectory(file));
        rejects(() -> GiftRecoveryStore.syncDirectory(link));
        assertEquals(1, file.length()); assertTrue(incoming.isDirectory());
    }

    @Test public void failedExtractionKeepsPrefixAndCommittedRecoveryWorksAfterCleanup() throws Exception {
        File archive = new File(incoming, ID + ".zip"), library = new File(root, "device-library"); assertTrue(library.mkdir());
        byte[] ebook = "gift ebook".getBytes(StandardCharsets.UTF_8);
        try (ZipOutputStream output = new ZipOutputStream(new FileOutputStream(archive))) { output.putNextEntry(new ZipEntry("book.epub")); output.write(ebook); output.closeEntry(); }
        GiftArchiveExtractor.Asset asset = new GiftArchiveExtractor.Asset("book.epub", ebook.length, hash(ebook));
        rejects(() -> GiftStagingStore.withInactive(root, ID, parent -> GiftArchiveExtractor.extract(archive, library, ID,
            Collections.singletonList(new GiftArchiveExtractor.Asset("book.epub", ebook.length, hash(new byte[]{0}))))));
        assertTrue(archive.isFile());
        File sidecar = new File(incoming, ".recovery-" + ID + ".json"); put(sidecar, new byte[]{1});
        File committed = GiftStagingStore.withInactive(root, ID, parent -> {
            File result = GiftArchiveExtractor.extract(archive, library, ID, Collections.singletonList(asset));
            GiftStagingStore.syncCommitted(result); GiftRecoveryStore.cleanup(root, ID); return result;
        });
        assertFalse(archive.exists()); assertFalse(sidecar.exists()); assertTrue(new File(committed, "book.epub").isFile());
        assertEquals(committed, GiftStagingStore.withInactive(root, ID,
            parent -> GiftArchiveExtractor.extract(archive, library, ID, Collections.singletonList(asset))));
    }
}
