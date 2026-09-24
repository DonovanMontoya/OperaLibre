import { Pencil, Plus, X } from "lucide-react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import { metadataEditorFromBook, type MetadataEditorState } from "./metadataEditor";
import type { Book } from "./types";

export function MetadataEditorDialog({
  metadataError,
  metadataForm,
  metadataSaving,
  saveMetadata,
  selectedBook,
  setMetadataEditOpen,
  setMetadataError,
  setMetadataForm
}: {
  metadataError: string | null;
  metadataForm: MetadataEditorState;
  metadataSaving: boolean;
  saveMetadata: (event: FormEvent) => Promise<void>;
  selectedBook: Book;
  setMetadataEditOpen: Dispatch<SetStateAction<boolean>>;
  setMetadataError: Dispatch<SetStateAction<string | null>>;
  setMetadataForm: Dispatch<SetStateAction<MetadataEditorState | null>>;
}) {
  return (
    <div className="modal-scrim" role="presentation">
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

        <div className="metadata-edit-form">
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
          <label>
            <span>Series</span>
            <input
              type="text"
              value={metadataForm.series}
              onChange={(event) =>
                setMetadataForm({ ...metadataForm, series: event.currentTarget.value })
              }
            />
          </label>
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
                <input
                  type="text"
                  value={tag.name}
                  aria-label={`Tag ${index + 1} name`}
                  onChange={(event) => setMetadataForm({
                    ...metadataForm,
                    tags: metadataForm.tags.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? { ...candidate, name: event.currentTarget.value }
                        : candidate
                    )
                  })}
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
