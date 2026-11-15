package com.operalibre.mobile;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.util.Base64;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;

/** All GiftImport byte operations share a native lease, not a WebView mutex.
 * Tokens and recovery records are bearer secrets; never log them. */
final class GiftStagingStore {
    private static final long MAX_ARCHIVE = 25L * 1024 * 1024 * 1024;
    private static final int MAX_CHUNK = 64 * 1024;
    private static final Map<String, Session> leases = new HashMap<>();
    private static final SecureRandom random = new SecureRandom();
    interface Operation<T> { T run(File parent) throws Exception; }
    static final class Acquired {
        final String lease, prefixSha256; final long offset;
        Acquired(String lease, long offset, String hash) { this.lease = lease; this.offset = offset; this.prefixSha256 = hash; }
    }
    private static final class Guard implements AutoCloseable {
        final File parent; final StructStat identity; final FileOutputStream stream; final FileLock lock;
        Guard(File parent, StructStat identity, FileOutputStream stream, FileLock lock) { this.parent = parent; this.identity = identity; this.stream = stream; this.lock = lock; }
        @Override public void close() throws Exception { try { lock.release(); } finally { stream.close(); } }
    }
    private static final class Session implements AutoCloseable {
        final Object owner; final String id; final Guard guard; final FileDescriptor archive; final long maximum;
        long offset; boolean failed, verified;
        Session(Object owner, String id, Guard guard, FileDescriptor archive, long maximum, long offset) {
            this.owner = owner; this.id = id; this.guard = guard; this.archive = archive; this.maximum = maximum; this.offset = offset;
        }
        @Override public void close() throws Exception { try { Os.close(archive); } finally { guard.close(); } }
    }

