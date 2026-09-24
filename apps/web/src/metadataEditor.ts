import { tagsForBook } from "./bookMetadata";
import type { Book, BookMetadataUpdate } from "./types";

export type MetadataEditorState = {
  title: string;
  author: string;
  narrator: string;
  publisher: string;
  series: string;
  seriesPosition: string;
  tags: { name: string; position: string }[];
  publishedDate: string;
  genres: string;
  asin: string;
  description: string;
};

export function metadataEditorFromBook(book: Book): MetadataEditorState {
  return {
    title: book.title,
    author: book.author ?? "",
    narrator: book.narrator ?? "",
    publisher: book.metadata.publisher ?? "",
    series: book.metadata.series ?? "",
    seriesPosition: book.metadata.seriesPosition ?? "",
    tags: tagsForBook(book).map((tag) => ({
      name: tag.name,
      position: tag.position ?? ""
    })),
    publishedDate: book.publishedDate ?? "",
    genres: book.genres.join(", "),
    asin: book.asin ?? "",
    description: book.description ?? ""
  };
}

function parseGenreInput(value: string) {
  return value
    .split(/[;,]/)
    .map((genre) => genre.trim())
    .filter(Boolean);
}

export function metadataUpdateFromEditor(form: MetadataEditorState): BookMetadataUpdate {
  return {
    title: form.title.trim(),
    author: form.author.trim(),
    narrator: form.narrator.trim(),
    publisher: form.publisher.trim(),
    series: form.series.trim(),
    seriesPosition: form.seriesPosition.trim(),
    tags: form.tags
      .map((tag) => ({
        name: tag.name.trim(),
        position: tag.position.trim() || null
      }))
      .filter((tag) => tag.name),
    publishedDate: form.publishedDate.trim(),
    genres: parseGenreInput(form.genres),
    asin: form.asin.trim(),
    description: form.description.trim()
  };
}
