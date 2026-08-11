package com.operalibre.mobile;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Map;

final class BackgroundDownloadStore {
    private static final String PREFERENCES = "operalibre-background-downloads";
    private static final String PREFIX = "job.";

    /** A stored job together with the id it is filed under. */
    static final class PendingJob {
        final String jobId;
        final JSONObject job;

        PendingJob(String jobId, JSONObject job) {
            this.jobId = jobId;
            this.job = job;
        }
    }

    private BackgroundDownloadStore() {}

    static synchronized JSONObject load(Context context, String jobId) throws JSONException {
        String value = preferences(context).getString(PREFIX + jobId, null);
        if (value == null) return null;
        return new JSONObject(value);
    }

    static synchronized void save(Context context, String jobId, JSONObject job) {
        preferences(context).edit().putString(PREFIX + jobId, job.toString()).apply();
    }

    /**
     * Writes only while the job still exists. Cancellation deletes the entry, so
     * an unconditional write from a worker that has not noticed yet would
     * resurrect the job and let a later relaunch restart it.
     *
     * @return false when the job was cancelled and nothing was written.
     */
    static synchronized boolean saveIfPresent(Context context, String jobId, JSONObject job) {
        SharedPreferences preferences = preferences(context);
        if (!preferences.contains(PREFIX + jobId)) return false;
        preferences.edit().putString(PREFIX + jobId, job.toString()).apply();
        return true;
    }

    static synchronized boolean contains(Context context, String jobId) {
        return preferences(context).contains(PREFIX + jobId);
    }

    static synchronized void remove(Context context, String jobId) {
        preferences(context).edit().remove(PREFIX + jobId).apply();
    }

    /**
     * The oldest job still waiting to transfer. Jobs left in {@code running} by a
     * killed process are picked up again so their download resumes.
     */
    static synchronized PendingJob nextPending(Context context) {
        PendingJob oldest = null;
        long oldestQueuedAt = Long.MAX_VALUE;
        for (Map.Entry<String, ?> entry : preferences(context).getAll().entrySet()) {
            if (!entry.getKey().startsWith(PREFIX) || !(entry.getValue() instanceof String)) continue;
            JSONObject job;
            try {
                job = new JSONObject((String) entry.getValue());
            } catch (JSONException malformed) {
                continue;
            }
            String state = job.optString("state", "");
            if (!"queued".equals(state) && !"running".equals(state)) continue;
            long queuedAt = job.optLong("queuedAt", 0);
            String jobId = entry.getKey().substring(PREFIX.length());
            if (oldest == null
                || queuedAt < oldestQueuedAt
                || (queuedAt == oldestQueuedAt && jobId.compareTo(oldest.jobId) < 0)) {
                oldest = new PendingJob(jobId, job);
                oldestQueuedAt = queuedAt;
            }
        }
        return oldest;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
