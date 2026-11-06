package com.operalibre.mobile;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import org.json.JSONObject;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.channels.FileLock;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

/** Bearer state stays beside private staging (app backup is disabled in the
 * manifest). Never log contents or propagate exception details to the bridge.
 * This record lock does not cover Filesystem.appendFile or transfer leases. */
final class GiftRecoveryStore {
    private static final int MAX_STATE = 16 * 1024;
    private static final long MAX_ARCHIVE = 25L * 1024 * 1024 * 1024;
    private static final long MAX_INTEGER = 9007199254740991L;
    private interface Operation<T> { T run(File parent) throws Exception; }

    // The monitor spans plugin instances; the persistent file lock spans
    // processes. Both load and CAS participate, including first-time seeding.
    private static synchronized <T> T locked(File data, String id, Operation<T> operation) throws Exception {
        if (id == null || !id.matches("[A-Za-z0-9_-]{16,128}")) throw new IOException();
        File parent = new File(data.getCanonicalFile(), "gift-incoming");
        if (!parent.isDirectory() || !parent.getCanonicalFile().equals(parent.getAbsoluteFile())) throw new IOException();
        FileDescriptor fd = Os.open(new File(parent, ".recovery-" + id + ".lock").getPath(),
            OsConstants.O_RDWR | OsConstants.O_CREAT | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, 0600);
        try (FileOutputStream stream = new FileOutputStream(fd)) {
            regular(fd, MAX_STATE);
            Os.fchmod(fd, 0600);
            try (FileLock ignored = stream.getChannel().lock()) { return operation.run(parent); }
        }
    }

    static String load(File data, String id) throws Exception {
        return locked(data, id, parent -> {
            String state = read(parent, id);
            JSONObject record = state == null ? null : validate(id, state);
            checkArchive(parent, id, record == null ? MAX_ARCHIVE : integer(record.getJSONObject("archive"), "size", 1, MAX_ARCHIVE));
            return state;
        });
    }

    /** null is an absent previous record, never an unconditional overwrite. */
    static boolean compareAndSwap(File data, String id, String previous, String next) throws Exception {
        return locked(data, id, parent -> {
            JSONObject after = validate(id, next);
            JSONObject before = previous == null ? null : validate(id, previous);
            if (before != null && !sameScope(before, after)) throw new IOException();
            checkArchive(parent, id, integer(after.getJSONObject("archive"), "size", 1, MAX_ARCHIVE));
            String stored = read(parent, id);
            JSONObject current = stored == null ? null : validate(id, stored);
            if (before == null ? current != null : current == null || !equal(before, current)) return false;
            write(parent, id, next.getBytes(StandardCharsets.UTF_8));
            return true;
        });
    }

