import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Host regression guard for the audited Android-24 public system API surface.
 * Reference: developer.android.com/reference/android/system/{Os,OsConstants}.
 * This does not substitute for compiling against the actual Android SDK. */
public final class GiftAndroidPublicApiTest {
    public static void main(String[] args) throws Exception {
        Set<String> constants = Set.of("ENOENT", "EEXIST", "O_CREAT", "O_EXCL", "O_NOFOLLOW", "O_NONBLOCK", "O_RDONLY", "O_RDWR", "O_WRONLY", "SEEK_SET", "S_ISDIR", "S_ISREG");
        Set<String> methods = Set.of("open", "close", "fchmod", "fstat", "fsync", "ftruncate", "lstat", "lseek", "read", "write", "rename", "unlink");
        Pattern constant = Pattern.compile("\\bOsConstants\\.([A-Za-z0-9_]+)"), method = Pattern.compile("\\bOs\\.([A-Za-z0-9_]+)\\s*\\(");
        Path root = Path.of("apps/web/android/app/src/main/java/com/operalibre/mobile");
        for (String name : new String[]{"GiftImportPlugin", "GiftRecoveryStore", "GiftStagingStore", "GiftArchiveExtractor", "GiftDocumentLifecycle"}) {
            String source = Files.readString(root.resolve(name + ".java"));
            Matcher match = constant.matcher(source);
            while (match.find()) if (!constants.contains(match.group(1))) throw new AssertionError(name + ": unaudited or unavailable OsConstants." + match.group(1));
            match = method.matcher(source);
            while (match.find()) if (!methods.contains(match.group(1))) throw new AssertionError(name + ": unaudited Os." + match.group(1));
        }
        System.out.println("GiftAndroidPublicApi tests passed");
    }
}