    private static StructStat regular(FileDescriptor fd, long maximum) throws Exception {
        StructStat stat = Os.fstat(fd);
        if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_nlink != 1 || stat.st_size < 0 || stat.st_size > maximum) throw new IOException();
        return stat;
    }

    /** Called only under the gift's inactive staging guard after extraction.
     * Return no bytes until this bounded regular file matches its receipt. */
    static String readMetadata(File directory, GiftArchiveExtractor.Asset asset) throws Exception {
        final int maximum = 256 * 1024;
        if (asset == null || asset.size < 1 || asset.size > maximum || asset.name == null
            || !asset.name.matches("[^/\\\\\\p{Cntrl}]{1,255}") || asset.name.equals(".") || asset.name.equals("..")
            || asset.sha256 == null || !asset.sha256.matches("[a-f0-9]{64}")
            || !directory.getCanonicalFile().equals(directory.getAbsoluteFile())) throw new IOException();
        StructStat parent = Os.lstat(directory.getPath());
        if (!OsConstants.S_ISDIR(parent.st_mode)) throw new IOException();
        File file = new File(directory, asset.name);
        FileDescriptor fd = GiftRecoveryStore.open(file.getPath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_NONBLOCK, 0);
        try {
            StructStat before = regular(fd, maximum), path = Os.lstat(file.getPath());
            if (before.st_size != asset.size || before.st_dev != path.st_dev || before.st_ino != path.st_ino) throw new IOException();
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream((int) asset.size);
            byte[] buffer = new byte[16 * 1024];
            for (;;) {
                int count = Os.read(fd, buffer, 0, Math.min(buffer.length, (int) asset.size - bytes.size() + 1));
                if (count == 0) break;
                if (count > asset.size - bytes.size()) throw new IOException();
                bytes.write(buffer, 0, count);
            }
            StructStat after = regular(fd, maximum), current = Os.lstat(directory.getPath()), finalPath = Os.lstat(file.getPath());
            if (bytes.size() != asset.size || after.st_size != before.st_size
                || current.st_dev != parent.st_dev || current.st_ino != parent.st_ino || !OsConstants.S_ISDIR(current.st_mode)
                || finalPath.st_dev != before.st_dev || finalPath.st_ino != before.st_ino
                || !directory.getCanonicalFile().equals(directory.getAbsoluteFile())) throw new IOException();
            byte[] content = bytes.toByteArray();
            StringBuilder digest = new StringBuilder(64);
            for (byte b : MessageDigest.getInstance("SHA-256").digest(content)) digest.append(String.format(Locale.ROOT, "%02x", b & 255));
            if (!digest.toString().equals(asset.sha256)) throw new IOException();
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(content)).toString();
        } finally { Os.close(fd); }
    }
    private static Guard guard(File data, String id) throws Exception {
        if (id == null || !id.matches("[A-Za-z0-9_-]{16,128}")) throw new IOException();
        File parent = new File(data.getCanonicalFile(), "gift-incoming");
        // POSIX record locks can be dropped when any descriptor for the same
        // inode is closed. Reject same-process contention before opening a
        // second descriptor, not just after FileChannel.tryLock fails.
        for (Session session : leases.values()) if (session.id.equals(id) && session.guard.parent.equals(parent)) throw new IOException();
        if (!parent.getCanonicalFile().equals(parent.getAbsoluteFile())) throw new IOException();
        if (!parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) throw new IOException();
        StructStat directory = Os.lstat(parent.getPath());
        if (!OsConstants.S_ISDIR(directory.st_mode) || !parent.getCanonicalFile().equals(parent.getAbsoluteFile())) throw new IOException();
        FileDescriptor fd = GiftRecoveryStore.open(new File(parent, ".staging-" + id + ".lock").getPath(), OsConstants.O_RDWR | OsConstants.O_CREAT | OsConstants.O_NOFOLLOW, 0600);
        FileOutputStream stream = new FileOutputStream(fd);
        try {
            regular(fd, 0); Os.fchmod(fd, 0600);
            FileLock held = stream.getChannel().tryLock();
            if (held == null) throw new IOException();
            return new Guard(parent, directory, stream, held);
        } catch (Exception error) { stream.close(); throw error; }
    }

    static synchronized Acquired acquire(File data, Object owner, String id, boolean create, long maximum) throws Exception {
        if (maximum < 0 || maximum > MAX_ARCHIVE || leases.size() >= 16) throw new IOException();
        Guard held = guard(data, id); FileDescriptor fd = null;
        try {
            if (create && !GiftRecoveryStore.freshAllowed(data, id)) throw new IOException();
            String path = new File(held.parent, id + ".zip").getPath();
            if (create) {
                try { fd = GiftRecoveryStore.open(path, OsConstants.O_RDWR | OsConstants.O_CREAT | OsConstants.O_EXCL | OsConstants.O_NOFOLLOW, 0600); }
                catch (ErrnoException error) { if (error.errno != OsConstants.EEXIST) throw error; }
            }
            if (fd == null) fd = GiftRecoveryStore.open(path, OsConstants.O_RDWR | OsConstants.O_NOFOLLOW, 0);
            StructStat stat = regular(fd, maximum); Os.fchmod(fd, 0600);
            // A fresh orphan is reusable only when empty and there is no
            // committed or ambiguous recovery record. Never truncate it.
            if (create && (stat.st_size != 0 || !GiftRecoveryStore.freshAllowed(data, id))) throw new IOException();
            Session session = new Session(owner, id, held, fd, maximum, stat.st_size);
            String hash = digest(session);
            byte[] secret = new byte[32]; random.nextBytes(secret);
            String token = Base64.encodeToString(secret, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            while (leases.containsKey(token)) { random.nextBytes(secret); token = Base64.encodeToString(secret, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP); }
            leases.put(token, session);
            return new Acquired(token, stat.st_size, hash);
        } catch (Exception error) {
            try { if (fd != null) Os.close(fd); } finally { held.close(); }
            throw error;
        }
    }

    private static Session owned(File data, Object owner, String id, String token) throws Exception {
        if (token == null || !token.matches("[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]")) throw new IOException();
        Session session = leases.get(token);
        if (session == null || session.owner != owner || !session.id.equals(id)
            || !session.guard.parent.equals(new File(data.getCanonicalFile(), "gift-incoming"))) throw new IOException();
        return session;
    }
    private static void unchanged(Session session) throws Exception {
        StructStat directory = Os.lstat(session.guard.parent.getPath());
        if (!OsConstants.S_ISDIR(directory.st_mode) || directory.st_dev != session.guard.identity.st_dev || directory.st_ino != session.guard.identity.st_ino
            || !session.guard.parent.getCanonicalFile().equals(session.guard.parent.getAbsoluteFile())) throw new IOException();
        StructStat actual = regular(session.archive, session.maximum), path = Os.lstat(new File(session.guard.parent, session.id + ".zip").getPath());
        if (!OsConstants.S_ISREG(path.st_mode) || path.st_nlink != 1 || path.st_dev != actual.st_dev || path.st_ino != actual.st_ino || actual.st_size != session.offset) throw new IOException();
    }
    private static String digest(Session session) throws Exception {
        unchanged(session); Os.lseek(session.archive, 0, OsConstants.SEEK_SET);
        MessageDigest digest = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[MAX_CHUNK]; long count = 0; int read;
        while ((read = Os.read(session.archive, buffer, 0, buffer.length)) != 0) {
            count += read; if (count > session.offset) throw new IOException(); digest.update(buffer, 0, read);
        }
        if (count != session.offset) throw new IOException(); unchanged(session);
        StringBuilder hash = new StringBuilder();
        for (byte value : digest.digest()) hash.append(String.format(Locale.ROOT, "%02x", value & 255));
        return hash.toString();
    }

    static synchronized long append(File data, Object owner, String id, String token, long offset, String encoded) throws Exception {
        Session session = owned(data, owner, id, token);
        if (session.failed || session.verified || offset != session.offset || encoded == null || encoded.isEmpty() || encoded.length() > 87384) throw new IOException();
        byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
        if (bytes.length == 0 || bytes.length > MAX_CHUNK || !Base64.encodeToString(bytes, Base64.NO_WRAP).equals(encoded) || offset > session.maximum - bytes.length) throw new IOException();
        try {
            unchanged(session); Os.lseek(session.archive, offset, OsConstants.SEEK_SET); int written = 0;
            while (written < bytes.length) { int count = Os.write(session.archive, bytes, written, bytes.length - written); if (count <= 0) throw new IOException(); written += count; }
            Os.fsync(session.archive); session.offset += bytes.length; unchanged(session); return session.offset;
        } catch (Exception error) { session.failed = true; throw error; }
    }

    static synchronized void verify(File data, Object owner, String id, String token, long size, String sha256) throws Exception {
        Session session = owned(data, owner, id, token);
        if (session.failed || session.verified || size != session.offset || sha256 == null || !sha256.matches("[a-f0-9]{64}")) throw new IOException();
        try {
            Os.fsync(session.archive);
            if (!MessageDigest.isEqual(digest(session).getBytes(StandardCharsets.US_ASCII), sha256.getBytes(StandardCharsets.US_ASCII))) throw new IOException();
            session.verified = true;
        } catch (Exception error) { session.failed = true; throw error; }
    }

    static synchronized void release(File data, Object owner, String id, String token) throws Exception {
        Session session = owned(data, owner, id, token); leases.remove(token); session.close();
    }
    static synchronized void releaseOwner(Object owner) {
        Iterator<Session> entries = leases.values().iterator();
        while (entries.hasNext()) { Session session = entries.next(); if (session.owner == owner) { entries.remove(); try { session.close(); } catch (Exception ignored) { } } }
    }
    static synchronized <T> T withInactive(File data, String id, Operation<T> operation) throws Exception {
        try (Guard held = guard(data, id)) { return operation.run(held.parent); }
    }
    static synchronized void cleanup(File data, String id) throws Exception {
        withInactive(data, id, parent -> { GiftRecoveryStore.cleanup(data, id); return null; });
    }
    static void syncCommitted(File directory) throws Exception {
        for (File file : new File[]{directory, directory.getParentFile(), directory.getParentFile().getParentFile()}) {
            GiftRecoveryStore.syncDirectory(file);
        }
    }
}
