import { optionalCompanionDownload } from "./companionCache.ts";
import type { Book } from "./types";

/** Browser download storage, with rollback if required audio fails. */
export async function downloadWebBook(
  book: Pick<Book, "tracks" | "coverArtUrl" | "companions" | "syncFile">,
  resolveUrl: (path: string) => string,
  save: (kind: string, blob: Blob) => Promise<void>,
  remove: (kind: string) => Promise<void>,
  onProgress: (completed: number, total: number) => void,
  signal?: AbortSignal
) {
  const total = book.tracks.length;
  // Records written by this attempt, so an abort or failure part-way leaves
  // no half-downloaded book behind that `isBookDownloaded` would then have to
  // explain.
  const written: string[] = [];
  async function download(kind: string, url: string, label: string) {
    signal?.throwIfAborted();
    const response = await fetch(resolveUrl(url), { signal });
    if (!response.ok) throw new Error(`Could not download ${label} (${response.status}).`);
    const blob = await response.blob();
    signal?.throwIfAborted();
    await save(kind, blob);
    written.push(kind);
    signal?.throwIfAborted();
  }

  try {
    signal?.throwIfAborted();
    let completed = 0;
    for (const track of book.tracks) {
      await download(`track:${track.id}`, track.downloadUrl ?? track.streamUrl, track.title);
      onProgress(++completed, total);
    }
    // Covers, ebooks and sync maps are optional; cancellation is not.
    if (book.coverArtUrl) {
      await optionalCompanionDownload(
        () => download("cover", book.coverArtUrl!, "cover art"), signal
      );
    }
    for (const companion of book.companions ?? []) {
      await optionalCompanionDownload(
        () => download(`companion:${companion.id}`, companion.url, companion.fileName), signal
      );
    }
    if (book.syncFile) {
      await optionalCompanionDownload(
        () => download("sync", book.syncFile!.url, "read-along sync"), signal
      );
    }
    signal?.throwIfAborted();
  } catch (error) {
    await Promise.all(written.map((key) => remove(key).catch(() => undefined)));
    throw error;
  }
}
