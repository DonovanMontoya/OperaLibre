import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { metadataEditorFromBook, type MetadataEditorState, metadataUpdateFromEditor } from "./metadataEditor";
import type { Book } from "./types";
import { getServerStorageKey, removeBookCover, updateBookMetadata, uploadBookCover } from "./api";
import { coverFileError, mergeBookEdit } from "./bookCover";
import { errorMessage } from "./formatting";
import { cacheLibrary } from "./offline";

export function useMetadataEditor({ books, currentUserId, selectedBook, setBooks }: {
  books: Book[];
  currentUserId: string;
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
  const booksRef = useRef(books);
  booksRef.current = books;
  const scope = `${getServerStorageKey()}:${currentUserId}`;
  const scopeRef = useRef<string | null>(scope);
  scopeRef.current = scope;

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
  useEffect(() => {
    scopeRef.current = scope;
    return () => { sessionRef.current += 1; scopeRef.current = null; };
  }, [scope]);

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
    const sameScope = () => scopeRef.current === scope && getServerStorageKey() === server;
    const isCurrent = () => sessionRef.current === session && sameScope();
    let cacheFailed = false;
    async function applyResult(updated: Book, kind: "metadata" | "cover") {
      if (updated.id !== bookId) throw new Error("The server returned a different book. Reload the library and try again.");
      if (!sameScope()) return;
      const next = booksRef.current.map((book) => book.id === bookId ? mergeBookEdit(book, updated, kind) : book);
      booksRef.current = next;
      setBooks((existing) => existing.map((book) => book.id === bookId ? mergeBookEdit(book, updated, kind) : book));
      // Finish persisting the current catalogue before acknowledging the edit,
      // so an offline relaunch cannot revive a removed or replaced cover.
      try {
        await cacheLibrary(currentUserId, next.filter((book) => book.source !== "device"));
        cacheFailed = false;
      } catch {
        cacheFailed = true;
      }
    }
    pendingRef.current.add(pendingKey);
    setMetadataSaving(true);
    setMetadataError(null);
    let infoSaved = false;
    try {
      const updatedBook = await updateBookMetadata(bookId, update);
      await applyResult(updatedBook, "metadata");
      infoSaved = true;
      // Do not send the second write to a different server after reconnecting.
      if (!sameScope()) return;
      if (coverFile) await applyResult(await uploadBookCover(bookId, coverFile), "cover");
      else if (coverRemoval) await applyResult(await removeBookCover(bookId), "cover");
      if (isCurrent()) {
        if (cacheFailed) setMetadataError("Your changes were saved on the server, but the offline library could not be updated. Retry Save Info before going offline.");
        else closeMetadataEditor();
      }
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
