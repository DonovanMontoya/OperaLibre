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

const HTML_TAG = /<\/?[a-z][^>]*>/i;
const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', apos: "'", lt: "<", gt: ">", hellip: "\u2026", mdash: "\u2014", ndash: "\u2013",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", copy: "\u00a9", reg: "\u00ae", trade: "\u2122"
};

function decodeEntity(entity: string, name: string) {
  const code = /^#x([\da-f]+)$/i.exec(name)?.[1];
  const decimal = /^#(\d+)$/.exec(name)?.[1];
  const point = code ? parseInt(code, 16) : decimal ? Number(decimal) : null;
  if (point !== null) return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
  return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
}

/** Hide blank descriptions and track/chapter labels stored as a comment. */
export function displayBookDescription(book: Book) {
  // Tags and providers such as Audible and Jellyfin often store the blurb as HTML.
  const description = book.description && HTML_TAG.test(book.description)
    ? cleanCatalogDescription(book.description)
    : cleanDescriptionSpaces(book.description);
  return description && !descriptionEchoesBook(book, description) ? description : null;
}

/** Convert catalog HTML to plain text, keeping paragraph and line breaks. */
export function cleanCatalogDescription(value: string | null) {
  const description = cleanDescriptionSpaces(value)
    ?.replace(/\s+/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    // Strip any markup reconstructed from malformed tags or decoded entities.
    .replace(/[<>]/g, "")
    // Decode ampersands last so `&amp;lt;` cannot become a tag in this pass.
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return description || null;
}

/** Show a full timestamp, as Jellyfin and some tags store it, as a calendar date. */
export function displayPublishedDate(value: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(trimmed);
  if (!match) return trimmed;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });
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
