package com.operalibre.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.Data;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.Locale;

public class OfflineDownloadWorker extends Worker {
    private static final String INPUT_JOB_ID = "jobId";
    private static final String CHANNEL_ID = "offline-downloads";
    private static final int MAX_ATTEMPTS = 5;
    private final NotificationManager notificationManager;

    public OfflineDownloadWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
        notificationManager = (NotificationManager) context.getSystemService(Service.NOTIFICATION_SERVICE);
    }

    static Data inputFor(String jobId) {
        return new Data.Builder().putString(INPUT_JOB_ID, jobId).build();
    }

    static String tagFor(String jobId) {
        return "offline-download-" + jobId;
    }

    @NonNull
    @Override
    public Result doWork() {
        String jobId = getInputData().getString(INPUT_JOB_ID);
        if (jobId == null) return Result.failure();

        File partial = null;
        try {
            JSONObject job = BackgroundDownloadStore.load(getApplicationContext(), jobId);
            if (job == null) return Result.failure();
            job.put("state", "running");
            job.remove("error");
            BackgroundDownloadStore.save(getApplicationContext(), jobId, job);
            setForegroundAsync(foregroundInfo(jobId, job.optString("title", "Audiobook"), job.optDouble("fraction", 0.0))).get();

            JSONArray files = job.getJSONArray("files");
            int completedFiles = job.optInt("completedFiles", 0);
            int completedRequired = job.optInt("completedRequired", 0);
            int requiredTotal = Math.max(1, job.optInt("requiredTotal", files.length()));

            for (int index = completedFiles; index < files.length(); index++) {
                if (isStopped()) return Result.retry();
                JSONObject item = files.getJSONObject(index);
                boolean required = item.optBoolean("required", true);
                File destination = validatedDestination(item.getString("path"));
                File parent = destination.getParentFile();
                if (parent == null || (!parent.exists() && !parent.mkdirs())) {
                    throw new IllegalStateException("Could not create the download folder.");
                }
                partial = new File(destination.getPath() + ".part");
                try {
                    download(jobId, job, item.getString("url"), partial, completedRequired, requiredTotal);
                    if (destination.exists() && !destination.delete()) {
                        throw new IllegalStateException("Could not replace an earlier download.");
                    }
                    if (!partial.renameTo(destination)) {
                        throw new IllegalStateException("Could not finish writing the downloaded file.");
                    }
                    partial = null;
                } catch (Exception error) {
                    if (required) throw error;
                    if (partial.exists()) partial.delete();
                    partial = null;
                }
                completedFiles++;
                if (required) completedRequired++;
                double fraction = Math.min(1.0, (double) completedRequired / requiredTotal);
                job.put("completedFiles", completedFiles)
                    .put("completedRequired", completedRequired)
                    .put("fraction", fraction);
                BackgroundDownloadStore.save(getApplicationContext(), jobId, job);
                updateNotification(jobId, job.optString("title", "Audiobook"), fraction);
            }

            job.remove("files");
            job.put("state", "completed").put("fraction", 1.0);
            BackgroundDownloadStore.save(getApplicationContext(), jobId, job);
            return Result.success();
        } catch (Exception error) {
            if (partial != null && partial.exists()) partial.delete();
            try {
                JSONObject job = BackgroundDownloadStore.load(getApplicationContext(), jobId);
                if (job != null) {
                    boolean retry = getRunAttemptCount() + 1 < MAX_ATTEMPTS && !isStopped();
                    job.put("state", retry ? "queued" : "failed")
                        .put("error", retry ? "Waiting to retry the download." : safeMessage(error));
                    BackgroundDownloadStore.save(getApplicationContext(), jobId, job);
                    if (retry) return Result.retry();
                }
            } catch (Exception ignored) {
                // The original error is the useful one.
            }
            return Result.failure();
        }
    }

    private void download(
        String jobId,
        JSONObject job,
        String source,
        File destination,
        int completedRequired,
        int requiredTotal
    ) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(source).openConnection();
        connection.setConnectTimeout(60_000);
        connection.setReadTimeout(600_000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("Accept-Encoding", "identity");
        try {
            int response = connection.getResponseCode();
            if (response < 200 || response >= 300) throw new IllegalStateException("The server returned HTTP " + response + ".");
            long expected = connection.getContentLengthLong();
            long received = 0;
            long lastUpdate = 0;
            byte[] buffer = new byte[64 * 1024];
            try (
                BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
                BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(destination, false))
            ) {
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (isStopped()) throw new InterruptedException("Download stopped.");
                    output.write(buffer, 0, count);
                    received += count;
                    long now = System.currentTimeMillis();
                    if (now - lastUpdate >= 500) {
                        double current = expected > 0 ? Math.min(1.0, (double) received / expected) : 0.0;
                        double fraction = Math.min(0.999, (completedRequired + current) / requiredTotal);
                        job.put("fraction", fraction);
                        BackgroundDownloadStore.save(getApplicationContext(), jobId, job);
                        updateNotification(jobId, job.optString("title", "Audiobook"), fraction);
                        lastUpdate = now;
                    }
                }
            }
        } finally {
            connection.disconnect();
        }
    }

    private File validatedDestination(String value) throws Exception {
        Uri uri = Uri.parse(value);
        File file = "file".equals(uri.getScheme()) ? new File(new URI(value)) : new File(value);
        String destination = file.getCanonicalPath();
        String dataRoot = getApplicationContext().getFilesDir().getCanonicalPath() + File.separator;
        String cacheRoot = getApplicationContext().getCacheDir().getCanonicalPath() + File.separator;
        if (!destination.startsWith(dataRoot) && !destination.startsWith(cacheRoot)) {
            throw new SecurityException("The download destination is outside app storage.");
        }
        return file;
    }

    private ForegroundInfo foregroundInfo(String jobId, String title, double fraction) {
        createNotificationChannel();
        Intent launchIntent = getApplicationContext().getPackageManager().getLaunchIntentForPackage(getApplicationContext().getPackageName());
        PendingIntent openApp = launchIntent == null ? null : PendingIntent.getActivity(
            getApplicationContext(),
            jobId.hashCode(),
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        int percent = (int) Math.round(fraction * 100);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getApplicationContext(), CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Downloading " + title)
            .setContentText(String.format(Locale.US, "%d%% available offline", percent))
            .setProgress(100, percent, false)
            .setOnlyAlertOnce(true)
            .setOngoing(true);
        if (openApp != null) builder.setContentIntent(openApp);
        Notification notification = builder.build();
        int serviceType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0;
        int notificationId = Math.max(1, jobId.hashCode() & 0x7fffffff);
        return new ForegroundInfo(notificationId, notification, serviceType);
    }

    private void updateNotification(String jobId, String title, double fraction) {
        ForegroundInfo info = foregroundInfo(jobId, title, fraction);
        notificationManager.notify(info.getNotificationId(), info.getNotification());
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Offline audiobook downloads",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Progress for audiobooks being saved for offline listening");
        notificationManager.createNotificationChannel(channel);
    }

    private String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? "The background download failed." : message;
    }
}
