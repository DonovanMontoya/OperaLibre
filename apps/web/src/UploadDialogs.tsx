import { BookOpen, LoaderCircle, Upload, X } from "lucide-react";
import type { ChangeEvent, Dispatch, FormEvent, SetStateAction } from "react";
import { SUPPORTED_AUDIO_EXTENSIONS } from "./mediaFiles";
import type { Book } from "./types";

/**
 * Desktop browsers narrow the file dialog from this list. iOS is left
 * unfiltered instead: it resolves `accept` to UTIs and types `.m4b` as
 * `com.apple.protected-mpeg-4-audio-b`, which answers to no audio MIME type at
 * all, so filtering there greys out the audiobooks the picker exists to find.
 * Either way the chosen names are checked before anything is uploaded.
 */
const UPLOAD_FILE_ACCEPT = [
  ...SUPPORTED_AUDIO_EXTENSIONS.map((extension) => `.${extension}`),
  "audio/mp4",
  "audio/x-m4a",
  "audio/x-m4b",
  "audio/*"
].join(",");

const EPUB_FILE_ACCEPT = ".epub,application/epub+zip";

export function AudiobookUploadDialog({
  chooseUploadFiles,
  native,
  setUploadBookName,
  setUploadModalOpen,
  submitAudiobookUpload,
  uploadBookName,
  uploadBusy,
  uploadError,
  uploadFiles
}: {
  chooseUploadFiles: (event: ChangeEvent<HTMLInputElement>) => void;
  native: boolean;
  setUploadBookName: Dispatch<SetStateAction<string>>;
  setUploadModalOpen: Dispatch<SetStateAction<boolean>>;
  submitAudiobookUpload: (event: FormEvent) => Promise<void>;
  uploadBookName: string;
  uploadBusy: boolean;
  uploadError: string | null;
  uploadFiles: File[];
}) {
  return (
    <div className="modal-scrim" role="presentation">
      <form
        className="modal-card upload-audiobook-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-audiobook-title"
        onSubmit={submitAudiobookUpload}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow"><Upload size={13} /> Add to the collection</span>
            <h2 id="upload-audiobook-title">Upload audiobook</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close upload"
            disabled={uploadBusy}
            onClick={() => setUploadModalOpen(false)}
          >
            <X size={16} />
          </button>
        </div>
        <p className="upload-audiobook-hint">
          Choose one file for an M4B or all audio tracks for a multi-file book. Files are kept
          together in a new library folder.
        </p>
        <label className="upload-audiobook-field">
          <span>Book name</span>
          <input
            value={uploadBookName}
            onChange={(event) => setUploadBookName(event.currentTarget.value)}
            placeholder="The name of the library folder"
            maxLength={200}
            required
            disabled={uploadBusy}
          />
        </label>
        <label className="upload-file-picker">
          <Upload size={22} />
          <strong>
            {uploadFiles.length
              ? `${uploadFiles.length} file${uploadFiles.length === 1 ? "" : "s"} selected`
              : "Choose audio files"}
          </strong>
          <span>AAC, AIFF, FLAC, M4A, M4B, MP3, MP4, OGG, Opus, or WAV</span>
          <input
            type="file"
            accept={native ? undefined : UPLOAD_FILE_ACCEPT}
            multiple
            required
            disabled={uploadBusy}
            onChange={chooseUploadFiles}
          />
        </label>
        {uploadFiles.length ? (
          <ul className="upload-file-list">
            {uploadFiles.map((file) => <li key={`${file.name}-${file.size}`}>{file.name}</li>)}
          </ul>
        ) : null}
        {uploadError ? <p className="metadata-edit-error">{uploadError}</p> : null}
        <div className="metadata-edit-actions">
          <button type="button" disabled={uploadBusy} onClick={() => setUploadModalOpen(false)}>Cancel</button>
          <button type="submit" disabled={uploadBusy || uploadFiles.length === 0}>
            {uploadBusy ? <LoaderCircle size={15} className="spin-icon" /> : <Upload size={15} />}
            {uploadBusy ? "Uploading…" : "Upload to library"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function EbookUploadDialog({
  chooseDeviceEbookUpload,
  chooseEbookUpload,
  ebookUploadBook,
  ebookUploadBusy,
  ebookUploadError,
  ebookUploadFile,
  native,
  setEbookUploadBook,
  submitEbookUpload
}: {
  chooseDeviceEbookUpload: () => Promise<void>;
  chooseEbookUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  ebookUploadBook: Book;
  ebookUploadBusy: boolean;
  ebookUploadError: string | null;
  ebookUploadFile: { name: string } | null;
  native: boolean;
  setEbookUploadBook: Dispatch<SetStateAction<Book | null>>;
  submitEbookUpload: (event: FormEvent) => Promise<void>;
}) {
  const onDevice = ebookUploadBook.source === "device";
  return (
    <div className="modal-scrim" role="presentation">
      <form
        className="modal-card upload-audiobook-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-ebook-title"
        onSubmit={submitEbookUpload}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow"><BookOpen size={13} /> Pair with this audiobook</span>
            <h2 id="upload-ebook-title">Add matching EPUB</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close ebook upload"
            disabled={ebookUploadBusy}
            onClick={() => setEbookUploadBook(null)}
          >
            <X size={16} />
          </button>
        </div>
        <p className="upload-audiobook-hint">
          {onDevice ? "Choose an EPUB for " : "Upload the EPUB for "}<strong>{ebookUploadBook.title}</strong>. It stays beside this audiobook and becomes its reading copy.
        </p>
        {onDevice ? <button type="button" className="upload-file-picker" disabled={ebookUploadBusy} onClick={() => void chooseDeviceEbookUpload()}>
          <BookOpen size={22} />
          <strong>{ebookUploadFile ? ebookUploadFile.name : "Choose EPUB file"}</strong>
          <span>Unencrypted EPUB · up to 64 MiB</span>
        </button> : <label className="upload-file-picker">
          <BookOpen size={22} />
          <strong>{ebookUploadFile ? ebookUploadFile.name : "Choose EPUB file"}</strong>
          <span>Unencrypted EPUB · up to 64 MiB</span>
          <input
            type="file"
            accept={native ? undefined : EPUB_FILE_ACCEPT}
            required
            disabled={ebookUploadBusy}
            onChange={chooseEbookUpload}
          />
        </label>}
        {ebookUploadError ? <p className="metadata-edit-error">{ebookUploadError}</p> : null}
        <div className="metadata-edit-actions">
          <button type="button" disabled={ebookUploadBusy} onClick={() => setEbookUploadBook(null)}>Cancel</button>
          <button type="submit" disabled={ebookUploadBusy || !ebookUploadFile}>
            {ebookUploadBusy ? <LoaderCircle size={15} className="spin-icon" /> : <Upload size={15} />}
            {ebookUploadBusy ? (onDevice ? "Adding…" : "Uploading…") : "Add EPUB"}
          </button>
        </div>
      </form>
    </div>
  );
}
