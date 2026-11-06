package com.operalibre.mobile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.io.FileInputStream;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.FileDescriptor;

/** Disabled until the transfer, manifest trust and library recovery are reviewed. */
@CapacitorPlugin(name = "GiftImport")
public final class GiftImportPlugin extends Plugin {
    private static final boolean ENABLED = false;
    private final ExecutorService queue = Executors.newSingleThreadExecutor();

    @PluginMethod public void loadRecoveryState(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        queue.execute(() -> {
            try {
                String state = GiftRecoveryStore.load(getContext().getFilesDir(), call.getString("giftId"));
                JSObject result = new JSObject(); result.put("state", state == null ? JSONObject.NULL : state); call.resolve(result);
            } catch (Exception error) { call.reject("Gift recovery storage unavailable."); }
        });
    }

    @PluginMethod public void compareAndSwapRecoveryState(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        queue.execute(() -> {
            try {
                if (!call.getData().has("previous") || (!call.getData().isNull("previous") && call.getString("previous") == null)) throw new IllegalArgumentException();
                boolean swapped = GiftRecoveryStore.compareAndSwap(getContext().getFilesDir(), call.getString("giftId"), call.getString("previous"), call.getString("next"));
                JSObject result = new JSObject(); result.put("swapped", swapped); call.resolve(result);
            } catch (Exception error) { call.reject("Gift recovery storage unavailable."); }
        });
    }

    @PluginMethod public void extract(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        queue.execute(() -> {
            try {
                String id = call.getString("giftId");
                JSArray list = call.getArray("assets");
                if (id == null || !id.matches("[A-Za-z0-9_-]{16,128}") || list == null || list.length() == 0 || list.length() > 256) throw new IllegalArgumentException("Invalid gift.");
                List<GiftArchiveExtractor.Asset> assets = new ArrayList<>();
                for (int i = 0; i < list.length(); i++) {
                    JSONObject item = list.getJSONObject(i);
                    assets.add(new GiftArchiveExtractor.Asset(item.getString("name"), item.getLong("size"), item.getString("sha256")));
                }
                File data = getContext().getFilesDir().getCanonicalFile();
                File incoming = new File(data, "gift-incoming").getCanonicalFile();
                File archive = new File(incoming, id + ".zip").getCanonicalFile();
                if (!incoming.getPath().equals(new File(data, "gift-incoming").getAbsolutePath()) || !archive.getParentFile().equals(incoming)) throw new IllegalArgumentException("Gift archive is unavailable.");
                File root = new File(data, "device-library");
                if (!root.isDirectory() && !root.mkdirs()) throw new IllegalStateException("Gift library is unavailable.");
                if (!root.getCanonicalFile().getPath().equals(root.getAbsolutePath())) throw new IllegalArgumentException("Invalid gift library location.");
                File result = GiftArchiveExtractor.extract(archive, root, id, assets);
                JSObject output = new JSObject();
                output.put("directory", "device-library/" + result.getName());
                call.resolve(output);
            } catch (Exception error) { call.reject("Gift import could not be completed."); }
        });
    }

    @PluginMethod public void verifyArchive(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        queue.execute(() -> {
            try {
                String id = call.getString("giftId"), expected = call.getString("sha256");
                Long size = call.getLong("size");
                if (id == null || !id.matches("[A-Za-z0-9_-]{16,128}") || expected == null || !expected.matches("[a-f0-9]{64}") || size == null || size < 0 || size > 25L * 1024 * 1024 * 1024) throw new IllegalArgumentException();
                File data = getContext().getFilesDir().getCanonicalFile();
                File parent = new File(data, "gift-incoming");
                File archive = new File(parent, id + ".zip");
                if (!parent.getCanonicalFile().equals(parent.getAbsoluteFile()) || !archive.getCanonicalFile().equals(archive.getAbsoluteFile()) || !archive.isFile() || archive.length() != size) throw new IllegalArgumentException();
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (FileInputStream input = new FileInputStream(archive)) {
                    byte[] buffer = new byte[64 * 1024]; int count; long read = 0;
                    while ((count = input.read(buffer)) != -1) { read += count; if (read > size) throw new IllegalArgumentException(); digest.update(buffer, 0, count); }
                    if (read != size) throw new IllegalArgumentException();
                }
                StringBuilder actual = new StringBuilder();
                for (byte value : digest.digest()) actual.append(String.format(Locale.ROOT, "%02x", value & 255));
                if (!MessageDigest.isEqual(actual.toString().getBytes(StandardCharsets.US_ASCII), expected.getBytes(StandardCharsets.US_ASCII))) throw new IllegalArgumentException();
                call.resolve();
            } catch (Exception error) { call.reject("Gift archive integrity check failed."); }
        });
    }

    @PluginMethod public void prepareArchive(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        queue.execute(() -> {
            try {
                String id = call.getString("giftId");
                if (id == null || !id.matches("[A-Za-z0-9_-]{16,128}")) throw new IllegalArgumentException();
                File data = getContext().getFilesDir().getCanonicalFile();
                File parent = new File(data, "gift-incoming");
                if (!parent.isDirectory() && !parent.mkdirs()) throw new IllegalStateException();
                if (!parent.getCanonicalFile().equals(parent.getAbsoluteFile())) throw new IllegalArgumentException();
                File archive = new File(parent, id + ".zip");
                if (!archive.createNewFile()) throw new IllegalStateException();
                call.resolve();
            } catch (Exception error) { call.reject("Gift staging could not be created."); }
        });
    }

    /** Inspect a private partial file without trusting an externally supplied
     * offset. It is not used for resume until the session protocol is wired. */
    @PluginMethod public void inspectArchive(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        queue.execute(() -> {
            try {
                String id = call.getString("giftId");
                Long limit = call.getLong("maximumSize");
                if (id == null || !id.matches("[A-Za-z0-9_-]{16,128}") || limit == null || limit < 0 || limit > 25L * 1024 * 1024 * 1024) throw new IllegalArgumentException();
                File data = getContext().getFilesDir().getCanonicalFile();
                File parent = new File(data, "gift-incoming");
                if (!parent.getCanonicalFile().equals(parent.getAbsoluteFile())) throw new IllegalArgumentException();
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                FileDescriptor fd = Os.open(new File(parent, id + ".zip").getPath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, 0);
                long count = 0;
                try (FileInputStream input = new FileInputStream(fd)) {
                    StructStat stat = Os.fstat(fd);
                    if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_size < 0 || stat.st_size > limit) throw new IllegalArgumentException();
                    byte[] buffer = new byte[64 * 1024]; int read;
                    while ((read = input.read(buffer)) != -1) { count += read; if (count > stat.st_size) throw new IllegalArgumentException(); digest.update(buffer, 0, read); }
                    if (count != stat.st_size) throw new IllegalArgumentException();
                }
                StringBuilder actual = new StringBuilder();
                for (byte value : digest.digest()) actual.append(String.format(Locale.ROOT, "%02x", value & 255));
                JSObject output = new JSObject(); output.put("offset", count); output.put("prefixSha256", actual.toString()); call.resolve(output);
            } catch (Exception error) { call.reject("Gift staging could not be inspected."); }
        });
    }
}
