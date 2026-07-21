package com.operalibre.mobile;

import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "BackgroundDownloads")
public class BackgroundDownloadPlugin extends Plugin {
    private static final String DOWNLOAD_QUEUE = "offline-download-queue";

    @PluginMethod
    public void enqueueBook(PluginCall call) {
        String jobId = call.getString("jobId");
        String title = call.getString("title");
        JSArray files = call.getArray("files");
        if (jobId == null || title == null || files == null || files.length() == 0) {
            call.reject("A job ID, title, and at least one file are required.");
            return;
        }

        try {
            JSONObject existing = BackgroundDownloadStore.load(getContext(), jobId);
            if (existing != null) {
                String state = existing.optString("state", "");
                if ("queued".equals(state) || "running".equals(state)) {
                    call.resolve();
                    return;
                }
            }
            int requiredTotal = 0;
            for (int index = 0; index < files.length(); index++) {
                if (files.getJSONObject(index).optBoolean("required", true)) requiredTotal++;
            }
            JSONObject job = new JSONObject()
                .put("title", title)
                .put("state", "queued")
                .put("files", files)
                .put("completedFiles", 0)
                .put("completedRequired", 0)
                .put("requiredTotal", requiredTotal)
                .put("fraction", 0.0);
            BackgroundDownloadStore.save(getContext(), jobId, job);

            Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(OfflineDownloadWorker.class)
                .setInputData(OfflineDownloadWorker.inputFor(jobId))
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .addTag(OfflineDownloadWorker.tagFor(jobId))
                .build();
            WorkManager.getInstance(getContext()).enqueueUniqueWork(
                DOWNLOAD_QUEUE,
                ExistingWorkPolicy.APPEND_OR_REPLACE,
                request
            );
            call.resolve();
        } catch (JSONException error) {
            call.reject("The background download could not be prepared.", error);
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        String jobId = call.getString("jobId");
        if (jobId == null) {
            call.reject("A job ID is required.");
            return;
        }
        try {
            JSONObject job = BackgroundDownloadStore.load(getContext(), jobId);
            if (job == null) {
                call.reject("The background download was not found.");
                return;
            }
            JSObject result = new JSObject();
            result.put("state", job.optString("state", "queued"));
            result.put("fraction", job.optDouble("fraction", 0.0));
            if (job.has("error")) result.put("error", job.optString("error"));
            call.resolve(result);
        } catch (JSONException error) {
            call.reject("The background download status could not be read.", error);
        }
    }
}
