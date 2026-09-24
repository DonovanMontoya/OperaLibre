import { Pencil, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { MetadataSuggestionInput } from "./MetadataSuggestionInput";
import { metadataEditorFromBook, type MetadataEditorState } from "./metadataEditor";
import { existingMetadataNames } from "./metadataSuggestions";
import type { Book } from "./types";

export function MetadataEditorDialog({
  books,
  metadataError,
  metadataForm,
  metadataSaving,
  saveMetadata,
  selectedBook,
  setMetadataEditOpen,
  setMetadataError,
  setMetadataForm
}: {
  books: readonly Book[];
  metadataError: string | null;
  metadataForm: MetadataEditorState;
  metadataSaving: boolean;
  saveMetadata: (event: FormEvent) => Promise<void>;
  selectedBook: Book;
  setMetadataEditOpen: Dispatch<SetStateAction<boolean>>;
  setMetadataError: Dispatch<SetStateAction<string | null>>;
  setMetadataForm: Dispatch<SetStateAction<MetadataEditorState | null>>;
}) {
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

  return (
    <div className="modal-scrim metadata-editor-scrim" role="presentation">
      <form className="modal-card metadata-editor-card" onSubmit={saveMetadata}>
        <div className="modal-head">
          <h2><Pencil size={18} /> Edit Book Info</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close metadata editor"
            onClick={() => {
              setMetadataEditOpen(false);
              setMetadataForm(null);
              setMetadataError(null);
            }}
            disabled={metadataSaving}
          >
            <X size={16} />
          </button>
        </div>

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

        {metadataError ? <p className="metadata-edit-error">{metadataError}</p> : null}

        <div className="metadata-edit-actions">
          <button
            type="button"
            onClick={() => selectedBook && setMetadataForm(metadataEditorFromBook(selectedBook))}
            disabled={metadataSaving || !selectedBook}
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
