package com.operalibre.mobile;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;

import static org.junit.Assert.*;

public class DownloadRedirectTest {
    /** Answers each request with the location to redirect to, or null for 200. */
    private static final class Server implements AutoCloseable {
        final ServerSocket socket;
        final List<String> requested = new CopyOnWriteArrayList<>();

        Server(Function<String, String> redirects) throws Exception {
            socket = new ServerSocket(0, 8, InetAddress.getLoopbackAddress());
            Thread thread = new Thread(() -> {
                while (!socket.isClosed()) {
                    try (Socket client = socket.accept()) {
                        BufferedReader reader = new BufferedReader(
                            new InputStreamReader(client.getInputStream(), StandardCharsets.ISO_8859_1)
                        );
                        String path = URI.create(reader.readLine().split(" ")[1]).getPath();
                        while (!reader.readLine().isEmpty()) { /* Skip the headers. */ }
                        requested.add(path);
                        String location = redirects.apply(path);
                        String response = location == null
                            ? "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc"
                            : "HTTP/1.1 302 Found\r\nLocation: " + location + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                        OutputStream output = client.getOutputStream();
                        output.write(response.getBytes(StandardCharsets.ISO_8859_1));
                        output.flush();
                    } catch (Exception closed) {
                        // The socket closes when the test ends.
                    }
                }
            });
            thread.setDaemon(true);
            thread.start();
        }

        String origin() {
            return "http://" + socket.getInetAddress().getHostAddress() + ":" + socket.getLocalPort();
        }

        @Override public void close() throws Exception {
            socket.close();
        }
    }

    private Server elsewhere;
    private Server server;

    @Before public void start() throws Exception {
        elsewhere = new Server(path -> null);
        server = new Server(path -> {
            switch (path) {
                case "/listen/api/moved": return "/listen/api/file";
                case "/listen/api/away": return elsewhere.origin() + "/listen/api/file";
                case "/listen/api/outside": return "/other/api/file";
                default: return null;
            }
        });
    }

    @After public void stop() throws Exception {
        server.close();
        elsewhere.close();
    }

    private HttpURLConnection open(String path) throws Exception {
        DownloadSourcePolicy policy = DownloadSourcePolicy.forServer(server.origin() + "/listen");
        return OfflineDownloadWorker.openWithAllowedRedirects(new URL(server.origin() + path + "?token=secret"), policy);
    }

    @Test public void redirectWithinTheServerIsFollowed() throws Exception {
        HttpURLConnection connection = open("/listen/api/moved");
        try {
            assertEquals(200, connection.getResponseCode());
            assertEquals("/listen/api/file", connection.getURL().getPath());
        } finally {
            connection.disconnect();
        }
    }

    @Test public void redirectToAnotherOriginIsRefusedBeforeItIsRequested() {
        assertThrows(SecurityException.class, () -> open("/listen/api/away"));
        assertTrue(elsewhere.requested.isEmpty());
    }

    @Test public void redirectOutsideTheBasePathIsRefusedBeforeItIsRequested() {
        assertThrows(SecurityException.class, () -> open("/listen/api/outside"));
        assertEquals(List.of("/listen/api/outside"), server.requested);
    }

    @Test public void sourceOutsideTheBasePathIsNeverRequested() {
        assertThrows(SecurityException.class, () -> open("/other/api/file"));
        assertTrue(server.requested.isEmpty());
    }
}
