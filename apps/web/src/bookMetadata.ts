import type { Book, BookTag, LibationBook } from "./types";

/** Native offline caches written by an older frontend do not have this field. */
export function tagsForBook(book: Book): BookTag[] {
  return book.tags ?? [];
}

function descriptionEchoesBook(book: Book, description: string) {
  const normalized = description.trim().toLowerCase();
  const echoes = (value: string) => value.trim().toLowerCase() === normalized;
  return (
    echoes(book.title) ||
    book.tracks.some((track) => echoes(track.title)) ||
    book.chapters.some((chapter) => echoes(chapter.title))
  );
}

function cleanDescriptionSpaces(value: string | null) {
  // Cached metadata can contain escaped entities or omit the trailing semicolon.
  return value
    ?.replace(/&(?:amp;)*(?:nbsp|#0*160|#x0*a0)(?:;|(?=\s|$|[<&]))/gi, " ")
    .trim() || null;
}

/** Hide blank descriptions and track/chapter labels stored as a comment. */
export function displayBookDescription(book: Book) {
  const description = cleanDescriptionSpaces(book.description);
  return description && !descriptionEchoesBook(book, description) ? description : null;
}

function cleanCatalogDescription(value: string | null) {
  const description = cleanDescriptionSpaces(value)
    ?.replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    // Strip any markup reconstructed from malformed tags or decoded entities.
    .replace(/[<>]/g, "")
    // Decode ampersands last so `&amp;lt;` cannot become a tag in this pass.
    .replace(/&amp;/gi, "&")
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
