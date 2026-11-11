package com.operalibre.mobile;

import java.util.concurrent.Executor;
import java.util.function.Consumer;

/** Called in Capacitor dispatch order. The native queue drains the abandoned
 * document before releasing its leases and admitting the next document. */
final class GiftDocumentLifecycle {
    interface Operation { void run(Object owner); }
    private final Executor queue;
    private final Consumer<Object> release;
    private Object owner = new Object();
    private boolean closed;
    GiftDocumentLifecycle(Executor queue, Consumer<Object> release) { this.queue = queue; this.release = release; }
    synchronized void submit(Operation operation) {
        if (closed) throw new IllegalStateException("Gift document is closed.");
        Object current = owner;
        queue.execute(() -> operation.run(current));
    }
    synchronized void reset() {
        if (closed) return;
        Object abandoned = owner; owner = new Object();
        queue.execute(() -> release.accept(abandoned));
    }
    synchronized void close() {
        if (closed) return;
        closed = true;
        Object abandoned = owner;
        queue.execute(() -> release.accept(abandoned));
    }
}
