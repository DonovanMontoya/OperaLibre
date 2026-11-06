package com.operalibre.mobile;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
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
            Map<String, Long> checksums = validateDirectory(archive, expected);
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
                        if (written != asset.size || entry.getCrc() != checksums.get(name) || !MessageDigest.isEqual(actual.toString().getBytes(java.nio.charset.StandardCharsets.US_ASCII), asset.sha256.getBytes(java.nio.charset.StandardCharsets.US_ASCII))) throw new IOException("Gift integrity check failed.");
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

    /** APPNOTE 4.3.14-16: bound the single-disk directory before a library
     * allocates its index. ZipInputStream alone never reads these records.
     * ZIP64 values are unsigned: reject the high bit before any arithmetic. */
    private static long unsigned(byte[] bytes, int at, int width) throws IOException {
        if (at < 0 || at > bytes.length - width || (width == 8 && bytes[at + 7] < 0)) throw new IOException("Invalid ZIP integer.");
        long value = 0;
        for (int i = width - 1; i >= 0; i--) value = (value << 8) | (bytes[at + i] & 255L);
        return value;
    }

    private static byte[] readAt(RandomAccessFile file, long at, int count) throws IOException {
        if (at < 0 || at > file.length() || count > file.length() - at) throw new IOException("Truncated ZIP directory.");
        byte[] bytes = new byte[count]; file.seek(at); file.readFully(bytes); return bytes;
    }

    private static Map<String, Long> validateDirectory(File archive, Map<String, Asset> expected) throws IOException {
        long count;
        Map<String, Long> checksums = new HashMap<>();
        try (RandomAccessFile file = new RandomAccessFile(archive, "r")) {
            long length = file.length();
            if (length < 22 || length > MAX_BYTES) throw new IOException("Invalid ZIP size.");
            int tailSize = (int) Math.min(length, 22 + 65535);
            byte[] tail = readAt(file, length - tailSize, tailSize);
            int end = -1;
            for (int at = tail.length - 22; at >= 0; at--) {
                if (unsigned(tail, at, 4) == 0x06054b50L && unsigned(tail, at + 20, 2) == tail.length - at - 22) { end = at; break; }
            }
            if (end < 0 || unsigned(tail, end + 4, 2) != 0 || unsigned(tail, end + 6, 2) != 0) throw new IOException("Invalid ZIP end record.");
            long endOffset = length - tailSize + end;
            long diskCount = unsigned(tail, end + 8, 2);
            count = unsigned(tail, end + 10, 2);
            long size = unsigned(tail, end + 12, 4), offset = unsigned(tail, end + 16, 4);
            long directoryEnd = endOffset;
            boolean required = diskCount == 65535 || count == 65535 || size == 0xffffffffL || offset == 0xffffffffL;
            byte[] locator = endOffset >= 20 ? readAt(file, endOffset - 20, 20) : new byte[20];
            if (unsigned(locator, 0, 4) == 0x07064b50L) {
                if (unsigned(locator, 4, 4) != 0 || unsigned(locator, 16, 4) != 1) throw new IOException("Split ZIP64 is unsupported.");
                long zip64Offset = unsigned(locator, 8, 8);
                if (endOffset < 76 || zip64Offset > endOffset - 76) throw new IOException("Invalid ZIP64 offset.");
                byte[] zip64 = readAt(file, zip64Offset, 56);
                long recordSize = unsigned(zip64, 4, 8);
                // The server has no ZIP64 extensible metadata. Bound that
                // optional sector before a platform library can allocate it.
                if (unsigned(zip64, 0, 4) != 0x06064b50L || recordSize < 44 || recordSize > 64 * 1024 || recordSize != endOffset - 20 - zip64Offset - 12
                    || unsigned(zip64, 14, 2) < 45 || unsigned(zip64, 16, 4) != 0 || unsigned(zip64, 20, 4) != 0) throw new IOException("Invalid ZIP64 end record.");
                long wideDiskCount = unsigned(zip64, 24, 8), wideCount = unsigned(zip64, 32, 8);
                long wideSize = unsigned(zip64, 40, 8), wideOffset = unsigned(zip64, 48, 8);
                if ((diskCount != 65535 && diskCount != wideDiskCount) || (count != 65535 && count != wideCount)
                    || (size != 0xffffffffL && size != wideSize) || (offset != 0xffffffffL && offset != wideOffset)) throw new IOException("Inconsistent ZIP64 end records.");
                diskCount = wideDiskCount; count = wideCount; size = wideSize; offset = wideOffset; directoryEnd = zip64Offset;
            } else if (required) throw new IOException("Missing ZIP64 locator.");
            // Each central header has at most a 255-byte selected name and
            // uint16-sized extra/comment fields. Never index an unbounded CD.
            long maximumDirectory = MAX_ENTRIES * (46L + 255 + 65535 + 65535);
            if (count < 1 || count > MAX_ENTRIES || count != diskCount || count != expected.size()
                || size < count * 46 || size > maximumDirectory || offset > directoryEnd || size != directoryEnd - offset) throw new IOException("Invalid ZIP directory bounds.");
            validateHeaders(file, offset, directoryEnd, count);
        }
        // Use the vetted ZIP64 central parser as well as the local streaming
        // parser. Their selected entry names and sizes must agree with receipts.
        try (ZipFile zip = new ZipFile(archive)) {
            Set<String> seen = new HashSet<>();
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                Asset asset = expected.get(entry.getName());
                if (asset == null || entry.isDirectory() || !seen.add(entry.getName()) || seen.size() > MAX_ENTRIES
                    || entry.getSize() != asset.size || entry.getCompressedSize() < 0 || entry.getCompressedSize() > MAX_BYTES) throw new IOException("Invalid ZIP directory entry.");
                checksums.put(entry.getName(), entry.getCrc());
            }
            if (seen.size() != count) throw new IOException("ZIP directory count mismatch.");
        }
        return checksums;
    }

    /** ZIP64 extra fields contain only sentinel-replaced values, in the fixed
     * size/compressed-size/local-offset/disk order (APPNOTE 4.5.3). */
    private static long[] expanded(byte[] extra, long size, long compressed, long offset, long disk) throws IOException {
        long[] values = {size, compressed, offset, disk};
        boolean[] wide = {size == 0xffffffffL, compressed == 0xffffffffL, offset == 0xffffffffL, disk == 65535};
        boolean found = false;
        for (int at = 0; at < extra.length;) {
            if (extra.length - at < 4) throw new IOException("Truncated ZIP extra field.");
            int kind = (int) unsigned(extra, at, 2), length = (int) unsigned(extra, at + 2, 2);
            at += 4;
            if (length > extra.length - at) throw new IOException("Truncated ZIP extra field.");
            if (kind == 1) {
                if (found) throw new IOException("Duplicate ZIP64 extra field.");
                found = true; int cursor = at;
                for (int index = 0; index < values.length; index++) if (wide[index]) {
                    int width = index == 3 ? 4 : 8;
                    if (width > at + length - cursor) throw new IOException("Missing ZIP64 value.");
                    values[index] = unsigned(extra, cursor, width); cursor += width;
                }
                if (cursor != at + length) throw new IOException("Unexpected ZIP64 values.");
            }
            at += length;
        }
        if (!found && (wide[0] || wide[1] || wide[2] || wide[3])) throw new IOException("Missing ZIP64 extra field.");
        return values;
    }

    private static void validateHeaders(RandomAccessFile file, long start, long end, long count) throws IOException {
        long cursor = start, total = 0;
        for (int i = 0; i < count; i++) {
            if (end - cursor < 46) throw new IOException("Truncated ZIP central header.");
            byte[] header = readAt(file, cursor, 46);
            int nameLength = (int) unsigned(header, 28, 2), extraLength = (int) unsigned(header, 30, 2);
            long variable = nameLength + extraLength + unsigned(header, 32, 2);
            if (unsigned(header, 0, 4) != 0x02014b50L || nameLength < 1 || nameLength > 255 || variable > end - cursor - 46) throw new IOException("Invalid ZIP central header.");
            byte[] name = readAt(file, cursor + 46, nameLength);
            byte[] extra = readAt(file, cursor + 46 + nameLength, extraLength);
            long[] wide = expanded(extra, unsigned(header, 24, 4), unsigned(header, 20, 4), unsigned(header, 42, 4), unsigned(header, 34, 2));
            long size = wide[0], compressed = wide[1], offset = wide[2];
            if (size > MAX_BYTES - total || compressed > MAX_BYTES || wide[3] != 0 || start < 30 || offset > start - 30) throw new IOException("Invalid ZIP64 entry bounds.");
            total += size;
            byte[] local = readAt(file, offset, 30);
            int localName = (int) unsigned(local, 26, 2), localExtra = (int) unsigned(local, 28, 2);
            long dataOffset = offset + 30 + localName + localExtra;
            if (unsigned(local, 0, 4) != 0x04034b50L || localName != nameLength || dataOffset > start || compressed > start - dataOffset
                || unsigned(local, 6, 2) != unsigned(header, 8, 2) || unsigned(local, 8, 2) != unsigned(header, 10, 2)
                || !java.util.Arrays.equals(name, readAt(file, offset + 30, localName))) throw new IOException("Local ZIP header mismatch.");
            long[] localWide = expanded(readAt(file, offset + 30 + localName, localExtra), unsigned(local, 22, 4), unsigned(local, 18, 4), 0, 0);
            if ((unsigned(local, 6, 2) & 8) == 0 && (localWide[0] != size || localWide[1] != compressed || unsigned(local, 14, 4) != unsigned(header, 16, 4))) throw new IOException("Local ZIP sizes mismatch.");
            cursor += 46 + variable;
        }
        if (cursor != end) throw new IOException("ZIP central entry count mismatch.");
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
