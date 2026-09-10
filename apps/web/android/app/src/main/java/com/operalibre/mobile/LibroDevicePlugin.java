package com.operalibre.mobile;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.zip.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;

/** Fixed provider API only; passwords are transient and tokens never reach JS. */
@CapacitorPlugin(name = "LibroDevice")
public class LibroDevicePlugin extends Plugin {
    private static final String KEY = "operalibre-libro-device";
    private static final long LIMIT = 25L * 1024 * 1024 * 1024;
    private final ExecutorService queue = Executors.newSingleThreadExecutor();

    @PluginMethod public void request(PluginCall call) {
        queue.execute(() -> {
            try { call.resolve(JSObject.fromJSONObject(perform(call))); }
            catch (Exception error) {
                call.reject(error instanceof ProviderError ? error.getMessage() : "The device operation could not finish. Check storage and retry.");
            }
        });
    }

    private static class ProviderError extends Exception { ProviderError(String message) { super(message); } }

    private File credentialFile() { return new File(getContext().getNoBackupFilesDir(), "libro-connection"); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(KEY)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(KEY, null);
    }
    private JSONObject connection() throws Exception {
        File file = credentialFile();
        if (!file.exists()) return null;
        JSONObject envelope;
        try (InputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > 65536) throw new ProviderError("The stored connection is invalid. Disconnect and reconnect.");
                output.write(buffer, 0, count);
            }
            envelope = new JSONObject(output.toString("UTF-8"));
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)));
        return new JSONObject(new String(cipher.doFinal(Base64.decode(envelope.getString("data"), Base64.NO_WRAP)), StandardCharsets.UTF_8));
    }
    private void save(JSONObject value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        JSONObject envelope = new JSONObject().put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .put("data", Base64.encodeToString(cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
        File temp = new File(getContext().getNoBackupFilesDir(), "libro-connection.tmp");
        try (FileOutputStream output = new FileOutputStream(temp)) { output.write(envelope.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync(); }
        // POSIX rename is atomic and available on API 21+, unlike java.nio.file (26+).
        android.system.Os.rename(temp.getAbsolutePath(), credentialFile().getAbsolutePath());
    }
    private JSONObject api(String path, String token, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("https://libro.fm/" + path).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(25000); connection.setReadTimeout(30000);
            connection.setRequestProperty("X-LibroFm-AppVer", "7.34.8");
            connection.setRequestProperty("User-Agent", "okhttp/5.3.2");
            connection.setRequestProperty("Accept", "application/json");
            if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                try (OutputStream output = connection.getOutputStream()) { output.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            }
            int status = connection.getResponseCode();
            if (status == 404 && path.contains("packaged_m4b")) return new JSONObject().put("unavailable", true);
            if (status < 200 || status >= 300) throw new ProviderError(status == 401 || status == 403
                ? "Libro.fm could not authorize this request. Reconnect the device account."
                : "Libro.fm returned HTTP " + status + ". Try again later.");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 8 * 1024 * 1024) throw new ProviderError("Libro.fm returned too much data.");
                    output.write(buffer, 0, count);
                }
                return new JSONObject(output.toString("UTF-8"));
            }
        } finally { connection.disconnect(); }
    }
    private JSONObject perform(PluginCall call) throws Exception {
        String action = call.getString("action", "");
        if (action.equals("status")) {
            JSONObject account = connection();
            return new JSONObject().put("connected", account != null).put("email", account == null ? "" : account.getString("email"));
        }
        if (action.equals("disconnect")) {
            if (credentialFile().exists() && !credentialFile().delete()) throw new ProviderError("Could not remove the connection.");
            return new JSONObject();
        }
        if (action.equals("connect")) {
            String email = call.getString("email", "").trim(), password = call.getString("password", "");
            if (email.isEmpty() || email.length() > 320 || password.isEmpty() || password.length() > 1024) throw new ProviderError("Enter your Libro.fm email and password.");
            JSONObject value = api("oauth/token", null, new JSONObject().put("grant_type", "password").put("username", email).put("password", password));
            String token = value.optString("access_token", "");
            if (token.isEmpty() || token.length() >= 16384) throw new ProviderError("Libro.fm did not provide a token.");
            save(new JSONObject().put("email", email).put("token", token));
            return new JSONObject().put("connected", true).put("email", email);
        }
        if (action.equals("extract")) return extract(call.getString("folder", ""));
        JSONObject account = connection();
        if (account == null) throw new ProviderError("Connect the device account first.");
        String token = account.getString("token");
        if (action.equals("page")) {
            int page = call.getInt("page", 0);
            if (page < 1 || page > 200) throw new ProviderError("Invalid library page.");
            return api("api/v10/library?page=" + page, token, null);
        }
        String isbn = call.getString("isbn", "");
        if (!isbn.matches("[0-9X]{10,13}")) throw new ProviderError("Invalid book identifier.");
        if (action.equals("m4b")) return api("api/v10/audiobooks/" + isbn + "/packaged_m4b", token, null);
        if (action.equals("manifest")) return api("api/v10/download-manifest?isbn=" + isbn, token, null);
        throw new ProviderError("Unsupported device operation.");
    }

    static boolean allowedDownload(URL url) {
        String host = url.getHost().toLowerCase(Locale.ROOT);
        return "https".equals(url.getProtocol()) && url.getUserInfo() == null && (url.getPort() == -1 || url.getPort() == 443)
            && (host.equals("libro.fm") || host.endsWith(".libro.fm") || host.endsWith(".amazonaws.com") || host.endsWith(".cloudfront.net"));
    }

    private JSONObject extract(String folder) throws Exception {
        if (!folder.matches("libro-[a-f0-9-]{36}")) throw new ProviderError("Invalid download folder.");
        File root = new File(getContext().getFilesDir(), "offline-media").getCanonicalFile();
        File directory = new File(root, folder).getCanonicalFile();
        if (!directory.getPath().startsWith(root.getPath() + File.separator)) throw new ProviderError("Invalid download folder.");
        File output = new File(directory, "extracted");
        if (output.exists()) clearExtraction(output);
        if (!output.mkdirs()) throw new ProviderError("Could not create the extraction folder.");
        JSONArray files = new JSONArray(); Set<String> names = new HashSet<>();
        long total = 0; int entries = 0;
        try {
            File[] sources = directory.listFiles();
            if (sources == null) throw new ProviderError("Downloaded files are missing.");
            Arrays.sort(sources, Comparator.comparing(File::getName));
            for (File source : sources) {
                if (source.getName().endsWith(".m4b")) {
                    files.put(new JSONObject().put("name", source.getName()).put("path", source.toURI().toString())); continue;
                }
                if (!source.getName().endsWith(".zip")) continue;
                try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(new FileInputStream(source)))) {
                    ZipEntry entry; byte[] buffer = new byte[65536];
                    while ((entry = zip.getNextEntry()) != null) {
                        String path = entry.getName(); entries++;
                        if (entries > 10000 || path.startsWith("/") || path.contains("\\") || Arrays.asList(path.split("/")).contains("..")) throw new ProviderError("Unsafe or oversized archive.");
                        // ZipInputStream materializes regular files only, never archive symlinks.
                        if (entry.isDirectory()) continue;
                        if (!path.toLowerCase(Locale.ROOT).endsWith(".mp3")) {
                            int skipped;
                            while ((skipped = zip.read(buffer)) != -1) {
                                total += skipped;
                                if (total > LIMIT) throw new ProviderError("Archive exceeds 25 GiB.");
                            }
                            continue;
                        }
                        String name = new File(path).getName();
                        if (!names.add(name.toLowerCase(Locale.ROOT))) throw new ProviderError("Duplicate track names in archive.");
                        File target = new File(output, name); long size = 0;
                        if (!target.createNewFile()) throw new ProviderError("Track already exists.");
                        try (FileOutputStream stream = new FileOutputStream(target)) {
                            int count;
                            while ((count = zip.read(buffer)) != -1) {
                                size += count; total += count;
                                if (total > LIMIT || output.getUsableSpace() < 256L * 1024 * 1024) throw new ProviderError("Not enough space or archive exceeds 25 GiB.");
                                stream.write(buffer, 0, count);
                            }
                            stream.getFD().sync();
                        }
                        if (size == 0) throw new ProviderError("Empty track in archive.");
                        files.put(new JSONObject().put("name", name).put("path", target.toURI().toString()));
                        zip.closeEntry(); // CRC and size validation are performed by ZipInputStream.
                    }
                }
            }
            if (files.length() == 0 || files.length() > 10000) throw new ProviderError("No complete audio found.");
            return new JSONObject().put("files", files);
        } catch (Exception error) { clearExtraction(output); throw error; }
    }
    private static void clearExtraction(File folder) throws IOException {
        File[] files = folder.listFiles();
        if (files != null) for (File file : files) {
            if (!file.isFile() || !file.delete()) throw new IOException("Could not clean extracted tracks.");
        }
        if (!folder.delete()) throw new IOException("Could not clean extraction folder.");
    }
}
