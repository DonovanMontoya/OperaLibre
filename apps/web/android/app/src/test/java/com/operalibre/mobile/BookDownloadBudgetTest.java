package com.operalibre.mobile;

import org.junit.Test;
import java.io.File;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.util.Arrays;
import static org.junit.Assert.*;

public class BookDownloadBudgetTest {
    @Test public void multipartAndRestoredFilesShareOneBudget() throws Exception {
        File folder = Files.createTempDirectory("libro-budget").toFile();
        File a = new File(folder, "a.zip"); File b = new File(folder, "b.zip");
        try {
            try (RandomAccessFile f = new RandomAccessFile(a, "rw")) { f.setLength(7); }
            long retained = BookDownloadBudget.retained(Arrays.asList(a, b), 12);
            assertEquals(7, retained);
            BookDownloadBudget.check(retained, 5, 12);
            try { BookDownloadBudget.check(retained, 7, 12); fail("Each part got a new budget"); }
            catch (BookDownloadBudget.Exceeded expected) {}
            // Restart after publication, even before the progress counter was saved.
            try (RandomAccessFile f = new RandomAccessFile(b, "rw")) { f.setLength(6); }
            try { BookDownloadBudget.retained(Arrays.asList(a, b), 12); fail("Restored files escaped accounting"); }
            catch (BookDownloadBudget.Exceeded expected) {}
            try { BookDownloadBudget.check(Long.MAX_VALUE - 1, 3, Long.MAX_VALUE); fail("Overflow bypass"); }
            catch (BookDownloadBudget.Exceeded expected) {}
        } finally { a.delete(); b.delete(); folder.delete(); }
    }
}
