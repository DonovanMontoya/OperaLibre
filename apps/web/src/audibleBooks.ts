import type { LibationBook } from "./types.ts";

export type AudibleBook = LibationBook & {
  accounts: Pick<LibationBook, "catalogId" | "profileId" | "profileName">[];
};

/** Group ownership rows by product, retaining every account for tags and job state. */
export function groupAudibleBooks(books: LibationBook[]): AudibleBook[] {
  const grouped = new Map<string, AudibleBook>();
  for (const book of books) {
    const key = book.asin.toUpperCase();
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...book, accounts: [book] });
    } else {
      if (!existing.accounts.some(account => account.profileId === book.profileId)) {
        existing.accounts.push(book);
      }
      existing.localBookId ??= book.localBookId;
    }
  }
  return [...grouped.values()];
}
