import com.operalibre.mobile.GiftArchiveExtractor;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.zip.CRC32;

/** Explicit opt-in, real >4-GiB host-JVM extraction regression. No default root,
 * no /tmp fallback, and no Android/device/audio-playback claim. audio.m4b is a
 * zero-filled test blob, not playable media. The sparse input has a genuine
 * 4-GiB+1-byte STORED entry; the extractor writes and hashes every output byte.
 *
 * Compile alongside GiftArchiveExtractor.java, then invoke with an EMPTY,
 * already-created run.XXXXXXXX directory directly beneath a directory named
 * operalibre-gift-large-tests on the chosen test volume. The supplied directory
 * is not removed. No environment-specific path or implicit volume is chosen.
 */
public final class GiftLargeZip64InteropTest {
    private static final long PAYLOAD_BYTES = (1L << 32) + 1;
    private static final long RESERVE_BYTES = 512L * 1024 * 1024;
    private static final long SPARSE_ALLOCATION_CAP = 64L * 1024 * 1024;
    private static final long FIXTURE_SIZE_CAP = PAYLOAD_BYTES + 1024;
    private static final int BUFFER_BYTES = 64 * 1024;
    private static final String GIFT_ID = "large_zip64_fixture_1";
    private static final String ENTRY = "audio.m4b";
    private record Checksums(String sha256, long crc32) {}

    private static void require(boolean condition, String message) throws IOException {
        if (!condition) throw new IOException(message);
    }

