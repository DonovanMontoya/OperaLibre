package com.operalibre.mobile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import android.webkit.WebView;
import android.webkit.RenderProcessGoneDetail;

/** Disabled until the transfer, manifest trust and library recovery are reviewed. */
@CapacitorPlugin(name = "GiftImport")
public final class GiftImportPlugin extends Plugin {
    private static final boolean ENABLED = false;
    private final ExecutorService queue = Executors.newSingleThreadExecutor();
    private final GiftDocumentLifecycle documents = new GiftDocumentLifecycle(queue, GiftStagingStore::releaseOwner);
    private final WebViewListener documentListener = new WebViewListener() {
        @Override public void onPageStarted(WebView view) { getBridge().execute(documents::reset); }
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            getBridge().execute(documents::reset);
            return false; // The host retains responsibility for renderer recovery.
        }
    };

    @Override public void load() { getBridge().addWebViewListener(documentListener); }

    private void enqueue(PluginCall call, GiftDocumentLifecycle.Operation operation) {
        try { documents.submit(operation); }
        catch (IllegalStateException error) { call.reject("Gift document is closed."); }
    }

    private static long integer(PluginCall call, String name) throws Exception {
        Object raw = call.getData().get(name);
        if (!(raw instanceof Number)) throw new IllegalArgumentException();
        double value = ((Number) raw).doubleValue();
        if (!Double.isFinite(value) || value < 0 || value > 25L * 1024 * 1024 * 1024 || value != Math.floor(value)) throw new IllegalArgumentException();
        return ((Number) raw).longValue();
    }

    @PluginMethod public void acquireArchive(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        enqueue(call, owner -> {
            try {
                Object create = call.getData().get("create");
                if (!(create instanceof Boolean)) throw new IllegalArgumentException();
                GiftStagingStore.Acquired acquired = GiftStagingStore.acquire(getContext().getFilesDir(), owner, call.getString("giftId"), (Boolean) create, integer(call, "maximumSize"));
                JSObject result = new JSObject(); result.put("lease", acquired.lease); result.put("offset", acquired.offset); result.put("prefixSha256", acquired.prefixSha256); call.resolve(result);
            } catch (Exception error) { call.reject("Gift staging lease unavailable."); }
        });
    }

    @PluginMethod public void appendArchive(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        enqueue(call, owner -> {
            try {
                long offset = GiftStagingStore.append(getContext().getFilesDir(), owner, call.getString("giftId"), call.getString("lease"), integer(call, "offset"), call.getString("data"));
                JSObject result = new JSObject(); result.put("offset", offset); call.resolve(result);
            } catch (Exception error) { call.reject("Gift staging append failed."); }
        });
    }

    @PluginMethod public void verifyArchive(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        enqueue(call, owner -> {
            try {
                GiftStagingStore.verify(getContext().getFilesDir(), owner, call.getString("giftId"), call.getString("lease"), integer(call, "size"), call.getString("sha256")); call.resolve();
            } catch (Exception error) { call.reject("Gift archive integrity check failed."); }
        });
    }

    @PluginMethod public void releaseArchive(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        enqueue(call, owner -> {
            try { GiftStagingStore.release(getContext().getFilesDir(), owner, call.getString("giftId"), call.getString("lease")); call.resolve(); }
            catch (Exception error) { call.reject("Gift staging release failed."); }
        });
    }

    @PluginMethod public void cleanupArchive(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        enqueue(call, owner -> {
            try { GiftStagingStore.cleanup(getContext().getFilesDir(), call.getString("giftId")); call.resolve(); }
            catch (Exception error) { call.reject("Gift staging cleanup unavailable."); }
        });
    }

    @Override protected void handleOnDestroy() {
        getBridge().removeWebViewListener(documentListener);
        documents.close(); queue.shutdown();
        super.handleOnDestroy();
    }

    @PluginMethod public void loadRecoveryState(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        enqueue(call, owner -> {
            try {
                String state = GiftRecoveryStore.load(getContext().getFilesDir(), call.getString("giftId"));
                JSObject result = new JSObject(); result.put("state", state == null ? JSONObject.NULL : state); call.resolve(result);
            } catch (Exception error) { call.reject("Gift recovery storage unavailable."); }
        });
    }

    @PluginMethod public void compareAndSwapRecoveryState(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        enqueue(call, owner -> {
            try {
                if (!call.getData().has("previous") || (!call.getData().isNull("previous") && call.getString("previous") == null)) throw new IllegalArgumentException();
                boolean swapped = GiftRecoveryStore.compareAndSwap(getContext().getFilesDir(), call.getString("giftId"), call.getString("previous"), call.getString("next"));
                JSObject result = new JSObject(); result.put("swapped", swapped); call.resolve(result);
            } catch (Exception error) { call.reject("Gift recovery storage unavailable."); }
        });
    }

    @PluginMethod public void extract(PluginCall call) {
        if (!ENABLED) { call.reject("Gift import is not enabled."); return; }
        enqueue(call, owner -> {
            try {
                String id = call.getString("giftId");
                JSArray list = call.getArray("assets");
                if (id == null || !id.matches("[A-Za-z0-9_-]{16,128}") || list == null || list.length() == 0 || list.length() > 256) throw new IllegalArgumentException();
                List<GiftArchiveExtractor.Asset> assets = new ArrayList<>();
                for (int i = 0; i < list.length(); i++) {
                    JSONObject item = list.getJSONObject(i);
                    assets.add(new GiftArchiveExtractor.Asset(item.getString("name"), item.getLong("size"), item.getString("sha256")));
                }
                File data = getContext().getFilesDir().getCanonicalFile();
                File result = GiftStagingStore.withInactive(data, id, incoming -> {
                    File archive = new File(incoming, id + ".zip");
                    if (!archive.getCanonicalFile().equals(archive.getAbsoluteFile())) throw new IllegalArgumentException();
                    File root = new File(data, "device-library");
                    if (!root.isDirectory() && !root.mkdirs()) throw new IllegalStateException();
                    if (!root.getCanonicalFile().equals(root.getAbsoluteFile())) throw new IllegalArgumentException();
                    File committed = GiftArchiveExtractor.extract(archive, root, id, assets);
                    GiftStagingStore.syncCommitted(committed);
                    GiftRecoveryStore.cleanup(data, id);
                    return committed;
                });
                JSObject output = new JSObject(); output.put("directory", "device-library/" + result.getName()); call.resolve(output);
            } catch (Exception error) { call.reject("Gift import could not be completed."); }
        });
    }
}
