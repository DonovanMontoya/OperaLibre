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
  return ids.flatMap(id => available.get(id) ?? []);
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

// Places `id` at `targetIndex` among the books on screen. Stored entries that
// are not shown (in progress, or offline) keep their places around it.
export function moveQueuedBook(ids: readonly string[], id: string, targetIndex: number, visibleIds: readonly string[] = ids): string[] {
  if (!ids.includes(id) || !visibleIds.includes(id)) return [...ids];
  const others = visibleIds.filter(entry => entry !== id);
  const index = Math.max(0, Math.min(targetIndex, others.length));
  if (index === visibleIds.indexOf(id)) return [...ids];
  const next = ids.filter(entry => entry !== id);
  const before = others[index];
  const after = others[index - 1];
  const at = before !== undefined ? next.indexOf(before) : after !== undefined ? next.indexOf(after) + 1 : next.length;
  next.splice(at, 0, id);
  return next;
}
