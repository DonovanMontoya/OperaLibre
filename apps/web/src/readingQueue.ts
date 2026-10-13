import type { Book } from "./types.ts";

export function readingQueueKey(server: string, user: string) {
  return `operalibre.readingQueue.${JSON.stringify([server, user])}`;
}

export function parseReadingQueue(value: string | null): string[] {
  try {
    const ids: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))] : [];
  } catch {
    return [];
  }
}

export function queuedBooks(ids: readonly string[], books: readonly Book[]): Book[] {
  const available = new Map(books.map(book => [book.id, book]));
  return ids.flatMap(id => {
    const book = available.get(id);
    return book && (!book.progress || book.progress.status === "notStarted") ? [book] : [];
  });
}

export function moveQueuedBookEarlier(ids: readonly string[], id: string, visibleIds: readonly string[] = ids): string[] {
  const next = [...ids];
  const index = next.indexOf(id);
  const previousId = visibleIds[visibleIds.indexOf(id) - 1];
  const previousIndex = previousId === undefined ? -1 : next.indexOf(previousId);
  if (index > 0 && previousIndex >= 0 && previousIndex < index) {
    [next[previousIndex], next[index]] = [next[index], next[previousIndex]];
  }
  return next;
}
