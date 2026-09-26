import assert from "node:assert/strict";
import test from "node:test";
import { mergeDeviceReadingFiles } from "../src/deviceEpub.ts";
import type { Book, CompanionFile, ReadingFile } from "../src/types.ts";

const deviceReadingFile: ReadingFile = {
  id: "device:book:epub", fileName: "local.epub", extension: "epub",
  contentType: "application/epub+zip", url: "/device-books/book/reading.epub"
};
const deviceCompanion: CompanionFile = {
  ...deviceReadingFile, kind: "book", sizeBytes: 42,
  localFilePath: "device-library/book/reading.epub"
};
const deviceBook = { readingFile: deviceReadingFile, companions: [deviceCompanion] };

test("a locally paired EPUB survives reconciliation with a server audiobook", () => {
  const serverReadingFile: ReadingFile = {
    id: "server-text", fileName: "book.txt", extension: "txt",
    contentType: "text/plain", url: "/media/book.txt"
  };
  const serverBook: Pick<Book, "readingFile" | "companions" | "syncFile"> = {
    readingFile: serverReadingFile,
    companions: [
      { ...serverReadingFile, kind: "book", sizeBytes: 100 },
      { id: "cover", fileName: "map.jpg", extension: "jpg", contentType: "image/jpeg", url: "/media/map.jpg", kind: "image", sizeBytes: 200 }
    ],
    syncFile: { fileName: "old.json", source: "sidecar", url: "/media/old.json" }
  };

  const merged = mergeDeviceReadingFiles(serverBook, deviceBook);
  assert.equal(merged.readingFile?.id, deviceReadingFile.id);
  assert.equal(merged.companions?.[0].localFilePath, deviceCompanion.localFilePath);
  assert.equal(merged.companions?.[1].kind, "supplement");
  assert.equal(merged.companions?.[2].id, "cover");
  assert.equal(merged.syncFile, null);
});

test("a server EPUB and its sync map remain primary when present", () => {
  const serverReadingFile = { ...deviceReadingFile, id: "server-epub", url: "/media/book.epub" };
  const serverBook: Pick<Book, "readingFile" | "companions" | "syncFile"> = {
    readingFile: serverReadingFile,
    companions: [{ ...serverReadingFile, kind: "book", sizeBytes: 100 }],
    syncFile: { fileName: "sync.json", source: "generated", url: "/media/sync.json" }
  };

  assert.deepEqual(mergeDeviceReadingFiles(serverBook, deviceBook), serverBook);
});
