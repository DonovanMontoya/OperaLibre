package com.operalibre.mobile;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

final class BackgroundDownloadStore {
    private static final String PREFERENCES = "operalibre-background-downloads";
    private static final String PREFIX = "job.";

    private BackgroundDownloadStore() {}

    static synchronized JSONObject load(Context context, String jobId) throws JSONException {
        String value = preferences(context).getString(PREFIX + jobId, null);
        if (value == null) return null;
        return new JSONObject(value);
    }

    static synchronized void save(Context context, String jobId, JSONObject job) {
        preferences(context).edit().putString(PREFIX + jobId, job.toString()).apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
