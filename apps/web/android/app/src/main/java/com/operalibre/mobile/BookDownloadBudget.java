package com.operalibre.mobile;

import java.io.File;
import java.io.IOException;
import java.util.Collection;

/** Counts real retained files, including parts published before progress was saved. */
final class BookDownloadBudget {
    static final long LIMIT = 25L * 1024 * 1024 * 1024;
    static final class Exceeded extends IOException {
        Exceeded() { super("The book exceeds the 25 GiB download limit."); }
    }
    static long retained(Collection<File> files, long limit) throws Exceeded {
        long total = 0;
        for (File file : files) {
            long size = file.isFile() ? file.length() : 0;
            if (size > limit - total) throw new Exceeded();
            total += size;
        }
        return total;
    }
    static void check(long retained, long incoming, long limit) throws Exceeded {
        if (retained < 0 || incoming < 0 || retained > limit || incoming > limit - retained) throw new Exceeded();
    }
}
