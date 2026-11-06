import com.operalibre.mobile.GiftArchiveExtractor;
import java.io.*;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

public final class GiftArchiveExtractorTest {
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    private static String hash(byte[] bytes) throws Exception {
        StringBuilder out = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) out.append(String.format(Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }
    private static File zip(File root, String name, byte[] bytes) throws Exception {
        File file = File.createTempFile("gift-archive-", ".zip", root);
        try (ZipOutputStream out = new ZipOutputStream(new FileOutputStream(file))) { out.putNextEntry(new ZipEntry(name)); out.write(bytes); out.closeEntry(); }
        return file;
    }
    public static void main(String[] args) throws Exception {
        GiftZip64Boundaries.run();
        File root = Files.createTempDirectory("gift-extractor-test-").toFile();
        byte[] ebook = "offline ebook".getBytes("UTF-8");
        File archive = zip(root, "book.epub", ebook);
        List<GiftArchiveExtractor.Asset> manifest = Collections.singletonList(new GiftArchiveExtractor.Asset("book.epub", ebook.length, hash(ebook)));
        File imported = GiftArchiveExtractor.extract(archive, root, "gift____________", manifest);
        check(Arrays.equals(ebook, Files.readAllBytes(new File(imported, "book.epub").toPath())), "contents");
        check(imported.equals(GiftArchiveExtractor.extract(archive, root, "gift____________", manifest)), "verified duplicate recovery");
        try { GiftArchiveExtractor.extract(zip(root, "../escape", ebook), root, "gift___________2", manifest); throw new AssertionError("escape accepted"); } catch (IOException expected) { }
        List<GiftArchiveExtractor.Asset> bad = Collections.singletonList(new GiftArchiveExtractor.Asset("book.epub", ebook.length, "0".repeat(64)));
        try { GiftArchiveExtractor.extract(archive, root, "gift___________3", bad); throw new AssertionError("bad hash accepted"); } catch (IOException expected) { }
        check(!new File(root, "gift-gift___________3").exists(), "bad gift published");
        byte[] large = new byte[8 * 1024 * 1024]; Arrays.fill(large, (byte) 7);
        File compressed = zip(root, "audio.m4b", large);
        List<GiftArchiveExtractor.Asset> tooSmall = Collections.singletonList(new GiftArchiveExtractor.Asset("audio.m4b", 1024, hash(large)));
        try { GiftArchiveExtractor.extract(compressed, root, "gift___________4", tooSmall); throw new AssertionError("expansion accepted"); } catch (IOException expected) { }
        List<GiftArchiveExtractor.Asset> big = Collections.singletonList(new GiftArchiveExtractor.Asset("audio.m4b", large.length, hash(large)));
        File largeGift = GiftArchiveExtractor.extract(compressed, root, "gift___________5", big);
        check(new File(largeGift, "audio.m4b").length() == large.length, "large streaming import");
        java.util.concurrent.atomic.AtomicInteger successes = new java.util.concurrent.atomic.AtomicInteger();
        java.util.concurrent.CountDownLatch ready = new java.util.concurrent.CountDownLatch(1);
        Runnable concurrent = () -> { try { ready.await(); GiftArchiveExtractor.extract(archive, root, "gift___________6", manifest); successes.incrementAndGet(); } catch (Exception ignored) { } };
        Thread first = new Thread(concurrent), second = new Thread(concurrent);
        first.start(); second.start(); ready.countDown(); first.join(); second.join();
        check(successes.get() == 2, "concurrent duplicate recovery");
        check(new File(root, "gift-gift___________6/book.epub").isFile(), "single committed directory");
        check(archive.delete(), "remove committed source fixture");
        check(new File(root, "gift-gift___________6").equals(GiftArchiveExtractor.extract(archive, root, "gift___________6", manifest)), "committed recovery without source archive");
        Files.write(new File(imported, "book.epub").toPath(), "altered file!".getBytes("UTF-8"));
        try { GiftArchiveExtractor.extract(archive, root, "gift____________", manifest); throw new AssertionError("modified committed file accepted"); } catch (IOException expected) { }
        if (args.length == 1) {
            byte[] serverEbook = "server generated ebook".getBytes("UTF-8");
            List<GiftArchiveExtractor.Asset> serverManifest = Collections.singletonList(new GiftArchiveExtractor.Asset("book.epub", serverEbook.length, hash(serverEbook)));
            File serverGift = GiftArchiveExtractor.extract(new File(args[0]), root, "gift___________7", serverManifest);
            check(Arrays.equals(serverEbook, Files.readAllBytes(new File(serverGift, "book.epub").toPath())), "server archive compatibility");
        }
        File[] leftovers = root.listFiles((dir, name) -> name.startsWith(".gift-staging-"));
        check(leftovers != null && leftovers.length == 0, "staging cleanup");
        System.out.println("GiftArchiveExtractor tests passed");
    }
}

/** Tiny structural ZIP64 fixtures, not multi-GiB file or Android-runtime tests.
 * The server uses STORED + large_file(true): wide LOCAL sizes can coexist with
 * a normal central directory. Full wide directory/end records are also legal.
 */
final class GiftZip64Boundaries {
    private static final long MAX = 25L * 1024 * 1024 * 1024;
    private static int cases;
    private static final class Fixture {
        byte[] bytes;
        int central, end64, locator, end, extra;
        final List<GiftArchiveExtractor.Asset> assets = new ArrayList<>();
    }
    private static void little(ByteArrayOutputStream out, long value, int width) {
        for (int i = 0; i < width; i++) out.write((int) (value >>> (i * 8)) & 255);
    }
    private static void patch(byte[] bytes, int at, long value, int width) {
        for (int i = 0; i < width; i++) bytes[at + i] = (byte) (value >>> (i * 8));
    }
    private static String hash(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    private static Fixture fixture(int count, boolean localWide, boolean centralWide, boolean endWide) throws Exception {
        Fixture result = new Fixture(); ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] data = "small actual ZIP64 payload".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        CRC32 crc = new CRC32(); crc.update(data);
        List<Integer> offsets = new ArrayList<>(); List<byte[]> names = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            byte[] name = String.format(Locale.ROOT, "book-%03d.epub", i).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            names.add(name); offsets.add(out.size());
            result.assets.add(new GiftArchiveExtractor.Asset(new String(name, java.nio.charset.StandardCharsets.UTF_8), data.length, hash(data)));
            little(out, 0x04034b50L, 4); little(out, localWide ? 45 : 20, 2);
            little(out, 0x800, 2); little(out, 0, 2); little(out, 0, 4); little(out, crc.getValue(), 4);
            little(out, localWide ? 0xffffffffL : data.length, 4); little(out, localWide ? 0xffffffffL : data.length, 4);
            little(out, name.length, 2); little(out, localWide ? 20 : 0, 2); out.write(name);
            if (localWide) { little(out, 1, 2); little(out, 16, 2); little(out, data.length, 8); little(out, data.length, 8); }
            out.write(data);
        }
        result.central = out.size();
        for (int i = 0; i < count; i++) {
            byte[] name = names.get(i);
            little(out, 0x02014b50L, 4); little(out, 45, 2); little(out, localWide || centralWide ? 45 : 20, 2);
            little(out, 0x800, 2); little(out, 0, 2); little(out, 0, 4); little(out, crc.getValue(), 4);
            little(out, centralWide ? 0xffffffffL : data.length, 4); little(out, centralWide ? 0xffffffffL : data.length, 4);
            little(out, name.length, 2); little(out, centralWide ? 28 : 0, 2);
            little(out, 0, 2); little(out, 0, 2); little(out, 0, 2); little(out, 0, 4);
            little(out, centralWide ? 0xffffffffL : offsets.get(i), 4); out.write(name);
            if (i == 0) result.extra = out.size();
            if (centralWide) { little(out, 1, 2); little(out, 24, 2); little(out, data.length, 8); little(out, data.length, 8); little(out, offsets.get(i), 8); }
        }
        int directorySize = out.size() - result.central;
        if (endWide) {
            result.end64 = out.size(); little(out, 0x06064b50L, 4); little(out, 44, 8);
            little(out, 45, 2); little(out, 45, 2); little(out, 0, 4); little(out, 0, 4);
            little(out, count, 8); little(out, count, 8); little(out, directorySize, 8); little(out, result.central, 8);
            result.locator = out.size(); little(out, 0x07064b50L, 4); little(out, 0, 4); little(out, result.end64, 8); little(out, 1, 4);
        }
        result.end = out.size(); little(out, 0x06054b50L, 4); little(out, 0, 4);
        little(out, endWide ? 65535 : count, 2); little(out, endWide ? 65535 : count, 2);
        little(out, endWide ? 0xffffffffL : directorySize, 4); little(out, endWide ? 0xffffffffL : result.central, 4); little(out, 0, 2);
        result.bytes = out.toByteArray(); return result;
    }
    private static void exercise(File root, String name, Fixture fixture, boolean valid) throws Exception {
        File archive = new File(root, name + ".zip"); Files.write(archive.toPath(), fixture.bytes);
        String id = "zip64_fixture_" + String.format(Locale.ROOT, "%04d", cases++);
        try {
            File result = GiftArchiveExtractor.extract(archive, root, id, fixture.assets);
            if (!valid) throw new AssertionError(name + " accepted");
            for (GiftArchiveExtractor.Asset asset : fixture.assets) {
                byte[] bytes = Files.readAllBytes(new File(result, asset.name).toPath());
                if (bytes.length != asset.size || !hash(bytes).equals(asset.sha256)) throw new AssertionError(name + " changed payload");
            }
        } catch (IOException error) {
            if (valid) throw new AssertionError(name + " rejected", error);
            if (new File(root, "gift-" + id).exists()) throw new AssertionError(name + " published failed extraction");
        }
        if (root.listFiles((directory, child) -> child.startsWith(".gift-staging-")).length != 0) throw new AssertionError("staging survived " + name);
    }
    private interface Mutation { void apply(Fixture fixture) throws Exception; }
    private static void reject(File root, String name, Mutation mutation) throws Exception {
        Fixture fixture = fixture(1, true, true, true); mutation.apply(fixture); exercise(root, name, fixture, false);
    }
    static void run() throws Exception {
        File root = Files.createTempDirectory("operalibre-zip64-structural-").toFile();
        exercise(root, "ordinary", fixture(1, false, false, false), true);
        exercise(root, "server-local-zip64", fixture(1, true, false, false), true);
        exercise(root, "central-zip64", fixture(1, true, true, false), true);
        exercise(root, "zip64-end-only", fixture(1, false, false, true), true);
        exercise(root, "full-zip64", fixture(1, true, true, true), true);
        Fixture commented = fixture(1, true, true, true);
        int originalLength = commented.bytes.length;
        commented.bytes = Arrays.copyOf(commented.bytes, originalLength + 32);
        patch(commented.bytes, commented.end + 20, 32, 2);
        patch(commented.bytes, originalLength, 0x06054b50L, 4);
        exercise(root, "end-signature-inside-comment", commented, true);
        exercise(root, "maximum-256-entries", fixture(256, true, true, true), true);
        reject(root, "missing-locator", f -> patch(f.bytes, f.locator, 0, 4));
        reject(root, "bad-zip64-signature", f -> patch(f.bytes, f.end64, 0, 4));
        reject(root, "short-end-record", f -> patch(f.bytes, f.end64 + 4, 43, 8));
        reject(root, "overflow-end-record", f -> patch(f.bytes, f.end64 + 4, -1L, 8));
        reject(root, "oversized-zip64-extensible-record", f -> {
            byte[] bytes = new byte[f.bytes.length + 65536];
            System.arraycopy(f.bytes, 0, bytes, 0, f.locator);
            System.arraycopy(f.bytes, f.locator, bytes, f.locator + 65536, f.bytes.length - f.locator);
            f.bytes = bytes; f.locator += 65536; f.end += 65536;
            patch(f.bytes, f.end64 + 4, 44 + 65536, 8);
        });
        reject(root, "overflow-locator-offset", f -> patch(f.bytes, f.locator + 8, -1L, 8));
        reject(root, "out-of-file-locator-offset", f -> patch(f.bytes, f.locator + 8, 0x100000000L, 8));
        reject(root, "split-archive", f -> patch(f.bytes, f.locator + 16, 2, 4));
        reject(root, "split-directory", f -> patch(f.bytes, f.end64 + 20, 1, 4));
        reject(root, "overflow-entry-count", f -> { patch(f.bytes, f.end64 + 24, -1L, 8); patch(f.bytes, f.end64 + 32, -1L, 8); });
        reject(root, "257-entry-count", f -> { patch(f.bytes, f.end64 + 24, 257, 8); patch(f.bytes, f.end64 + 32, 257, 8); });
        reject(root, "inconsistent-entry-count", f -> patch(f.bytes, f.end64 + 24, 2, 8));
        reject(root, "legacy-count-disagrees", f -> patch(f.bytes, f.end + 10, 2, 2));
        reject(root, "overflow-directory-size", f -> patch(f.bytes, f.end64 + 40, -1L, 8));
        reject(root, "overflow-directory-offset", f -> patch(f.bytes, f.end64 + 48, -1L, 8));
        reject(root, "directory-outside-file", f -> patch(f.bytes, f.end64 + 48, 0x100000000L, 8));
        reject(root, "directory-overlaps-end", f -> patch(f.bytes, f.end64 + 40, 1000, 8));
        reject(root, "missing-central-extra", f -> patch(f.bytes, f.extra, 2, 2));
        reject(root, "truncated-central-extra", f -> patch(f.bytes, f.extra + 2, 23, 2));
        reject(root, "overflow-entry-size", f -> patch(f.bytes, f.extra + 4, -1L, 8));
        reject(root, "overflow-compressed-size", f -> patch(f.bytes, f.extra + 12, -1L, 8));
        reject(root, "entry-over-25GiB", f -> patch(f.bytes, f.extra + 4, MAX + 1, 8));
        reject(root, "compressed-entry-over-25GiB", f -> patch(f.bytes, f.extra + 12, MAX + 1, 8));
        reject(root, "overflow-entry-offset", f -> patch(f.bytes, f.extra + 20, -1L, 8));
        reject(root, "entry-offset-outside-file", f -> patch(f.bytes, f.extra + 20, 0x100000000L, 8));
        reject(root, "truncated-eocd", f -> f.bytes = Arrays.copyOf(f.bytes, f.bytes.length - 1));
        reject(root, "missing-local-zip64-extra", f -> patch(f.bytes, 30 + "book-000.epub".length(), 2, 2));
        reject(root, "truncated-local-zip64-extra", f -> patch(f.bytes, 30 + "book-000.epub".length() + 2, 15, 2));
        reject(root, "overflow-local-size", f -> patch(f.bytes, 30 + "book-000.epub".length() + 4, -1L, 8));
        reject(root, "overflow-local-compressed-size", f -> patch(f.bytes, 30 + "book-000.epub".length() + 12, -1L, 8));
        reject(root, "payload-exceeds-receipt", f -> f.assets.set(0, new GiftArchiveExtractor.Asset(f.assets.get(0).name, 1, f.assets.get(0).sha256)));
        reject(root, "manifest-over-25GiB", f -> f.assets.set(0, new GiftArchiveExtractor.Asset(f.assets.get(0).name, MAX + 1, f.assets.get(0).sha256)));
        reject(root, "manifest-long-overflow", f -> f.assets.set(0, new GiftArchiveExtractor.Asset(f.assets.get(0).name, Long.MAX_VALUE, f.assets.get(0).sha256)));
        Fixture excess = fixture(257, true, true, true);
        excess.assets.remove(256);
        exercise(root, "257-actual-entries", excess, false);
        Fixture aggregate = fixture(2, true, true, true);
        GiftArchiveExtractor.Asset original = aggregate.assets.get(0);
        aggregate.assets.set(0, new GiftArchiveExtractor.Asset(original.name, MAX, original.sha256));
        exercise(root, "aggregate-manifest-over-25GiB", aggregate, false);
        System.out.println(cases + " ZIP64 structural boundary cases passed (small payloads; not >4GiB testing)");
    }
}
