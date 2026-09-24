import type { Book } from "./types";

export function existingMetadataNames(books: readonly Book[], field: "series" | "tag") {
  const names = new Map<string, string>();
  for (const book of books) {
    const values = field === "series"
      ? [book.metadata.series]
      : (book.tags ?? []).map((tag) => tag.name);
    for (const value of values) {
      const name = value?.trim();
      if (name && !names.has(name.toLocaleLowerCase())) {
        names.set(name.toLocaleLowerCase(), name);
      }
    }
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

export function matchingMetadataNames(names: readonly string[], input: string) {
  const query = input.trim().toLocaleLowerCase();
  if (!query) return [];
  return names
    .filter((name) => name !== input.trim() && name.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.toLocaleLowerCase().startsWith(query)) - Number(a.toLocaleLowerCase().startsWith(query)) || a.localeCompare(b))
    .slice(0, 6);
}
