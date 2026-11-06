package com.operalibre.mobile;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Experimental streaming extraction; not registered as a Capacitor plugin. */
public final class GiftArchiveExtractor {
    private static final int MAX_ENTRIES = 256;
    private static final long MAX_BYTES = 25L * 1024 * 1024 * 1024;
    private static final long MIN_FREE = 256L * 1024 * 1024;

    public static final class Asset {
        public final String name;
        public final long size;
        public final String sha256;
        public Asset(String name, long size, String sha256) {
            this.name = name; this.size = size; this.sha256 = sha256;
        }
    }

    private GiftArchiveExtractor() {}

    /**
     * Extract only manifest entries into a private staging directory. A per-ID
     * file lock serializes commits across processes; the final rename stays on
     * the same filesystem. The caller must separately publish a library index
     * entry only after success and handle recovery if publication fails.
     */
    public static synchronized File extract(File archive, File privateRoot, String giftId, List<Asset> assets) throws Exception {
        if (giftId == null || !giftId.matches("[A-Za-z0-9_-]{16,128}") || assets == null || assets.isEmpty() || assets.size() > MAX_ENTRIES) throw new IOException("Invalid gift manifest.");
        Map<String, Asset> expected = new HashMap<>();
        long declared = 0;
        for (Asset asset : assets) {
            if (asset == null || asset.name == null || !asset.name.matches("[^/\\\\\\p{Cntrl}]{1,255}") || asset.name.equals(".") || asset.name.equals("..") || asset.sha256 == null || !asset.sha256.matches("[a-f0-9]{64}") || asset.size < 0 || asset.size > MAX_BYTES || expected.put(asset.name, asset) != null) throw new IOException("Invalid gift asset.");
            if (declared > MAX_BYTES - asset.size) throw new IOException("Gift exceeds size limit.");
            declared += asset.size;
        }
        if (!privateRoot.isDirectory()) throw new IOException("Private import root is unavailable.");
        File root = privateRoot.getCanonicalFile();
        File lockFile = new File(root, ".gift-lock-" + giftId);
        try (FileOutputStream lockStream = new FileOutputStream(lockFile, true); FileChannel channel = lockStream.getChannel(); FileLock ignored = channel.lock()) {
            File destination = new File(root, "gift-" + giftId);
            if (destination.exists()) {
                verifyCommitted(destination, expected);
                return destination;
            }
            File staging = new File(root, ".gift-staging-" + UUID.randomUUID());
            if (!staging.mkdir()) throw new IOException("Cannot create gift staging directory.");
            try {
                Set<String> seen = new HashSet<>();
                long total = 0;
                try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(new FileInputStream(archive)))) {
                    byte[] buffer = new byte[64 * 1024];
                    ZipEntry entry;
                    while ((entry = zip.getNextEntry()) != null) {
                        String name = entry.getName();
                        Asset asset = expected.get(name);
                        if (entry.isDirectory() || asset == null || !seen.add(name) || seen.size() > MAX_ENTRIES) throw new IOException("Archive contains an unselected or duplicate entry.");
                        File target = new File(staging, name);
                        if (!target.createNewFile()) throw new IOException("Duplicate gift file.");
                        MessageDigest hash = MessageDigest.getInstance("SHA-256");
                        long written = 0;
                        try (FileOutputStream output = new FileOutputStream(target)) {
                            int read;
                            while ((read = zip.read(buffer)) != -1) {
                                if (read > asset.size - written || read > MAX_BYTES - total) throw new IOException("Gift entry exceeds declared size.");
                                written += read; total += read;
                                if (staging.getUsableSpace() < MIN_FREE) throw new IOException("Not enough free space.");
                                hash.update(buffer, 0, read); output.write(buffer, 0, read);
                            }
                            output.getFD().sync();
                        }
                        zip.closeEntry();
                        StringBuilder actual = new StringBuilder(64);
                        for (byte b : hash.digest()) actual.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
                        if (written != asset.size || !MessageDigest.isEqual(actual.toString().getBytes(java.nio.charset.StandardCharsets.US_ASCII), asset.sha256.getBytes(java.nio.charset.StandardCharsets.US_ASCII))) throw new IOException("Gift integrity check failed.");
                    }
                }
                if (seen.size() != expected.size()) throw new IOException("Gift is incomplete.");
                if (destination.exists() || !staging.renameTo(destination)) throw new IOException("Cannot commit gift.");
                return destination;
            } catch (Exception error) {
                File[] files = staging.listFiles();
                if (files != null) for (File file : files) if (file.isFile()) file.delete();
                staging.delete();
                throw error;
            }
        }
    }

    private static void verifyCommitted(File directory, Map<String, Asset> expected) throws Exception {
        if (!directory.isDirectory() || !directory.getCanonicalFile().equals(directory.getAbsoluteFile())) throw new IOException("Invalid gift directory.");
        File[] files = directory.listFiles();
        if (files == null || files.length != expected.size()) throw new IOException("Gift contents changed.");
        byte[] buffer = new byte[64 * 1024];
        for (File file : files) {
            Asset asset = expected.get(file.getName());
            if (asset == null || !file.isFile() || !file.getCanonicalFile().equals(file.getAbsoluteFile()) || file.length() != asset.size) throw new IOException("Gift contents changed.");
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            long total = 0;
            try (FileInputStream input = new FileInputStream(file)) {
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (count > asset.size - total) throw new IOException("Gift contents changed.");
                    total += count; hash.update(buffer, 0, count);
                }
            }
            StringBuilder digest = new StringBuilder(64);
            for (byte b : hash.digest()) digest.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            if (total != asset.size || !MessageDigest.isEqual(digest.toString().getBytes(java.nio.charset.StandardCharsets.US_ASCII), asset.sha256.getBytes(java.nio.charset.StandardCharsets.US_ASCII))) throw new IOException("Gift integrity check failed.");
        }
    }
}
