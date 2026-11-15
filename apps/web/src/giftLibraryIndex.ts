import type { Book } from "./types";

const PENDING_KEY = "operalibre.pendingGiftIndex.v1";
const LIBRARY_KEY = "operalibre.deviceLibrary.v1";
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Recover publication only after native extraction has committed its files.
 * A single localStorage write publishes the index; the journal bridges a crash
 * between that write and journal removal. Callers must serialize operations in
 * the same app process and verify the committed files before calling publish.
 */
export function recoverGiftIndex(storage: StorageLike): void {
  const pending = storage.getItem(PENDING_KEY);
  if (!pending) return;
  const book = JSON.parse(pending) as Book;
  if (!book || typeof book.id !== "string" || !/^device:gift:[A-Za-z0-9_-]{16,128}$/.test(book.id) || book.source !== "device") throw new Error("Invalid pending gift index.");
  const books = JSON.parse(storage.getItem(LIBRARY_KEY) ?? "[]") as Book[];
  if (!Array.isArray(books)) throw new Error("Invalid device library index.");
  if (!books.some(existing => existing.id === book.id)) storage.setItem(LIBRARY_KEY, JSON.stringify([...books, book]));
  storage.removeItem(PENDING_KEY);
}

export function publishGiftIndex(storage: StorageLike, giftId: string, book: Book): "imported" | "duplicate" {
  recoverGiftIndex(storage);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(giftId) || book.id !== `device:gift:${giftId}` || book.source !== "device" || book.deviceBookId !== book.id) throw new Error("Invalid gift book identity.");
  const books = JSON.parse(storage.getItem(LIBRARY_KEY) ?? "[]") as Book[];
  if (!Array.isArray(books)) throw new Error("Invalid device library index.");
  if (books.some(existing => existing.id === book.id)) return "duplicate";
  storage.setItem(PENDING_KEY, JSON.stringify(book));
  storage.setItem(LIBRARY_KEY, JSON.stringify([...books, book]));
  storage.removeItem(PENDING_KEY);
  return "imported";
}
