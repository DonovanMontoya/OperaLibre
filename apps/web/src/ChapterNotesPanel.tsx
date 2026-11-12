import { useEffect, useState } from "react";
import { Eye, EyeOff, LoaderCircle, NotebookText, Trash2 } from "lucide-react";
import {
  deleteBookChapterNotes,
  generateBookChapterNotes,
  getBookChapterNotes,
  getChapterNotesStatus,
  type BookChapterNotes,
  type ChapterNote,
  type ChapterNotesStatus
} from "./api";
import { isDemoMode } from "./demo";
import type { Book } from "./types";

/** How long to wait between looks at a book whose notes are being made. */
const GENERATION_POLL_MS = 3_000;

type Reached = "heard" | "current" | "ahead";

function reachedFor(note: ChapterNote, book: Book): Reached {
  const progress = book.progress;
  if (progress?.finishedOverride === true) return "heard";
  const position = progress?.bookPositionSeconds ?? 0;
  const end = note.endSeconds ?? Number.POSITIVE_INFINITY;
  if (end <= position) return "heard";
  return note.startSeconds < position ? "current" : "ahead";
}

/** Chapter notes on a book's page. Summaries past where the listener has got
 * stay hidden until they ask to be spoiled. */
export function ChapterNotesPanel({ book }: { book: Book }) {
  const [status, setStatus] = useState<ChapterNotesStatus | null>(null);
  const [notes, setNotes] = useState<BookChapterNotes | null>(null);
  const [spoilers, setSpoilers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onServer = book.source !== "device" && !isDemoMode();

  useEffect(() => {
    let cancelled = false;
    setNotes(null);
    setSpoilers(false);
    setError(null);
    if (!onServer) return;
    void getChapterNotesStatus().then(loaded => {
      if (cancelled) return;
      setStatus(loaded);
      if (!loaded.enabled) return;
      getBookChapterNotes(book.id).then(loadedNotes => { if (!cancelled) setNotes(loadedNotes); }, () => undefined);
    });
    return () => { cancelled = true; };
  }, [book.id, onServer]);

  const running = notes?.generation?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => {
      getBookChapterNotes(book.id).then(setNotes, () => undefined);
    }, GENERATION_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [book.id, running, notes]);

  if (!onServer || !status?.enabled || !notes) return null;
  if (notes.chapters.length === 0 && !status.canGenerate) return null;

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setNotes(await generateBookChapterNotes(book.id));
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Could not start making notes.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove the chapter notes for ${book.title}?\n\nTranscripts are removed too, so making notes again transcribes the book again.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteBookChapterNotes(book.id);
      setNotes(await getBookChapterNotes(book.id));
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Could not remove the notes.");
    } finally {
      setBusy(false);
    }
  }

  const generation = notes.generation;
  const summarized = notes.chapters.some(note => note.summary);
  return (
    <section className="chapter-notes" aria-label="Chapter notes">
      <div className="chapter-notes-head">
        <span className="section-label"><NotebookText size={13} /> Chapter notes</span>
        {summarized ? (
          <button type="button" className="quiet-button" aria-pressed={spoilers} onClick={() => setSpoilers(value => !value)}>
            {spoilers ? <EyeOff size={13} /> : <Eye size={13} />}
            {spoilers ? "Hide spoilers" : "Show spoilers"}
          </button>
        ) : null}
      </div>
      {notes.chapters.length === 0 && !generation ? (
        <p className="chapter-notes-empty">No notes for this book yet.</p>
      ) : null}
      {notes.chapters.length > 0 && !summarized ? (
        <p className="chapter-notes-empty">
          This book is transcribed, so connected assistants can recap it. Choose a model under Experiments to write notes here too.
        </p>
      ) : null}
      {summarized ? (
        <ol className="chapter-notes-list">
          {notes.chapters.map(note => {
            const reached = reachedFor(note, book);
            const hidden = reached !== "heard" && !spoilers;
            return (
              <li key={note.index} className={reached}>
                <details>
                  <summary>
                    <strong>{note.title}</strong>
                    {reached === "current" ? <em>You are here</em> : null}
                    {note.synopsis ? <span>{note.synopsis}</span> : null}
                  </summary>
                  {hidden ? (
                    <p className="chapter-notes-hidden">
                      {reached === "current" ? "You are partway through this chapter." : "You have not reached this chapter."} Show spoilers to read its summary.
                    </p>
                  ) : (
                    <>
                      {note.summary ? <p>{note.summary}</p> : null}
                      {note.people?.length ? (
                        <>
                          <h4>People</h4>
                          <ul>{note.people.map(person => <li key={person}>{person}</li>)}</ul>
                        </>
                      ) : null}
                      {note.terms?.length ? (
                        <>
                          <h4>Places and terms</h4>
                          <ul>{note.terms.map(term => <li key={term}>{term}</li>)}</ul>
                        </>
                      ) : null}
                      <p className="chapter-notes-source">
                        {note.source === "transcript" ? "From a transcript of the narration" : "From the book's text"}
                        {note.model ? ` · ${note.model}` : ""}
                        {note.textTruncated ? " · written from the first part of a very long chapter" : ""}
                      </p>
                    </>
                  )}
                </details>
              </li>
            );
          })}
        </ol>
      ) : null}
      {generation ? (
        <p className="chapter-notes-status" role={generation.state === "failed" ? "alert" : "status"}>
          {generation.state === "failed"
            ? `Stopped: ${generation.error ?? "something went wrong."}`
            : `${generation.step} · ${generation.completed} of ${generation.total} chapters done`}
        </p>
      ) : null}
      {error ? <p className="chapter-notes-status" role="alert">{error}</p> : null}
      {status.canGenerate ? (
        <div className="chapter-notes-actions">
          <button type="button" className="download-btn" disabled={busy || running} onClick={() => void generate()}>
            {busy || running ? <LoaderCircle size={13} className="spin-icon" /> : <NotebookText size={13} />}
            <span>{running ? "Making notes…" : notes.chapters.length > 0 ? "Update notes" : status.provider ? "Make notes" : "Transcribe"}</span>
          </button>
          {notes.chapters.length > 0 || running ? (
            <button type="button" className="download-btn" disabled={busy} onClick={() => void remove()}>
              <Trash2 size={13} />
              <span>{running ? "Stop and remove" : "Remove"}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
