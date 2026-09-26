import type { Book, CompanionFile } from "./types";

/** Keep a paired device EPUB visible when its audiobook matches a server book. */
export function mergeDeviceReadingFiles(
  serverBook: Pick<Book, "readingFile" | "companions" | "syncFile">,
  deviceBook: Pick<Book, "readingFile" | "companions">
): Pick<Book, "readingFile" | "companions" | "syncFile"> {
  const deviceEpub = deviceBook.companions?.find((file) =>
    file.id === deviceBook.readingFile?.id && file.extension === "epub" && !!file.localFilePath
  );
  if (!deviceEpub || serverBook.readingFile?.extension === "epub") {
    return {
      readingFile: serverBook.readingFile,
      companions: serverBook.companions,
      syncFile: serverBook.syncFile
    };
  }

  const serverCompanions: CompanionFile[] = serverBook.companions ?? (serverBook.readingFile ? [{
    ...serverBook.readingFile, kind: "supplement", sizeBytes: 0
  }] : []);
  return {
    readingFile: deviceBook.readingFile,
    companions: [deviceEpub, ...serverCompanions.map((file) =>
      file.id === serverBook.readingFile?.id ? { ...file, kind: "supplement" as const } : file
    )],
    syncFile: null
  };
}
