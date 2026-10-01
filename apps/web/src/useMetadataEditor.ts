import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { metadataEditorFromBook, type MetadataEditorState, metadataUpdateFromEditor } from "./metadataEditor";
import type { Book } from "./types";
import { getServerStorageKey, removeBookCover, updateBookMetadata, uploadBookCover } from "./api";
import { coverFileError, mergeBookEdit } from "./bookCover";
import { errorMessage } from "./formatting";

export function useMetadataEditor({ selectedBook, setBooks }: {
  selectedBook: Book | null;
  setBooks: Dispatch<SetStateAction<Book[]>>;
}) {
  const [metadataBook, setMetadataBook] = useState<Book | null>(null);
  const [metadataForm, setMetadataForm] = useState<MetadataEditorState | null>(null);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverRemoval, setCoverRemoval] = useState(false);
  const sessionRef = useRef(0);
  const pendingRef = useRef(new Set<string>());

  function closeMetadataEditor() {
    sessionRef.current += 1;
    setMetadataBook(null);
    setMetadataForm(null);
    setMetadataError(null);
    setMetadataSaving(false);
    setCoverFile(null);
    setCoverRemoval(false);
  }

  useEffect(() => {
    if (metadataBook && metadataBook.id !== selectedBook?.id) closeMetadataEditor();
  }, [metadataBook, selectedBook?.id]);
  useEffect(() => () => { sessionRef.current += 1; }, []);

  function openMetadataEditor(book: Book) {
    sessionRef.current += 1;
    setMetadataBook(book);
    setMetadataForm(metadataEditorFromBook(book));
    setMetadataError(null);
    setMetadataSaving(false);
    setCoverFile(null);
    setCoverRemoval(false);
  }

  function resetMetadataEditor() {
    const book = selectedBook?.id === metadataBook?.id ? selectedBook : metadataBook;
    if (book) setMetadataForm(metadataEditorFromBook(book));
    setMetadataError(null);
    setCoverFile(null);
    setCoverRemoval(false);
  }

  function chooseCover(file: File | null) {
    if (!file) return;
    const error = coverFileError(file);
    setMetadataError(error);
    if (error) {
      setCoverFile(null);
      setCoverRemoval(false);
      return;
    }
    setCoverFile(file);
    setCoverRemoval(false);
  }

  function removeCover() {
    setCoverFile(null);
    setCoverRemoval(true);
    setMetadataError(null);
  }

  async function saveMetadata(event: React.FormEvent) {
    event.preventDefault();
    if (!metadataBook || !metadataForm) return;
    const bookId = metadataBook.id;
    const server = getServerStorageKey();
    const pendingKey = `${server}:${bookId}`;
    if (pendingRef.current.has(pendingKey)) {
      if (!metadataSaving) setMetadataError("A previous save for this book is still in progress. Try again when it finishes.");
      return;
    }
    const update = metadataUpdateFromEditor(metadataForm);
    if (!update.title) {
      setMetadataError("Title is required.");
      return;
    }
    const fileError = coverFile ? coverFileError(coverFile) : null;
    if (fileError) {
      setMetadataError(fileError);
      return;
    }
    const session = sessionRef.current;
    const isCurrent = () => sessionRef.current === session && getServerStorageKey() === server;
    function applyResult(updated: Book, kind: "metadata" | "cover") {
      if (updated.id !== bookId) throw new Error("The server returned a different book. Reload the library and try again.");
      if (getServerStorageKey() !== server) return;
      setBooks((existing) => existing.map((book) => book.id === bookId ? mergeBookEdit(book, updated, kind) : book));
    }
    pendingRef.current.add(pendingKey);
    setMetadataSaving(true);
    setMetadataError(null);
    let infoSaved = false;
    try {
      const updatedBook = await updateBookMetadata(bookId, update);
      applyResult(updatedBook, "metadata");
      infoSaved = true;
      // Do not send the second write to a different server after reconnecting.
      if (getServerStorageKey() !== server) return;
      if (coverFile) applyResult(await uploadBookCover(bookId, coverFile), "cover");
      else if (coverRemoval) applyResult(await removeBookCover(bookId), "cover");
      if (isCurrent()) closeMetadataEditor();
    } catch (error) {
      if (isCurrent()) {
        const message = errorMessage(error, infoSaved ? "The cover could not be saved." : "Book info could not be saved.");
        setMetadataError(infoSaved ? `Book info was saved, but the cover update could not be confirmed. ${message} Retry Save Info or reload the library to check.` : message);
      }
    } finally {
      pendingRef.current.delete(pendingKey);
      if (isCurrent()) setMetadataSaving(false);
    }
  }

  return {
    metadataBook: selectedBook?.id === metadataBook?.id ? selectedBook : metadataBook,
    metadataEditOpen: metadataBook !== null,
    metadataError,
    metadataForm,
    metadataSaving,
    coverFile,
    coverRemoval,
    chooseCover,
    removeCover,
    openMetadataEditor,
    closeMetadataEditor,
    resetMetadataEditor,
    saveMetadata,
    setMetadataForm
  };
}
