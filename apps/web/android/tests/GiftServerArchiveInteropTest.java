import com.operalibre.mobile.GiftArchiveExtractor;
import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Run against an actual Rust HTTP archive and its selected receipt. This is
 * host-JVM extraction evidence, not Android bridge or device verification. */
public final class GiftServerArchiveInteropTest {
    public static void main(String[] args) throws Exception {
        if (args.length < 4 || (args.length - 1) % 3 != 0) throw new IllegalArgumentException("Archive plus selected name/size/hash triples required.");
        List<GiftArchiveExtractor.Asset> assets = new ArrayList<>();
        Set<String> names = new HashSet<>();
        for (int i = 1; i < args.length; i += 3) {
            if (!names.add(args[i])) throw new AssertionError("Duplicate fixture manifest.");
            assets.add(new GiftArchiveExtractor.Asset(args[i], Long.parseLong(args[i + 1]), args[i + 2]));
        }
        File root = Files.createTempDirectory("operalibre-server-archive-interop-").toFile();
        File imported = GiftArchiveExtractor.extract(new File(args[0]), root, "server_gift_fixture_1", assets);
        String[] files = imported.list();
        if (files == null || files.length != names.size()) throw new AssertionError("Unselected or missing imported file.");
        for (String name : files) if (!names.contains(name)) throw new AssertionError("Unselected imported file.");
        File duplicate = GiftArchiveExtractor.extract(new File(args[0]), root, "server_gift_fixture_1", assets);
        if (!duplicate.equals(imported)) throw new AssertionError("Duplicate import was not idempotent.");
        if (!names.contains("metadata.json")) throw new AssertionError("Real selected metadata was not transferred.");
        System.out.println("Actual server-selected ZIP extracted and verified on the host JVM.");
    }
}
