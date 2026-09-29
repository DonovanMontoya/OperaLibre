import type { Book } from "./types";
import { deviceBookMatchesServer, progressTimestamp } from "./reliability.ts";
import { mergeDeviceReadingFiles } from "./deviceEpub.ts";

/** Attach an equivalent device copy without hiding ambiguous editions. */
export function mergeLibraryBooks(serverBooks: Book[], deviceBooks: Book[]): Book[] {
  const unmatched = new Set(deviceBooks.map((book) => book.id));
  const merged = serverBooks.map((serverBook) => {
    const candidates = deviceBooks.filter((candidate) =>
      unmatched.has(candidate.id) && deviceBookMatchesServer(candidate, serverBook)
    );
    if (candidates.length !== 1) return { ...serverBook, tags: serverBook.tags ?? [], source: "server" as const };
    const deviceBook = candidates[0];
    if (serverBooks.filter((candidate) => deviceBookMatchesServer(deviceBook, candidate)).length !== 1) {
      return { ...serverBook, tags: serverBook.tags ?? [], source: "server" as const };
    }
    unmatched.delete(deviceBook.id);
    const deviceProgressIsNewer = !!deviceBook.progress && (
      !serverBook.progress || progressTimestamp(deviceBook.progress.updatedAt) > progressTimestamp(serverBook.progress.updatedAt)
    );
    return {
      ...serverBook,
      ...mergeDeviceReadingFiles(serverBook, deviceBook),
      tags: serverBook.tags ?? [],
      source: "server" as const,
      deviceBookId: deviceBook.id,
      progress: deviceProgressIsNewer ? deviceBook.progress : serverBook.progress,
      tracks: serverBook.tracks.map((track, index) => ({ ...track, localFilePath: deviceBook.tracks[index]?.localFilePath }))
    };
  });
  return [...merged, ...deviceBooks.filter((book) => unmatched.has(book.id))];
}

/** An upload adds files; it must not roll back playback that advanced during the request. */
export function libraryAfterUpload(current: Book[], serverBooks: Book[], deviceBooks: Book[]): Book[] {
  const previous = new Map(current.map((book) => [book.id, book]));
  return mergeLibraryBooks(serverBooks, deviceBooks).map((book) => {
    const progress = previous.get(book.id)?.progress;
    return progress && (!book.progress || progressTimestamp(progress.updatedAt) > progressTimestamp(book.progress.updatedAt))
      ? { ...book, progress }
      : book;
  });
}
