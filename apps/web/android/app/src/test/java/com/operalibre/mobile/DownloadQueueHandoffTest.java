package com.operalibre.mobile;

import org.junit.Test;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.*;

public class DownloadQueueHandoffTest {
    private final Object storeLock = new Object();
    private final DownloadQueueHandoff handoff = new DownloadQueueHandoff(storeLock);
    private final Deque<String> store = new ArrayDeque<>();
    private final Set<String> failing = new HashSet<>();
    private final List<String> ran = new ArrayList<>();
    private final UniqueWork work = new UniqueWork();
    private Runnable onIdle = () -> {};
    private Runnable afterReturn = () -> {};
    private boolean stopAfterRun;

    /** WorkManager unique work: KEEP drops a request while earlier work is unfinished; append queues it. */
    private static final class UniqueWork {
        boolean unfinished;
        int successors;
        int dropped;
        int workersRun;

        void enqueue(boolean append) {
            if (!unfinished) unfinished = true;
            else if (append) successors++;
            else dropped++;
        }
    }

    private void enqueueBook(String jobId) {
        synchronized (storeLock) {
            store.add(jobId);
            work.enqueue(handoff.takeSuccessorRequest());
        }
    }

    private final DownloadQueueHandoff.Queue<String, String> queue = new DownloadQueueHandoff.Queue<String, String>() {
        @Override public String nextPending() {
            return store.peekFirst();
        }

        @Override public String run(String jobId) {
            store.remove(jobId);
            ran.add(failing.contains(jobId) ? jobId + ":failed" : jobId);
            return null;
        }

        @Override public boolean isStopped() {
            return stopAfterRun && !ran.isEmpty();
        }

        @Override public void awaitMore() {
            Runnable hook = onIdle;
            onIdle = () -> {};
            hook.run();
        }
    };

    /** Runs scheduled workers until WorkManager has nothing unfinished. Returning and finishing are separate steps. */
    private String runWorkers() {
        String last = null;
        while (work.unfinished) {
            work.workersRun++;
            last = handoff.drain(queue, "success", "retry");
            Runnable hook = afterReturn;
            afterReturn = () -> {};
            hook.run();
            if (work.successors > 0) work.successors--;
            else work.unfinished = false;
        }
        return last;
    }

    @Test public void bookQueuedAfterFinalEmptyReadRunsInSuccessor() {
        enqueueBook("first");
        afterReturn = () -> enqueueBook("second");
        assertEquals("success", runWorkers());
        assertEquals(Arrays.asList("first", "second"), ran);
        assertEquals(0, work.dropped);
        assertEquals(2, work.workersRun);
    }

    @Test public void bookQueuedWhileWorkerSettlesRunsInSameWorker() {
        enqueueBook("first");
        onIdle = () -> enqueueBook("second");
        runWorkers();
        assertEquals(Arrays.asList("first", "second"), ran);
        assertEquals(1, work.workersRun);
        assertEquals(1, work.dropped);
    }

    @Test public void failedOrCancelledBookLeavesLaterBooksRunning() {
        failing.add("first");
        enqueueBook("first");
        enqueueBook("second");
        enqueueBook("third");
        runWorkers();
        assertEquals(Arrays.asList("first:failed", "second", "third"), ran);
        assertEquals(1, work.workersRun);
    }

    @Test public void stoppedWorkerKeepsItsRescheduledWork() {
        stopAfterRun = true;
        enqueueBook("first");
        enqueueBook("second");
        assertEquals("retry", handoff.drain(queue, "success", "retry"));
        assertFalse(handoff.takeSuccessorRequest());
        assertEquals(Arrays.asList("first"), ran);
        assertEquals(Arrays.asList("second"), new ArrayList<>(store));
    }
}
