import { type Dispatch, type SetStateAction, useState } from "react";
import type { Book } from "./types";
import { isSupportedAudioFileName, SUPPORTED_AUDIO_EXTENSIONS } from "./mediaFiles";
import { uploadAudiobook, uploadEbook } from "./api";
import { FilePicker, type PickedFile } from "@capawesome/capacitor-file-picker";
import { addDeviceEpub } from "./localLibrary";
import { errorMessage } from "./formatting";
import type { LibrarySource } from "./shelfSort";

export function useUploads({
  books,
  reconcileServerBookGains,
  setBooks,
  setError,
  setIsOffline,
  setLibrarySource,
  setSelectedBookId
}: {
  books: Book[];
  reconcileServerBookGains: (payload: readonly Book[]) => void;
  setBooks: Dispatch<SetStateAction<Book[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setIsOffline: Dispatch<SetStateAction<boolean>>;
  setLibrarySource: Dispatch<SetStateAction<LibrarySource>>;
  setSelectedBookId: Dispatch<SetStateAction<string | null>>;
}) {
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadBookName, setUploadBookName] = useState("");
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [ebookUploadBook, setEbookUploadBook] = useState<Book | null>(null);
  const [ebookUploadFile, setEbookUploadFile] = useState<File | PickedFile | null>(null);
  const [ebookUploadBusy, setEbookUploadBusy] = useState(false);
  const [ebookUploadError, setEbookUploadError] = useState<string | null>(null);

  function chooseUploadFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.currentTarget.files ?? []);
    const files = chosen.filter((file) => isSupportedAudioFileName(file.name));
    const skipped = chosen.filter((file) => !isSupportedAudioFileName(file.name));
    setUploadFiles(files);
    setUploadError(
      skipped.length
        ? `Left out ${skipped.map((file) => file.name).join(", ")}: the library takes ${SUPPORTED_AUDIO_EXTENSIONS.join(", ")} files.`
        : null
    );
    if (!uploadBookName.trim() && files.length > 0) {
      setUploadBookName(files[0].name.replace(/\.[^.]+$/, ""));
    }
  }

  async function submitAudiobookUpload(event: React.FormEvent) {
    event.preventDefault();
    if (!uploadBookName.trim() || uploadFiles.length === 0) {
      setUploadError("Enter a book name and choose at least one audiobook file.");
      return;
    }

    setUploadBusy(true);
    setUploadError(null);
    const existingIds = new Set(books.map((book) => book.id));
    try {
      const nextBooks = await uploadAudiobook(uploadBookName.trim(), uploadFiles);
      const uploadedBook = nextBooks.find((book) => !existingIds.has(book.id));
      setBooks(nextBooks);
      reconcileServerBookGains(nextBooks);
      setIsOffline(false);
      setError(null);
      if (uploadedBook) {
        setSelectedBookId(uploadedBook.id);
      }
      setLibrarySource("local");
      setUploadModalOpen(false);
      setUploadBookName("");
      setUploadFiles([]);
    } catch (error) {
      setUploadError(errorMessage(error, "The audiobook could not be uploaded."));
    } finally {
      setUploadBusy(false);
    }
  }

  function chooseEbookUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null;
    const error = file && !file.name.toLowerCase().endsWith(".epub")
      ? "Choose an EPUB (.epub) file."
      : file && (file.size === 0 || file.size > 64 * 1024 * 1024)
        ? "Choose a non-empty EPUB up to 64 MiB." : null;
    setEbookUploadFile(error ? null : file);
    setEbookUploadError(error);
  }

  async function chooseDeviceEbookUpload() {
    setEbookUploadError(null);
    try {
      const picked = await FilePicker.pickFiles({ limit: 1, readData: false });
      const file = picked.files[0] ?? null;
      const error = file && !file.name.toLowerCase().endsWith(".epub")
        ? "Choose an EPUB (.epub) file."
        : file && (file.size === 0 || file.size > 64 * 1024 * 1024)
          ? "Choose a non-empty EPUB up to 64 MiB." : null;
      setEbookUploadFile(error ? null : file);
      setEbookUploadError(error);
    } catch (error) {
      const message = errorMessage(error, "The file picker could not be opened.");
      if (!/cancel/i.test(message)) setEbookUploadError(message);
    }
  }

  async function submitEbookUpload(event: React.FormEvent) {
    event.preventDefault();
    if (!ebookUploadBook || !ebookUploadFile || !ebookUploadFile.name.toLowerCase().endsWith(".epub")) {
      setEbookUploadError("Choose an EPUB (.epub) file.");
      return;
    }
    setEbookUploadBusy(true);
    setEbookUploadError(null);
    try {
      if (ebookUploadBook.source === "device") {
        const paired = await addDeviceEpub(ebookUploadBook.id, ebookUploadFile as PickedFile);
        setBooks((existing) => existing.map((book) => book.id === paired.id ? {
          ...book, readingFile: paired.readingFile, companions: paired.companions
        } : book));
        setEbookUploadBook(null);
        setEbookUploadFile(null);
        return;
      }
      if (!(ebookUploadFile instanceof File)) throw new Error("Choose an EPUB (.epub) file.");
      const nextBooks = await uploadEbook(ebookUploadBook.id, ebookUploadFile);
      const paired = nextBooks.find((book) => book.id === ebookUploadBook.id);
      if (!paired?.readingFile || paired.readingFile.extension !== "epub") {
        throw new Error("The server has not paired the EPUB yet. Refresh the library to check its status.");
      }
      // Upload responses may arrive after playback or device-library updates.
      // Adopt only the paired files; keep current progress and local books.
      setBooks((existing) => existing.map((book) => book.id === paired.id ? {
        ...book, readingFile: paired.readingFile, companions: paired.companions, syncFile: paired.syncFile
      } : book));
      setIsOffline(false);
      setError(null);
      setEbookUploadBook(null);
      setEbookUploadFile(null);
    } catch (error) {
      setEbookUploadError(errorMessage(error, "The EPUB could not be uploaded."));
    } finally {
      setEbookUploadBusy(false);
    }
  }

  return {
    chooseDeviceEbookUpload,
    chooseEbookUpload,
    chooseUploadFiles,
    ebookUploadBook,
    ebookUploadBusy,
    ebookUploadError,
    ebookUploadFile,
    setEbookUploadBook,
    setEbookUploadError,
    setEbookUploadFile,
    setUploadBookName,
    setUploadError,
    setUploadModalOpen,
    submitAudiobookUpload,
    submitEbookUpload,
    uploadBookName,
    uploadBusy,
    uploadError,
    uploadFiles,
    uploadModalOpen
  };
}
