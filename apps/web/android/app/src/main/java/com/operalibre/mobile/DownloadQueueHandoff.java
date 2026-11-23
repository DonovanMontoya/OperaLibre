package com.operalibre.mobile;

import androidx.work.ExistingWorkPolicy;

/**
 * Drains the download queue in one unique worker and hands off to a successor when a job lands after
 * the worker's final empty read. WorkManager's KEEP policy still sees that worker as running and
 * drops a new request, so the worker retires under the store lock and the next enqueue appends a
 * successor instead.
 */
final class DownloadQueueHandoff {
    interface Scheduler {
        /** Enqueues the unique worker and returns only after WorkManager accepts the request. */
        void enqueue(ExistingWorkPolicy policy) throws Exception;
    }

    interface Queue<J, R> {
        J nextPending();

        /** Runs one book. Null continues with the next book; anything else ends this worker. */
        R run(J job);

        boolean isStopped();

        void awaitMore() throws InterruptedException;
    }

    private final Object lock;
    private boolean retired;

    DownloadQueueHandoff(Object lock) {
        this.lock = lock;
    }

    <J, R> R drain(Queue<J, R> queue, R finished, R stopped) {
        synchronized (lock) {
            retired = false;
        }
        boolean settled = false;
        while (true) {
            if (queue.isStopped()) return stopped;
            J pending;
            synchronized (lock) {
                pending = queue.nextPending();
                if (pending == null && settled) {
                    retired = true;
                    return finished;
                }
            }
            if (pending == null) {
                settled = true;
                try {
                    queue.awaitMore();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return stopped;
                }
                continue;
            }
            settled = false;
            R outcome = queue.run(pending);
            if (outcome != null) return outcome;
        }
    }

    /**
     * Call while holding the lock after persisting a job. A retired worker needs an appended
     * successor; the handoff stays pending until WorkManager accepts it, so a rejected request is
     * retried by the next enqueue.
     */
    void schedule(Scheduler scheduler) throws Exception {
        synchronized (lock) {
            boolean successor = retired;
            scheduler.enqueue(successor ? ExistingWorkPolicy.APPEND_OR_REPLACE : ExistingWorkPolicy.KEEP);
            if (successor) retired = false;
        }
    }
}