    private static StructStat regular(FileDescriptor fd, long limit) throws Exception {
        StructStat stat = Os.fstat(fd);
        if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_nlink != 1 || stat.st_size < 0 || stat.st_size > limit) throw new IOException();
        return stat;
    }

    private static void checkArchive(File parent, String id, long limit) throws Exception {
        FileDescriptor fd = Os.open(new File(parent, id + ".zip").getPath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, 0);
        try (FileInputStream ignored = new FileInputStream(fd)) { regular(fd, limit); }
    }

    private static String read(File parent, String id) throws Exception {
        FileDescriptor fd;
        try { fd = Os.open(new File(parent, ".recovery-" + id + ".json").getPath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, 0); }
        catch (ErrnoException error) { if (error.errno == OsConstants.ENOENT) return null; throw error; }
        try (FileInputStream input = new FileInputStream(fd)) {
            int size = (int) regular(fd, MAX_STATE).st_size;
            byte[] bytes = new byte[size]; int offset = 0;
            while (offset < size) { int read = input.read(bytes, offset, size - offset); if (read <= 0) throw new IOException(); offset += read; }
            if (input.read() != -1) throw new IOException();
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        }
    }

    private static void write(File parent, String id, byte[] bytes) throws Exception {
        File temporary = new File(parent, ".recovery-" + id + ".tmp");
        File destination = new File(parent, ".recovery-" + id + ".json");
        // A crash may leave the fixed temporary file. Validate before truncating
        // it; never follow a symlink or truncate a hard-linked file.
        FileDescriptor fd = Os.open(temporary.getPath(), OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, 0600);
        try (FileOutputStream output = new FileOutputStream(fd)) {
            regular(fd, MAX_STATE); Os.fchmod(fd, 0600); Os.ftruncate(fd, 0);
            output.write(bytes); output.flush(); Os.fsync(fd);
        }
        Os.rename(temporary.getPath(), destination.getPath());
        FileDescriptor directory = Os.open(parent.getPath(), OsConstants.O_RDONLY | OsConstants.O_DIRECTORY | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, 0);
        try { Os.fsync(directory); } finally { Os.close(directory); }
        // An error after rename has an uncertain outcome. Reject; the next
        // attempt must load and reconcile, never assume the write failed.
    }

    private static void keys(JSONObject value, String[] required, String... optional) throws Exception {
        Set<String> allowed = new HashSet<>(Arrays.asList(required)); allowed.addAll(Arrays.asList(optional));
        for (String key : required) if (!value.has(key)) throw new IOException();
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) if (!allowed.contains(keys.next())) throw new IOException();
    }

    private static String string(JSONObject value, String key, String pattern, int maximum) throws Exception {
        Object raw = value.get(key);
        if (!(raw instanceof String) || ((String) raw).length() > maximum || (pattern != null && !((String) raw).matches(pattern))) throw new IOException();
        return (String) raw;
    }

    private static long integer(JSONObject value, String key, long minimum, long maximum) throws Exception {
        Object raw = value.get(key);
        if (!(raw instanceof Number)) throw new IOException();
        double number = ((Number) raw).doubleValue();
        if (!Double.isFinite(number) || number < minimum || number > maximum || number != Math.floor(number)) throw new IOException();
        return ((Number) raw).longValue();
    }

    private static JSONObject claim(JSONObject capability, JSONObject archive) throws Exception {
        keys(capability, new String[]{"payload", "signature"});
        String payload = string(capability, "payload", null, 4096);
        if (payload.getBytes(StandardCharsets.UTF_8).length > 4096) throw new IOException();
        string(capability, "signature", "[a-f0-9]{64}", 64);
        JSONObject claim = new JSONObject(payload);
        keys(claim, new String[]{"room", "role", "nonce", "expiresAt"}, "previousNonce");
        if (!"recipient".equals(claim.get("role")) || !archive.get("room").equals(claim.get("room"))
            || integer(claim, "expiresAt", 1, MAX_INTEGER) != integer(archive, "expiresAt", 1, MAX_INTEGER)) throw new IOException();
        String nonce = string(claim, "nonce", "[A-Za-z0-9_-]{16,128}", 128);
        if (claim.has("previousNonce") && nonce.equals(string(claim, "previousNonce", "[A-Za-z0-9_-]{16,128}", 128))) throw new IOException();
        return claim;
    }

    private static JSONObject validate(String id, String state) throws Exception {
        if (state == null || state.length() > MAX_STATE || state.getBytes(StandardCharsets.UTF_8).length > MAX_STATE) throw new IOException();
        JSONObject record = new JSONObject(state);
        keys(record, new String[]{"version", "broker", "token", "signingKey", "archive", "current"}, "pending");
        integer(record, "version", 1, 1);
        URI broker = new URI(string(record, "broker", null, 512));
        if (!"https".equals(broker.getScheme()) || broker.getHost() == null || broker.getRawUserInfo() != null
            || (broker.getRawPath() != null && !broker.getRawPath().isEmpty()) || broker.getRawQuery() != null || broker.getRawFragment() != null
            || broker.getPort() < -1 || broker.getPort() > 65535) throw new IOException();
        string(record, "token", "[A-Za-z0-9_-]{32,4096}", 4096);
        string(record, "signingKey", "[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]", 43);
        JSONObject archive = record.getJSONObject("archive");
        keys(archive, new String[]{"giftId", "room", "size", "sha256", "expiresAt"});
        if (!id.equals(archive.get("giftId"))) throw new IOException();
        string(archive, "room", "[A-Za-z0-9_-]{16,128}", 128);
        string(archive, "sha256", "[a-f0-9]{64}", 64);
        integer(archive, "size", 1, MAX_ARCHIVE); integer(archive, "expiresAt", 1, MAX_INTEGER);
        JSONObject current = claim(record.getJSONObject("current"), archive);
        if (record.has("pending")) {
            JSONObject pending = record.getJSONObject("pending");
            keys(pending, new String[]{"successor", "generation"}); integer(pending, "generation", 0, MAX_INTEGER - 1);
            JSONObject successor = claim(pending.getJSONObject("successor"), archive);
            if (!current.get("nonce").equals(successor.opt("previousNonce")) || current.get("nonce").equals(successor.get("nonce"))) throw new IOException();
        }
        return record;
    }

    private static boolean sameScope(JSONObject left, JSONObject right) throws Exception {
        for (String key : new String[]{"version", "broker", "token", "signingKey", "archive"}) if (!equal(left.get(key), right.get(key))) return false;
        return true;
    }

    private static boolean equal(Object left, Object right) throws Exception {
        if (left instanceof JSONObject && right instanceof JSONObject) {
            JSONObject a = (JSONObject) left, b = (JSONObject) right;
            if (a.length() != b.length()) return false;
            Iterator<String> keys = a.keys();
            while (keys.hasNext()) { String key = keys.next(); if (!b.has(key) || !equal(a.get(key), b.get(key))) return false; }
            return true;
        }
        if (left instanceof Number && right instanceof Number) return ((Number) left).doubleValue() == ((Number) right).doubleValue();
        return left.equals(right);
    }
}
