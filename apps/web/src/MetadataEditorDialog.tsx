import { Pencil, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MetadataSuggestionInput } from "./MetadataSuggestionInput";
import { existingMetadataNames } from "./metadataSuggestions";
import { CoverArt } from "./CoverArt";
import { COVER_FILE_ACCEPT } from "./bookCover";
import { useModalFocus } from "./useModalFocus";
import type { useMetadataEditor } from "./useMetadataEditor";
import type { Book } from "./types";

export function MetadataEditorDialog({ books, editor }: {
  books: readonly Book[];
  editor: ReturnType<typeof useMetadataEditor>;
}) {
  const { metadataBook, metadataForm, metadataError, metadataSaving, coverFile, coverRemoval,
    chooseCover, removeCover, closeMetadataEditor, resetMetadataEditor, saveMetadata, setMetadataForm } = editor;
  const dialogRef = useModalFocus<HTMLFormElement>(() => { if (!metadataSaving) closeMetadataEditor(); });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!coverFile) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(coverFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [coverFile]);
  const seriesNames = useMemo(() => existingMetadataNames(books, "series"), [books]);
  const tagNames = useMemo(() => existingMetadataNames(books, "tag"), [books]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusedFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const revealFocusedField = useCallback(() => {
    const scroll = scrollRef.current;
    const field = focusedFieldRef.current;
    if (!scroll || !field || document.activeElement !== field) return;
    const viewport = scroll.getBoundingClientRect();
    const target = field.getBoundingClientRect();
    if (target.bottom > viewport.bottom - 12) {
      scroll.scrollTop += target.bottom - viewport.bottom + 12;
    } else if (target.top < viewport.top + 12) {
      scroll.scrollTop -= viewport.top + 12 - target.top;
    }
  }, []);

  const scheduleReveal = useCallback(() => {
    if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
    revealTimerRef.current = setTimeout(revealFocusedField, 100);
  }, [revealFocusedField]);

  useEffect(() => {
    if (!document.documentElement.classList.contains("native-app")) return;
    window.visualViewport?.addEventListener("resize", scheduleReveal);
    return () => {
      window.visualViewport?.removeEventListener("resize", scheduleReveal);
      if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
    };
  }, [scheduleReveal]);

  if (!metadataBook || !metadataForm) return null;

  return (
    <div className="modal-scrim metadata-editor-scrim" role="presentation">
      <form ref={dialogRef} className="modal-card metadata-editor-card" onSubmit={saveMetadata}
        role="dialog" aria-modal="true" aria-labelledby="metadata-editor-title" aria-busy={metadataSaving} tabIndex={-1}>
        <div className="modal-head">
          <h2 id="metadata-editor-title"><Pencil size={18} /> Edit Book Info</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close metadata editor"
            onClick={closeMetadataEditor}
            disabled={metadataSaving}
          >
            <X size={16} />
          </button>
        </div>

        <fieldset disabled={metadataSaving} className="metadata-edit-fields">
        <div
          className="metadata-edit-form"
          ref={scrollRef}
          onFocusCapture={(event) => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
              focusedFieldRef.current = event.target;
              revealFocusedField();
              scheduleReveal();
            }
          }}
        >
          <div className="metadata-cover-field wide" aria-labelledby="metadata-cover-title">
            <div className="metadata-cover-preview">
              {previewUrl ? <img src={previewUrl} alt="Selected cover preview" /> : <CoverArt book={metadataBook} size="small" />}
            </div>
            <div className="metadata-cover-controls">
              <span id="metadata-cover-title">Cover art</span>
              <label>
                <span>{metadataBook.hasCoverOverride ? "Replace cover" : "Choose cover"}</span>
                <input type="file" accept={COVER_FILE_ACCEPT} disabled={metadataSaving}
                  aria-describedby="metadata-cover-help" onChange={(event) => {
                    chooseCover(event.currentTarget.files?.[0] ?? null);
                    event.currentTarget.value = "";
                  }} />
              </label>
              <p id="metadata-cover-help">JPEG, PNG, or WebP, up to 8 MiB and 16 million pixels (8192 pixels per side).</p>
              {metadataBook.hasCoverOverride && !coverRemoval ? (
                <button type="button" onClick={removeCover} disabled={metadataSaving}>Restore original cover</button>
              ) : null}
              <p role="status">{coverRemoval ? "Original cover will be restored when you save." : coverFile ? `${coverFile.name} will replace the cover when you save.` : "Cover changes apply with Save Info."}</p>
            </div>
          </div>
          <label className="wide">
            <span>Title</span>
            <input
              type="text"
              value={metadataForm.title}
              onChange={(event) =>
                setMetadataForm({ ...metadataForm, title: event.currentTarget.value })
              }
              required
            />
          </label>
          <label>
            <span>Author</span>
            <input
              type="text"
              value={metadataForm.author}
              onChange={(event) =>
                setMetadataForm({ ...metadataForm, author: event.currentTarget.value })
              }
            />
          </label>
          <label>
            <span>Narrator</span>
            <input
              type="text"
              value={metadataForm.narrator}
              onChange={(event) =>
                setMetadataForm({ ...metadataForm, narrator: event.currentTarget.value })
              }
            />
          </label>
          <label>
            <span>Publisher</span>
            <input
              type="text"
              value={metadataForm.publisher}
              onChange={(event) =>
                setMetadataForm({ ...metadataForm, publisher: event.currentTarget.value })
              }
            />
          </label>
          <div className="metadata-labeled-field">
            <span>Series</span>
            <MetadataSuggestionInput
              label="Series"
              names={seriesNames}
              suggestionsLabel="Existing series"
              value={metadataForm.series}
              onChange={(series) =>
                setMetadataForm((form) => form ? { ...form, series } : form)
              }
            />
          </div>
          <label>
            <span>Series number</span>
            <input
              type="text"
              value={metadataForm.seriesPosition}
              onChange={(event) =>
                setMetadataForm({ ...metadataForm, seriesPosition: event.currentTarget.value })
              }
              placeholder="1"
            />
          </label>
          <div className="wide metadata-tags-field">
            <div className="metadata-tags-heading">
              <span>Tags</span>
              <button
                type="button"
                onClick={() => setMetadataForm({
                  ...metadataForm,
                  tags: [...metadataForm.tags, { name: "", position: "" }]
                })}
              >
                <Plus size={13} /> Add tag
              </button>
            </div>
            <p>Use tags for wider worlds or reading orders beyond the book’s immediate series.</p>
            {metadataForm.tags.map((tag, index) => (
              <div className="metadata-tag-row" key={index}>
                <MetadataSuggestionInput
                  label={`Tag ${index + 1} name`}
                  names={tagNames}
                  suggestionsLabel="Existing tags"
                  value={tag.name}
                  onChange={(name) => setMetadataForm((form) => form ? {
                    ...form,
                    tags: form.tags.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? { ...candidate, name }
                        : candidate
                    )
                  } : form)}
                  placeholder="Cosmere"
                />
                <input
                  className="metadata-tag-position"
                  type="text"
                  value={tag.position}
                  aria-label={`Tag ${index + 1} book number`}
                  onChange={(event) => setMetadataForm({
                    ...metadataForm,
                    tags: metadataForm.tags.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? { ...candidate, position: event.currentTarget.value }
                        : candidate
                    )
                  })}
                  placeholder="Book # (optional)"
                />
                <button
                  type="button"
                  className="metadata-tag-remove"
                  aria-label={`Remove ${tag.name || `tag ${index + 1}`}`}
                  onClick={() => setMetadataForm({
                    ...metadataForm,
                    tags: metadataForm.tags.filter((_, candidateIndex) => candidateIndex !== index)
                  })}
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
          <label>
            <span>Published date</span>
            <input
              type="text"
              value={metadataForm.publishedDate}
              onChange={(event) =>
                setMetadataForm({ ...metadataForm, publishedDate: event.currentTarget.value })
              }
              placeholder="YYYY-MM-DD or year"
            />
          </label>
          <label className="wide">
            <span>Genres</span>
            <input
              type="text"
              value={metadataForm.genres}
              onChange={(event) =>
                setMetadataForm({ ...metadataForm, genres: event.currentTarget.value })
              }
              placeholder="Fantasy, Adventure"
            />
          </label>
          <label className="wide">
            <span>Audible ASIN</span>
            <input
              type="text"
              value={metadataForm.asin}
              onChange={(event) =>
                setMetadataForm({ ...metadataForm, asin: event.currentTarget.value })
              }
              placeholder="B012345678"
            />
          </label>
          <label className="wide">
            <span>Description</span>
            <textarea
              value={metadataForm.description}
              onChange={(event) =>
                setMetadataForm({ ...metadataForm, description: event.currentTarget.value })
              }
              rows={7}
            />
          </label>
        </div>

        </fieldset>

        {metadataError ? <p className="metadata-edit-error" role="alert">{metadataError}</p> : null}

        <div className="metadata-edit-actions">
          <button
            type="button"
            onClick={resetMetadataEditor}
            disabled={metadataSaving}
          >
            Reset
          </button>
          <button type="submit" disabled={metadataSaving}>
            {metadataSaving ? "Saving..." : "Save Info"}
          </button>
        </div>
      </form>
    </div>
  );
}
