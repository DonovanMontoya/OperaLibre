import type { Book } from "./types";

export function hasPreciseSync(book: Pick<Book, "syncFile"> | null | undefined): boolean {
  return book?.syncFile?.source === "sidecar" || book?.syncFile?.source === "generated";
}

export function syncConfirmationMessage(book: Pick<Book, "title">): string {
  return `${book.title} already has sentence-by-sentence narration sync. Rebuilding it can take a long time. Start only if the audio or text changed, or the current sync needs replacing.`;
}
