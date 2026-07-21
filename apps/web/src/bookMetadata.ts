import type { Book, LibationBook } from "./types";

function descriptionEchoesBook(book: Book, description: string) {
  const normalized = description.trim().toLowerCase();
  const echoes = (value: string) => value.trim().toLowerCase() === normalized;
  return (
    echoes(book.title) ||
    book.tracks.some((track) => echoes(track.title)) ||
    book.chapters.some((chapter) => echoes(chapter.title))
  );
}

/** Hide track/chapter labels that some audiobook files store as a comment. */
export function displayBookDescription(book: Book) {
  const description = book.description?.trim();
  return description && !descriptionEchoesBook(book, description) ? description : null;
}

function cleanCatalogDescription(value: string | null) {
  const description = value
    ?.replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return description || null;
}

/** Fill missing/invalid local tag descriptions from the matched Audible record. */
export function enrichBooksFromLibation(books: Book[], catalog: LibationBook[]) {
  const byLocalId = new Map(
    catalog.filter((book) => book.localBookId).map((book) => [book.localBookId!, book])
  );
  const byAsin = new Map(catalog.map((book) => [book.asin.toUpperCase(), book]));
  let changed = false;
  const enriched = books.map((book) => {
    if (displayBookDescription(book)) return book;
    const record = byLocalId.get(book.id) ?? (book.asin ? byAsin.get(book.asin.toUpperCase()) : undefined);
    const description = cleanCatalogDescription(record?.description ?? null);
    if (!description || descriptionEchoesBook(book, description)) return book;
    changed = true;
    return {
      ...book,
      description,
      metadata: { ...book.metadata, description }
    };
  });
  return changed ? enriched : books;
}
