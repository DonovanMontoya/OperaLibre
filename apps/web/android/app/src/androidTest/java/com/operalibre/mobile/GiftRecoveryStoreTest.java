package com.operalibre.mobile;

import android.content.Context;
import android.system.Os;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.ArrayList;
import java.util.List;
import static org.junit.Assert.*;

/** Run on Android: these tests exercise real no-follow opens, flock and fsync,
 * not a host imitation of android.system.Os. Production gates stay disabled. */
@RunWith(AndroidJUnit4.class)
public final class GiftRecoveryStoreTest {
    private static final String ID = "gift____________";
    private File root, incoming;

    @Before public void setup() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        root = new File(context.getCacheDir(), "gift-recovery-test-" + UUID.randomUUID());
        incoming = new File(root, "gift-incoming"); assertTrue(incoming.mkdirs());
        put(new File(incoming, ID + ".zip"), "prefix");
    }

    @After public void teardown() throws Exception {
        // The root is a fresh test-owned child, never an app data directory.
        File[] files = incoming.listFiles();
        if (files != null) for (File file : files) assertTrue(file.delete());
        assertTrue(incoming.delete()); assertTrue(root.delete());
    }

    private static String repeat(char value, int count) { char[] chars = new char[count]; Arrays.fill(chars, value); return new String(chars); }
    private static void put(File file, String value) throws Exception {
        try (FileOutputStream stream = new FileOutputStream(file)) { stream.write(value.getBytes(StandardCharsets.UTF_8)); }
    }
    private static JSONObject claim(String nonce, String previous) throws Exception {
        JSONObject claim = new JSONObject().put("room", "room____________").put("role", "recipient").put("nonce", nonce).put("expiresAt", 2000000000L);
        if (previous != null) claim.put("previousNonce", previous);
        return new JSONObject().put("payload", claim.toString()).put("signature", repeat('a', 64));
    }
    private static JSONObject state() throws Exception {
        return new JSONObject().put("version", 1).put("broker", "https://broker.example").put("token", repeat('t', 32)).put("signingKey", repeat('A', 43))
            .put("archive", new JSONObject().put("giftId", ID).put("room", "room____________").put("size", 10).put("sha256", repeat('b', 64)).put("expiresAt", 2000000000L))
            .put("current", claim("current_________", null));
    }
    private static String pending(String nonce) throws Exception {
        return state().put("pending", new JSONObject().put("generation", 0).put("successor", claim(nonce, "current_________"))).toString();
    }

    @Test public void diskReloadAndInterruptedTemporaryWrite() throws Exception {
        String original = state().toString(), next = pending("successor_______");
        assertNull(GiftRecoveryStore.load(root, ID));
        assertTrue(GiftRecoveryStore.compareAndSwap(root, ID, null, original));
        assertFalse(GiftRecoveryStore.compareAndSwap(root, ID, null, next));
        put(new File(incoming, ".recovery-" + ID + ".tmp"), "interrupted temporary record");
        assertEquals(original, GiftRecoveryStore.load(root, ID));
        assertTrue(GiftRecoveryStore.compareAndSwap(root, ID, original, next));
        assertEquals(next, GiftRecoveryStore.load(root, ID));
        assertFalse(new File(incoming, ".recovery-" + ID + ".tmp").exists());
    }

    @Test public void simultaneousWritersHaveOneWinner() throws Exception {
        String original = state().toString();
        assertTrue(GiftRecoveryStore.compareAndSwap(root, ID, null, original));
        ExecutorService threads = Executors.newFixedThreadPool(4);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Boolean>> results = new ArrayList<>();
        try {
            for (int i = 0; i < 4; i++) {
                final String next = pending("successor______" + i);
                results.add(threads.submit(() -> { start.await(); return GiftRecoveryStore.compareAndSwap(root, ID, original, next); }));
            }
            start.countDown(); int winners = 0;
            for (Future<Boolean> result : results) if (result.get()) winners++;
            assertEquals(1, winners);
            assertTrue(new JSONObject(GiftRecoveryStore.load(root, ID)).has("pending"));
        } finally { threads.shutdownNow(); }
    }

    @Test public void corruptStateIsNotOverwrittenBySeeding() throws Exception {
        File file = new File(incoming, ".recovery-" + ID + ".json"); put(file, "{");
        try { GiftRecoveryStore.load(root, ID); fail("corrupt record loaded"); } catch (Exception expected) { }
        try { GiftRecoveryStore.compareAndSwap(root, ID, null, state().toString()); fail("corrupt record overwritten"); } catch (Exception expected) { }
        assertEquals(1, file.length());
    }

    @Test public void symlinkedTemporaryFileCannotModifyArchiveOrState() throws Exception {
        String original = state().toString();
        assertTrue(GiftRecoveryStore.compareAndSwap(root, ID, null, original));
        File archive = new File(incoming, ID + ".zip");
        Os.symlink(archive.getPath(), new File(incoming, ".recovery-" + ID + ".tmp").getPath());
        try { GiftRecoveryStore.compareAndSwap(root, ID, original, pending("successor_______")); fail("symlink followed"); } catch (Exception expected) { }
        assertEquals(6, archive.length()); assertEquals(original, GiftRecoveryStore.load(root, ID));
    }

    @Test public void pathAndGiftScopeValidationNeverCreateState() throws Exception {
        try { GiftRecoveryStore.load(root, "../" + ID); fail("path accepted"); } catch (Exception expected) { }
        JSONObject wrong = state(); wrong.getJSONObject("archive").put("giftId", "another_gift____");
        try { GiftRecoveryStore.compareAndSwap(root, ID, null, wrong.toString()); fail("identity accepted"); } catch (Exception expected) { }
        JSONObject oversized = state(); oversized.put("token", repeat('t', 20000));
        try { GiftRecoveryStore.compareAndSwap(root, ID, null, oversized.toString()); fail("oversize accepted"); } catch (Exception expected) { }
        assertNull(GiftRecoveryStore.load(root, ID));
    }

    @Test public void symlinkedStateAndArchiveAreRejected() throws Exception {
        File archive = new File(incoming, ID + ".zip");
        File state = new File(incoming, ".recovery-" + ID + ".json");
        Os.symlink(archive.getPath(), state.getPath());
        try { GiftRecoveryStore.load(root, ID); fail("state symlink accepted"); } catch (Exception expected) { }
        assertTrue(state.delete());
        File other = new File(incoming, "other.zip"); put(other, "other prefix");
        assertTrue(archive.delete()); Os.symlink(other.getPath(), archive.getPath());
        try { GiftRecoveryStore.compareAndSwap(root, ID, null, state().toString()); fail("archive symlink accepted"); } catch (Exception expected) { }
        assertFalse(state.exists());
    }

    @Test public void pendingScopeCannotChangeAndFailedWritesPreserveOldRecord() throws Exception {
        String original = state().toString();
        assertTrue(GiftRecoveryStore.compareAndSwap(root, ID, null, original));
        JSONObject changed = state().put("broker", "https://another.example");
        try { GiftRecoveryStore.compareAndSwap(root, ID, original, changed.toString()); fail("scope changed"); } catch (Exception expected) { }
        assertEquals(original, GiftRecoveryStore.load(root, ID));
        Os.link(new File(incoming, ID + ".zip").getPath(), new File(incoming, ".recovery-" + ID + ".tmp").getPath());
        try { GiftRecoveryStore.compareAndSwap(root, ID, original, pending("successor_______")); fail("hard link truncated"); } catch (Exception expected) { }
        assertEquals(6, new File(incoming, ID + ".zip").length());
        // The staged archive itself now has two links, so load must reject it.
        assertTrue(new File(incoming, ".recovery-" + ID + ".tmp").delete());
        assertEquals(original, GiftRecoveryStore.load(root, ID));
    }

    @Test public void absentStateNeedsNoArchiveAndIndependentSecretIsImmutable() throws Exception {
        File archive = new File(incoming, ID + ".zip"); assertTrue(archive.delete());
        assertNull(GiftRecoveryStore.load(root, ID));
        put(archive, "prefix");
        String original = state().put("recoverySecret", repeat('A', 43)).toString();
        assertTrue(GiftRecoveryStore.compareAndSwap(root, ID, null, original));
        assertEquals(original, GiftRecoveryStore.load(root, ID));
        for (String value : new String[]{repeat('B', 42) + "A", repeat('A', 42) + "B"}) {
            try { GiftRecoveryStore.compareAndSwap(root, ID, original, state().put("recoverySecret", value).toString()); fail("secret changed or noncanonical secret accepted"); } catch (Exception expected) { }
        }
        try { GiftRecoveryStore.compareAndSwap(root, ID, original, state().toString()); fail("secret removed"); } catch (Exception expected) { }
        assertEquals(original, GiftRecoveryStore.load(root, ID));
    }
}
