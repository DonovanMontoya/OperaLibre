import { type Dispatch, type SetStateAction, useState } from "react";
import { metadataEditorFromBook, type MetadataEditorState, metadataUpdateFromEditor } from "./metadataEditor";
import type { Book } from "./types";
import { updateBookMetadata } from "./api";
import { errorMessage } from "./formatting";

export function useMetadataEditor({
  reconcileServerBookGains,
  selectedBook,
  setBooks
}: {
  reconcileServerBookGains: (payload: readonly Book[]) => void;
  selectedBook: Book;
  setBooks: Dispatch<SetStateAction<Book[]>>;
}) {
  const [metadataEditOpen, setMetadataEditOpen] = useState(false);
  const [metadataForm, setMetadataForm] = useState<MetadataEditorState | null>(null);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);

  function openMetadataEditor(book: Book) {
    setMetadataForm(metadataEditorFromBook(book));
    setMetadataError(null);
    setMetadataEditOpen(true);
  }

  async function saveMetadata(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedBook || !metadataForm) {
      return;
    }

    const update = metadataUpdateFromEditor(metadataForm);
    if (!update.title) {
      setMetadataError("Title is required.");
      return;
    }

    setMetadataSaving(true);
    setMetadataError(null);
    try {
      const updatedBook = await updateBookMetadata(selectedBook.id, update);
      setBooks((existing) =>
        existing.map((book) => (book.id === updatedBook.id ? updatedBook : book))
      );
      reconcileServerBookGains([updatedBook]);
      setMetadataEditOpen(false);
      setMetadataForm(null);
    } catch (error) {
      setMetadataError(errorMessage(error, "Book info could not be saved."));
    } finally {
      setMetadataSaving(false);
    }
  }

  return {
    metadataEditOpen,
    metadataError,
    metadataForm,
    metadataSaving,
    openMetadataEditor,
    saveMetadata,
    setMetadataEditOpen,
    setMetadataError,
    setMetadataForm
  };
}
