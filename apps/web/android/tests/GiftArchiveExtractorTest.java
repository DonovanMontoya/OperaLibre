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