    private static Path ownedRoot(String[] args) throws IOException {
        require(args.length == 1, "Supply one fresh task-owned workspace directory; no default/fallback.");
        Path root = Path.of(args[0]);
        Path parent = root.getParent();
        require(root.isAbsolute() && root.equals(root.normalize()) && parent != null
            && parent.getFileName() != null && parent.getFileName().toString().equals("operalibre-gift-large-tests")
            && root.getFileName().toString().matches("run\\.[A-Za-z0-9]{8}"),
            "Supply a fresh run.XXXXXXXX child of an explicit operalibre-gift-large-tests directory.");
        require(parent.toRealPath().equals(parent)
            && Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS) && root.toRealPath().equals(root),
            "Fixture root and parent must be existing real directories, not symlinks.");
        try (var entries = Files.list(root)) {
            require(entries.findAny().isEmpty(), "Fixture root must be empty; existing contents are never removed.");
        }
        require(Files.getFileStore(root).getUsableSpace() >= PAYLOAD_BYTES + RESERVE_BYTES + SPARSE_ALLOCATION_CAP,
            "Insufficient workspace space for real output plus reserve; refusing any fallback.");
        return root;
    }

    private static Checksums checksums(InputStream input, boolean zeros) throws Exception {
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        CRC32 crc = new CRC32();
        byte[] buffer = new byte[BUFFER_BYTES];
        long remaining = PAYLOAD_BYTES;
        while (remaining > 0) {
            int count = (int) Math.min(remaining, buffer.length);
            if (!zeros) {
                int read = input.read(buffer, 0, count);
                require(read > 0, "Real extracted output was truncated.");
                count = read;
            }
            sha.update(buffer, 0, count); crc.update(buffer, 0, count); remaining -= count;
        }
        if (!zeros) require(input.read() == -1, "Real extracted output exceeds the exact ZIP64 size.");
        return new Checksums(HexFormat.of().formatHex(sha.digest()), crc.getValue());
    }

    private static void little(ByteArrayOutputStream out, long value, int width) {
        for (int i = 0; i < width; i++) out.write((int) (value >>> (8 * i)) & 255);
    }
    private static void write(FileChannel file, byte[] bytes) throws IOException {
        ByteBuffer buffer = ByteBuffer.wrap(bytes);
        while (buffer.hasRemaining()) file.write(buffer);
    }

    /** PKWARE APPNOTE 4.3.14-16 / 4.5.3: complete single-disk ZIP64, including
     * wide local sizes, central sizes/offset, EOCD64, locator and legacy sentinels.
     * The caller exclusively created this file and owns its cleanup already.
     */
    private static void writeSparseZip(FileChannel file, Checksums checksums) throws IOException {
        byte[] name = ENTRY.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        ByteArrayOutputStream header = new ByteArrayOutputStream();
        little(header, 0x04034b50L, 4); little(header, 45, 2); little(header, 0x800, 2);
        little(header, 0, 2); little(header, 0, 4); little(header, checksums.crc32(), 4);
        little(header, 0xffffffffL, 4); little(header, 0xffffffffL, 4);
        little(header, name.length, 2); little(header, 20, 2); header.writeBytes(name);
        little(header, 1, 2); little(header, 16, 2); little(header, PAYLOAD_BYTES, 8); little(header, PAYLOAD_BYTES, 8);
        write(file, header.toByteArray());
        long directoryOffset = Math.addExact(file.position(), PAYLOAD_BYTES);
        // Seeking then writing on a newly created SPARSE file leaves a genuine
        // logical zero-filled entry, rather than a forged tiny entry length.
        file.position(directoryOffset);
        ByteArrayOutputStream central = new ByteArrayOutputStream();
        little(central, 0x02014b50L, 4); little(central, 45, 2); little(central, 45, 2);
        little(central, 0x800, 2); little(central, 0, 2); little(central, 0, 4); little(central, checksums.crc32(), 4);
        little(central, 0xffffffffL, 4); little(central, 0xffffffffL, 4);
        little(central, name.length, 2); little(central, 28, 2); little(central, 0, 2);
        little(central, 0, 2); little(central, 0, 2); little(central, 0, 4); little(central, 0xffffffffL, 4);
        central.writeBytes(name); little(central, 1, 2); little(central, 24, 2);
        little(central, PAYLOAD_BYTES, 8); little(central, PAYLOAD_BYTES, 8); little(central, 0, 8);
        write(file, central.toByteArray());
        long end64Offset = file.position();
        ByteArrayOutputStream end = new ByteArrayOutputStream();
        little(end, 0x06064b50L, 4); little(end, 44, 8); little(end, 45, 2); little(end, 45, 2);
        little(end, 0, 4); little(end, 0, 4); little(end, 1, 8); little(end, 1, 8);
        little(end, central.size(), 8); little(end, directoryOffset, 8);
        little(end, 0x07064b50L, 4); little(end, 0, 4); little(end, end64Offset, 8); little(end, 1, 4);
        little(end, 0x06054b50L, 4); little(end, 0, 4); little(end, 65535, 2); little(end, 65535, 2);
        little(end, 0xffffffffL, 4); little(end, 0xffffffffL, 4); little(end, 0, 2);
        require(end64Offset + end.size() <= FIXTURE_SIZE_CAP, "Sparse fixture exceeded its fixed logical-size cap.");
        write(file, end.toByteArray()); file.force(true);
        require(file.size() > (1L << 32) && file.size() <= FIXTURE_SIZE_CAP, "Fixture is not the expected real ZIP64 size.");
    }

    private static void deleteOwnedFile(Path path) throws IOException {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return;
        require(Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS), "Unexpected non-file at an owned fixture path; left untouched.");
        Files.delete(path);
    }
    private static void deleteOwnedOutput(Path directory) throws IOException {
        if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) return;
        require(Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS), "Unexpected fixture directory replacement; left untouched.");
        // No recursive deletion: only the one exact expected payload is ours.
        try (var entries = Files.list(directory)) {
            require(entries.allMatch(path -> path.getFileName().toString().equals(ENTRY)),
                "Unknown fixture-directory contents; left untouched.");
        }
        deleteOwnedFile(directory.resolve(ENTRY)); Files.delete(directory);
    }

    public static void main(String[] args) throws Exception {
        Path root = ownedRoot(args), archive = root.resolve("large-stored-zip64.zip");
        Path marker = root.resolve(".large-zip64-test-owner"), destination = root.resolve("gift-" + GIFT_ID);
        boolean archiveOwned = false, extractionStarted = false;
        // CREATE_NEW prevents competing invocations from sharing this root.
        Files.createFile(marker);
        try {
            System.out.println("Opt-in host test: extracting 4 GiB + 1 real bytes; zero blob, not playable audio/device evidence.");
            Checksums expected = checksums(null, true);
            long before = Files.getFileStore(root).getUsableSpace();
            try (FileChannel file = FileChannel.open(archive, StandardOpenOption.CREATE_NEW,
                    StandardOpenOption.READ, StandardOpenOption.WRITE, StandardOpenOption.SPARSE)) {
                archiveOwned = true; writeSparseZip(file, expected);
            }
            long after = Files.getFileStore(root).getUsableSpace();
            require(before - after <= SPARSE_ALLOCATION_CAP, "Input was not sufficiently sparse, or workspace usage changed; refusing extraction.");
            require(after >= PAYLOAD_BYTES + RESERVE_BYTES, "Workspace no longer has output capacity plus 512-MiB reserve.");
            var assets = List.of(new GiftArchiveExtractor.Asset(ENTRY, PAYLOAD_BYTES, expected.sha256()));
            extractionStarted = true;
            Path imported = GiftArchiveExtractor.extract(archive.toFile(), root.toFile(), GIFT_ID, assets).toPath();
            require(imported.equals(destination), "Unexpected extraction destination.");
            Path payload = destination.resolve(ENTRY);
            require(Files.size(payload) == PAYLOAD_BYTES, "Extracted payload did not cross the real 32-bit boundary.");
            try (InputStream input = Files.newInputStream(payload)) {
                require(checksums(input, false).equals(expected), "Real extracted bytes failed independent streaming SHA-256/CRC32 verification.");
            }
            require(GiftArchiveExtractor.extract(archive.toFile(), root.toFile(), GIFT_ID, assets).toPath().equals(destination),
                "Large duplicate did not reverify the committed output.");
            // Same-size corruption must fail duplicate integrity, not merely a
            // cheap length check. No second output or additional large file.
            try (RandomAccessFile file = new RandomAccessFile(payload.toFile(), "rw")) { file.write(1); file.getFD().sync(); }
            try {
                GiftArchiveExtractor.extract(archive.toFile(), root.toFile(), GIFT_ID, assets);
                throw new AssertionError("Same-size corruption of the large duplicate was accepted.");
            } catch (IOException expectedFailure) {
                require("Gift integrity check failed.".equals(expectedFailure.getMessage()),
                    "Large duplicate failed for a reason other than the required digest mismatch.");
            }
            System.out.println("PASS: real 4294967297-byte ZIP64 extraction, independent hashes, duplicate verification and tamper rejection.");
        } finally {
            if (extractionStarted) {
                deleteOwnedOutput(destination);
                // These UUID-named staging directories can only originate
                // from this invocation in the initially empty, claimed root.
                try (var entries = Files.list(root)) {
                    for (Path path : entries.filter(path -> path.getFileName().toString().matches(
                            "\\.gift-staging-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")).toList()) {
                        deleteOwnedOutput(path);
                    }
                }
                deleteOwnedFile(root.resolve(".gift-lock-" + GIFT_ID));
            }
            if (archiveOwned) deleteOwnedFile(archive);
            deleteOwnedFile(marker);
        }
    }
}
