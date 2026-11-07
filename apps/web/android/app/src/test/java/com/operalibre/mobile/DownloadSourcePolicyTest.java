package com.operalibre.mobile;

import org.junit.Test;

import java.net.URL;

import static org.junit.Assert.*;

public class DownloadSourcePolicyTest {
    private static boolean allows(String server, String url) throws Exception {
        return DownloadSourcePolicy.forServer(server).allows(new URL(url));
    }

    @Test public void sameOriginUnderTheBasePathIsAllowed() throws Exception {
        assertTrue(allows("https://books.example/listen", "https://books.example/listen/api/books/1/tracks/0/stream?token=t"));
        assertTrue(allows("https://books.example/listen/", "https://BOOKS.example:443/listen/api/books/1/cover"));
        assertTrue(allows("http://192.168.1.20:4920", "http://192.168.1.20:4920/api/books/1/download"));
    }

    @Test public void anotherOriginIsRefused() throws Exception {
        String server = "https://books.example/listen";
        assertFalse(allows(server, "https://elsewhere.example/listen/api/books/1/cover"));
        assertFalse(allows(server, "http://books.example/listen/api/books/1/cover"));
        assertFalse(allows(server, "https://books.example:8443/listen/api/books/1/cover"));
        assertFalse(allows(server, "https://user@books.example/listen/api/books/1/cover"));
        assertFalse(allows(server, "ftp://books.example/listen/api/books/1/cover"));
    }

    @Test public void pathsOutsideTheBasePathAreRefused() throws Exception {
        String server = "https://books.example/listen";
        assertFalse(allows(server, "https://books.example/api/books/1/cover"));
        assertFalse(allows(server, "https://books.example/listening/api/books/1/cover"));
        assertFalse(allows(server, "https://books.example/listen/../other/api/books/1/cover"));
        assertFalse(allows(server, "https://books.example/listen/%2e%2e/other/api/books/1/cover"));
    }

    @Test public void invalidServerAddressesHaveNoPolicy() {
        assertNull(DownloadSourcePolicy.forServer(null));
        assertNull(DownloadSourcePolicy.forServer(""));
        assertNull(DownloadSourcePolicy.forServer("This device"));
        assertNull(DownloadSourcePolicy.forServer("file:///data/books"));
    }

    @Test public void serverAddressRoundTripsThroughTheStoredJob() throws Exception {
        DownloadSourcePolicy stored = DownloadSourcePolicy.forServer(
            DownloadSourcePolicy.forServer("https://Books.example/listen/").serverAddress()
        );
        assertTrue(stored.allows(new URL("https://books.example/listen/api/books/1/cover")));
        assertFalse(stored.allows(new URL("https://books.example/api/books/1/cover")));
    }

    @Test public void escapedBasePathRoundTripsThroughTheStoredJob() throws Exception {
        for (String base : new String[] {"audio%20books", "100%25"}) {
            DownloadSourcePolicy stored = DownloadSourcePolicy.forServer(
                DownloadSourcePolicy.forServer("https://books.example/" + base).serverAddress()
            );
            assertNotNull(base, stored);
            assertTrue(base, stored.allows(new URL("https://books.example/" + base + "/api/books/1/cover")));
            assertFalse(base, stored.allows(new URL("https://books.example/api/books/1/cover")));
        }
    }

    @Test public void jobsSavedWithoutAServerKeepTheirSourceOrigin() throws Exception {
        DownloadSourcePolicy legacy = DownloadSourcePolicy.forSourceOrigin(new URL("https://books.example/api/books/1/download"));
        assertTrue(legacy.allows(new URL("https://books.example/files/1")));
        assertFalse(legacy.allows(new URL("https://elsewhere.example/files/1")));
    }
}
