import type { AudibleBook } from "./audibleBooks.ts";
import { cleanCatalogDescription } from "./bookMetadata.ts";
import type { LibroAccountStatus } from "./types.ts";

export type LibroPurchase = LibroAccountStatus["books"][number];

/** What the details page shows for a purchase that may not be on the server yet. */
export type StoreBookFacts = {
  store: "Libro.fm" | "Audible";
  title: string;
  subtitle: string | null;
  author: string | null;
  narrator: string | null;
  runtimeSeconds: number | null;
  publisher: string | null;
  identifier: { label: "ISBN" | "ASIN"; value: string };
  accounts: string[];
  description: string | null;
};

function storeDescription(value: string | null, title: string) {
  const description = cleanCatalogDescription(value);
  return description && description.toLowerCase() !== title.trim().toLowerCase() ? description : null;
}

const joined = (values: string[]) => values.map(value => value.trim()).filter(Boolean).join(", ") || null;

export function libroBookFacts(book: LibroPurchase, accountLabel: string | null): StoreBookFacts {
  return {
    store: "Libro.fm",
    title: book.title,
    subtitle: null,
    author: joined(book.authors),
    narrator: joined(book.audiobook_info.narrators),
    runtimeSeconds: book.audiobook_info.duration,
    publisher: null,
    identifier: { label: "ISBN", value: book.isbn },
    accounts: accountLabel ? [accountLabel] : [],
    description: storeDescription(book.description, book.title)
  };
}

export function audibleBookFacts(book: AudibleBook, accountLabel: (profileId: string) => string | undefined): StoreBookFacts {
  return {
    store: "Audible",
    title: book.title,
    subtitle: book.subtitle?.trim() || null,
    author: book.authors?.trim() || null,
    narrator: book.narrators?.trim() || null,
    runtimeSeconds: book.lengthMinutes === null ? null : book.lengthMinutes * 60,
    publisher: book.publisher?.trim() || null,
    identifier: { label: "ASIN", value: book.asin },
    accounts: book.accounts.map(account => accountLabel(account.profileId) ?? account.profileName),
    description: storeDescription(book.description, book.title)
  };
}
