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
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
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

/**
 * Drains the offline download queue one book at a time.
 *
 * A single worker owns the whole queue rather than one worker per book chained
 * behind the last: in a chain, cancelling or permanently failing one book also
 * cancels every book queued after it.
 */
public class OfflineDownloadWorker extends Worker {
    private static final String CHANNEL_ID = "offline-downloads";
    private static final int NOTIFICATION_ID = 0x0F71;
    private static final int MAX_ATTEMPTS = 5;
    private final NotificationManager notificationManager;

    /** Raised when a book is cancelled while the worker is transferring it. */
    private static final class DownloadCancelledException extends Exception {}

    public OfflineDownloadWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
        notificationManager = (NotificationManager) context.getSystemService(Service.NOTIFICATION_SERVICE);
    }

    @NonNull
    @Override
    public Result doWork() {
        boolean settled = false;
        while (true) {
            if (isStopped()) return Result.retry();
            BackgroundDownloadStore.PendingJob pending =
                BackgroundDownloadStore.nextPending(getApplicationContext());
            if (pending == null) {
                // A book queued while this worker is finishing finds the unique
                // work still running and is skipped by KEEP, so look once more
                // before ending. The store is written before the work request.
                if (settled) return Result.success();
                settled = true;
                try {
                    Thread.sleep(1_000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return Result.retry();
                }
                continue;
            }
            settled = false;
            Result outcome = runJob(pending.jobId, pending.job);
            if (outcome != null) return outcome;
        }
    }

    /** @return null to move on to the next book, or a result that ends the worker. */
    @Nullable
    private Result runJob(String jobId, JSONObject job) {
        File partial = null;
        JSONArray files = job.optJSONArray("files");
        try {
            if (files == null) throw new IllegalStateException("The download is missing its file list.");
            job.put("state", "running");
            job.remove("error");
            if (!BackgroundDownloadStore.saveIfPresent(getApplicationContext(), jobId, job)) {
                throw new DownloadCancelledException();
            }
            setForegroundAsync(
                foregroundInfo(job.optString("title", "Audiobook"), job.optDouble("fraction", 0.0))
            ).get();

            int completedFiles = job.optInt("completedFiles", 0);
            int completedRequired = job.optInt("completedRequired", 0);
            int requiredTotal = Math.max(1, job.optInt("requiredTotal", files.length()));

            for (int index = completedFiles; index < files.length(); index++) {
                if (isStopped()) return requeueForLater(jobId, job);
                if (!BackgroundDownloadStore.contains(getApplicationContext(), jobId)) {
                    throw new DownloadCancelledException();
                }
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
                } catch (DownloadCancelledException cancelled) {
                    throw cancelled;
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
                if (!BackgroundDownloadStore.saveIfPresent(getApplicationContext(), jobId, job)) {
                    throw new DownloadCancelledException();
                }
                updateNotification(job.optString("title", "Audiobook"), fraction);
            }

            job.remove("files");
            job.put("state", "completed").put("fraction", 1.0);
            if (!BackgroundDownloadStore.saveIfPresent(getApplicationContext(), jobId, job)) {
                throw new DownloadCancelledException();
            }
            return null;
        } catch (DownloadCancelledException cancelled) {
            // The entry is already gone; clear whatever reached the disk before
            // the worker noticed, including a file it just finished renaming.
            if (partial != null && partial.exists()) partial.delete();
            try {
                deleteDownloadFiles(getApplicationContext(), files);
            } catch (Exception ignored) {
                // Best effort: a leftover file is reported as not downloaded.
            }
            return null;
        } catch (Exception error) {
            if (partial != null && partial.exists()) partial.delete();
            return recordFailure(jobId, job, error);
        }
    }

    /** Hands an unfinished book back to the queue when the worker is stopped. */
    @Nullable
    private Result requeueForLater(String jobId, JSONObject job) {
        try {
            job.put("state", "queued");
            BackgroundDownloadStore.saveIfPresent(getApplicationContext(), jobId, job);
        } catch (Exception ignored) {
            // The stored state already says running, which is also resumable.
        }
        return Result.retry();
    }

    @Nullable
    private Result recordFailure(String jobId, JSONObject job, Exception error) {
        try {
            int attempts = job.optInt("attempts", 0) + 1;
            boolean retry = attempts < MAX_ATTEMPTS && !isStopped();
            job.put("attempts", attempts)
                .put("state", retry ? "queued" : "failed")
                .put("error", retry ? "Waiting to retry the download." : safeMessage(error));
            if (!BackgroundDownloadStore.saveIfPresent(getApplicationContext(), jobId, job)) {
                return null;
            }
            // Retrying re-runs this worker after WorkManager's backoff. A book
            // that is out of attempts is left failed and the queue moves on.
            if (retry) return Result.retry();
        } catch (Exception unwritable) {
            // The failure could not be recorded, so drop the job outright: a
            // book left in a pending state would be retried forever.
            BackgroundDownloadStore.remove(getApplicationContext(), jobId);
        }
        return null;
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
                        // A missing entry means the book was cancelled while this
                        // transfer ran; stop instead of writing the job back.
                        if (!BackgroundDownloadStore.saveIfPresent(getApplicationContext(), jobId, job)) {
                            throw new DownloadCancelledException();
                        }
                        updateNotification(job.optString("title", "Audiobook"), fraction);
                        lastUpdate = now;
                    }
                }
            }
        } finally {
            connection.disconnect();
        }
    }

    static void deleteDownloadFiles(Context context, JSONObject job) throws Exception {
        deleteDownloadFiles(context, job.optJSONArray("files"));
    }

    private static void deleteDownloadFiles(Context context, @Nullable JSONArray files) throws Exception {
        if (files == null) return;
        for (int index = 0; index < files.length(); index++) {
            File destination = validatedDestination(context, files.getJSONObject(index).getString("path"));
            if (destination.exists()) destination.delete();
            File partial = new File(destination.getPath() + ".part");
            if (partial.exists()) partial.delete();
        }
    }

    private File validatedDestination(String value) throws Exception {
        return validatedDestination(getApplicationContext(), value);
    }

    private static File validatedDestination(Context context, String value) throws Exception {
        Uri uri = Uri.parse(value);
        File file = "file".equals(uri.getScheme()) ? new File(new URI(value)) : new File(value);
        String destination = file.getCanonicalPath();
        String dataRoot = context.getFilesDir().getCanonicalPath() + File.separator;
        String cacheRoot = context.getCacheDir().getCanonicalPath() + File.separator;
        if (!destination.startsWith(dataRoot) && !destination.startsWith(cacheRoot)) {
            throw new SecurityException("The download destination is outside app storage.");
        }
        return file;
    }

    private ForegroundInfo foregroundInfo(String title, double fraction) {
        createNotificationChannel();
        Intent launchIntent = getApplicationContext().getPackageManager().getLaunchIntentForPackage(getApplicationContext().getPackageName());
        PendingIntent openApp = launchIntent == null ? null : PendingIntent.getActivity(
            getApplicationContext(),
            NOTIFICATION_ID,
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
        return new ForegroundInfo(NOTIFICATION_ID, notification, serviceType);
    }

    private void updateNotification(String title, double fraction) {
        ForegroundInfo info = foregroundInfo(title, fraction);
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
