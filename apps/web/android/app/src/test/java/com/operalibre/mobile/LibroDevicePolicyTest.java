package com.operalibre.mobile;

import org.junit.Test;
import java.net.URL;
import static org.junit.Assert.*;

public class LibroDevicePolicyTest {
    @Test public void providerDownloadsRequireApprovedHttpsHosts() throws Exception {
        for (String value : new String[] {"https://assets.libro.fm/book.m4b", "https://books.s3.amazonaws.com/part.zip", "https://example.cloudfront.net/book"}) {
            assertTrue(value, LibroDevicePlugin.allowedDownload(new URL(value)));
        }
        for (String value : new String[] {"http://libro.fm/book", "https://libro.fm.evil.test/book", "https://localhost/book", "https://libro.fm:8000/book", "https://name:secret@libro.fm/book"}) {
            assertFalse(value, LibroDevicePlugin.allowedDownload(new URL(value)));
        }
    }
}
