package com.operalibre.mobile;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.Executor;

/** Deterministic host proof of dispatch ordering, without sleeps or Android OS
 * mocks. Android/device tests remain required for actual WebView callbacks. */
public final class GiftDocumentLifecycleTest {
    private static final class ManualQueue implements Executor {
        final Queue<Runnable> pending = new ArrayDeque<>();
        public void execute(Runnable action) { pending.add(action); }
        void drain() { while (!pending.isEmpty()) pending.remove().run(); }
    }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    public static void main(String[] args) {
        ManualQueue bridge = new ManualQueue(), nativeQueue = new ManualQueue();
        List<String> order = new ArrayList<>();
        List<Object> owners = new ArrayList<>(), released = new ArrayList<>();
        GiftDocumentLifecycle lifecycle = new GiftDocumentLifecycle(nativeQueue, owner -> { released.add(owner); order.add("release"); });
        bridge.execute(() -> lifecycle.submit(owner -> { owners.add(owner); order.add("old-write"); }));
        bridge.execute(lifecycle::reset);
        bridge.execute(() -> lifecycle.submit(owner -> { owners.add(owner); order.add("new-acquire"); }));
        bridge.drain();
        check(order.isEmpty(), "bridge reset must not release an in-flight native owner");
        nativeQueue.drain();
        check(order.equals(List.of("old-write", "release", "new-acquire")), "write/reset/acquire order");
        check(owners.get(0) == released.get(0), "reset releases the abandoned owner");
        check(owners.get(0) != owners.get(1), "new document must get a distinct owner");
        lifecycle.submit(owner -> order.add("pending-write"));
        lifecycle.close(); lifecycle.close(); lifecycle.reset();
        try { lifecycle.submit(owner -> { throw new AssertionError("closed write"); }); throw new AssertionError("closed document accepted work"); }
        catch (IllegalStateException expected) { }
        nativeQueue.drain();
        check(order.equals(List.of("old-write", "release", "new-acquire", "pending-write", "release")), "close waits for pending writes and releases only once");
        check(released.get(1) == owners.get(1), "close releases current owner");
        System.out.println("GiftDocumentLifecycle tests passed");
    }
}
