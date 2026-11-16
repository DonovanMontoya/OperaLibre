import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, FlaskConical, LoaderCircle, Play, Square, Trash2 } from "lucide-react";
import {
  auditionVoice,
  clearVoiceProject,
  findVoiceSpeakers,
  getBooks,
  getOriginalVoiceClip,
  getVoiceEstimate,
  getVoiceLines,
  getVoiceProject,
  getVoiceReplacementStatus,
  listReplacementVoices,
  makeVoiceCopy,
  previewVoiceEdit,
  removeVoiceCopy,
  removeVoiceReplacementKey,
  saveVoicePlan,
  saveVoiceReplacementKey,
  setVoiceReplacementEnabled,
  stopVoiceRun,
  type ReplacementVoice,
  type VoiceCastMember,
  type VoiceChapter,
  type VoiceChoice,
  type VoiceEdit,
  type VoiceEstimate,
  type VoiceLine,
  type VoicePassage,
  type VoiceProject,
  type VoiceReplacementStatus,
  type VoiceSettings,
  type VoiceStretch
} from "./api";
import { ExperimentSection } from "./ExperimentSection";
import { errorMessage, formatDurationLabel, formatTime } from "./formatting";
import type { Book } from "./types";

/** How many matching lines a chapter shows at once. A long chapter has thousands. */
const LINES_SHOWN = 60;
/** How much of a stretch is tried at once, and how much of the book is heard before it. */
const TRY_SECONDS = 20;
const TRY_LEAD_SECONDS = 4;
const CREDITS_PER_MINUTE = 1000;
/** What transcribing a minute of audio has cost in practice. ElevenLabs does not publish it per credit. */
const TRANSCRIBE_CREDITS_PER_MINUTE = 40;
/** What the voice changer uses when a voice has no saved settings of its own. */
const DEFAULT_SETTINGS: VoiceSettings = { stability: 0.5, similarity: 0.75, style: 0, removeNoise: false };

const sameName = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();
/** Whether a spoken heading names someone: their name, or their name among other words. */
const headingNames = (heading: string, name: string) => {
  const wanted = name.trim().toLowerCase();
  return wanted !== "" && (sameName(heading, name) || heading.toLowerCase().split(/[^\p{L}\p{N}'’-]+/u).includes(wanted));
};
const overlaps = (stretch: VoiceStretch, other: VoiceStretch) =>
  stretch.startSeconds < other.endSeconds && stretch.endSeconds > other.startSeconds;
const passageLabel = (passage: VoicePassage) => passage.headings.join(" · ") || "Opening";

/** The switch for voice replacement, the owner's ElevenLabs key, and the studio. */
export function VoiceReplacementExperiment({
  isOwner,
  books,
  onOpenBook,
  onBooksChanged
}: {
  isOwner: boolean;
  books: Book[];
  onOpenBook?: (bookId: string) => void;
  onBooksChanged: (books: Book[]) => void;
}) {
  const [status, setStatus] = useState<VoiceReplacementStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getVoiceReplacementStatus()
      .then(loaded => { if (!cancelled) setStatus(loaded); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  async function apply(change: () => Promise<VoiceReplacementStatus>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await change());
      setApiKey("");
    } catch (failure) {
      setError(errorMessage(failure, fallback));
    } finally {
      setBusy(false);
    }
  }

  function toggle() {
    if (!status) return;
    if (status.enabled && !window.confirm("Turn off voice replacement?\n\nWork in progress stops. Plans, saved clips, and copies already made are kept.")) return;
    void apply(() => setVoiceReplacementEnabled(!status.enabled), "Could not change voice replacement.");
  }

  function saveKey(event: FormEvent) {
    event.preventDefault();
    void apply(() => saveVoiceReplacementKey(apiKey.trim()), "Could not save the ElevenLabs key.");
  }

  return (
    <article>
      <div className="admin-software-version-head">
        <div>
          <span>Voice replacement</span>
          <strong>{status === null ? "Checking…" : !status.enabled ? "Off" : status.hasApiKey ? "On" : "On, needs an ElevenLabs key"}</strong>
        </div>
        {status?.enabled ? (
          <span className="admin-current-badge"><Check size={12} /> Enabled</span>
        ) : (
          <span className="admin-experimental-badge">Optional</span>
        )}
      </div>
      <p>
        Make a second copy of a book with a narrator you would rather not hear in another voice, a single line
        delivered differently, or the whole book revoiced, using your own ElevenLabs account. The original book is
        never changed, and the copy appears in the library as its own book.
      </p>
      <p className="admin-experiment-detail">
        The parts of a book you work on are sent to ElevenLabs as audio and text, under its terms, and billed to your
        key. Nothing is sent until an administrator asks for it. For your own listening: only use voices and books you
        have the right to use this way.
        {status?.enabled && !status.audioToolsAvailable ? " This server has no ffmpeg, which cutting and rewriting audio needs." : ""}
      </p>
      {error ? <p className="admin-experiment-detail" role="alert">{error}</p> : null}
      {isOwner ? (
        <div className="admin-update-actions">
          <button type="button" className={status?.enabled ? "quiet-button" : undefined} disabled={status === null || busy} onClick={toggle}>
            {busy ? <LoaderCircle size={15} className="spin-icon" /> : <FlaskConical size={15} />}
            {status?.enabled ? "Disable" : "Enable"}
          </button>
        </div>
      ) : null}
      {status?.enabled && isOwner ? (
        <form className="chapter-notes-provider" onSubmit={saveKey}>
          <fieldset disabled={busy}>
            <legend>ElevenLabs account</legend>
            <label>
              <span>API key</span>
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={status.hasApiKey ? "Saved. Paste a new key to replace it." : ""}
                onChange={event => setApiKey(event.target.value)}
                required
              />
            </label>
            <p className="admin-experiment-detail">
              Saving a key confirms that book audio and text may be sent to ElevenLabs. The key stays on this server.
              It needs access to voices, speech to text, voice changer, and text to speech.
            </p>
            <div className="admin-update-actions">
              <button type="submit" disabled={!apiKey.trim()}>Save key</button>
              {status.hasApiKey ? (
                <button type="button" className="quiet-button" onClick={() => void apply(removeVoiceReplacementKey, "Could not remove the key.")}>Remove key</button>
              ) : null}
            </div>
          </fieldset>
        </form>
      ) : null}
      {status?.enabled && status.hasApiKey ? (
        <ExperimentSection title="Replace voices in a book">
          <VoiceStudio books={books} onOpenBook={onOpenBook} onBooksChanged={onBooksChanged} />
        </ExperimentSection>
      ) : null}
    </article>
  );
}

/** "Narrator A", by how much of the chapter each one reads. */
function narratorName(chapter: VoiceChapter, speaker: string) {
  const at = chapter.speakers?.findIndex(candidate => candidate.id === speaker) ?? -1;
  return at < 0 ? "A narrator" : `Narrator ${String.fromCharCode(65 + (at % 26))}`;
}

function describeEdit(edit: VoiceEdit, chapters: VoiceChapter[]) {
  const chapter = chapters.find(candidate => candidate.index === edit.chapter);
  const where = chapter?.title ?? `Chapter ${edit.chapter + 1}`;
  if (edit.kind === "speaker") return `${where}: ${chapter ? narratorName(chapter, edit.speaker) : "a narrator"} becomes ${edit.voice.name}`;
  if (edit.kind === "chapter") return `${where}: ${edit.method === "readText" ? "read from its text by" : "everyone becomes"} ${edit.voice.name}`;
  if (edit.kind === "keep") return `${where} at ${formatTime(edit.startSeconds)}: ${formatTime(edit.endSeconds - edit.startSeconds)} kept as it is`;
  return `${where} at ${formatTime(edit.startSeconds)}: ${edit.text ? `${edit.voice.name} says "${edit.text}"` : `this line becomes ${edit.voice.name}`}`;
}

function VoiceStudio({
  books,
  onOpenBook,
  onBooksChanged
}: {
  books: Book[];
  onOpenBook?: (bookId: string) => void;
  onBooksChanged: (books: Book[]) => void;
}) {
  const [bookId, setBookId] = useState("");
  const [project, setProject] = useState<VoiceProject | null>(null);
  const [voices, setVoices] = useState<ReplacementVoice[] | null>(null);
  const [creditsLeft, setCreditsLeft] = useState<number | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [estimate, setEstimate] = useState<VoiceEstimate | null>(null);
  const [openChapter, setOpenChapter] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const clipUrl = useRef<string | null>(null);

  const sortedBooks = useMemo(() => [...books].sort((a, b) => a.title.localeCompare(b.title)), [books]);
  const voice: VoiceChoice | null = useMemo(() => {
    const found = voices?.find(candidate => candidate.voiceId === voiceId);
    return found ? { voiceId: found.voiceId, name: found.name } : null;
  }, [voices, voiceId]);
  const running = project?.run?.state === "running";
  const planKey = JSON.stringify([project?.edits ?? [], project?.cast ?? []]);

  const stopPlaying = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
    clipUrl.current = null;
    setPlaying(null);
  }, []);
  useEffect(() => stopPlaying, [stopPlaying]);

  /** Plays a clip, or stops it when it is the one playing. */
  async function play(key: string, load: () => Promise<Blob>) {
    const wasPlaying = playing === key;
    stopPlaying();
    if (wasPlaying) return;
    setPlaying(key);
    setError(null);
    try {
      const url = URL.createObjectURL(await load());
      const element = new Audio(url);
      clipUrl.current = url;
      audio.current = element;
      element.addEventListener("ended", () => { if (audio.current === element) stopPlaying(); });
      await element.play();
    } catch (failure) {
      stopPlaying();
      setError(errorMessage(failure, "Could not play that."));
    }
  }

  useEffect(() => {
    let cancelled = false;
    void listReplacementVoices()
      .then(loaded => {
        if (cancelled) return;
        setVoices(loaded.voices);
        setCreditsLeft(loaded.creditsLeft ?? null);
        setVoiceId(current => current || loaded.voices[0]?.voiceId || "");
      })
      .catch(failure => { if (!cancelled) setError(errorMessage(failure, "Could not load your ElevenLabs voices.")); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setProject(null);
    setEstimate(null);
    setOpenChapter(null);
    if (!bookId) return;
    let cancelled = false;
    void getVoiceProject(bookId)
      .then(loaded => { if (!cancelled) setProject(loaded); })
      .catch(failure => { if (!cancelled) setError(errorMessage(failure, "Could not open that book.")); });
    return () => { cancelled = true; };
  }, [bookId]);

  // Follow work in progress. A finished copy is a new book in the library.
  useEffect(() => {
    if (!bookId || !running) return;
    const kind = project?.run?.kind;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getVoiceProject(bookId).then(async next => {
        if (cancelled) return;
        setProject(next);
        if (kind === "render" && next.run?.state !== "running") onBooksChanged(await getBooks());
      }).catch(() => undefined);
    }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
    // `onBooksChanged` is a state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, running, project?.run?.kind]);

  useEffect(() => {
    setEstimate(null);
    if (!bookId || planKey === "[[],[]]") return;
    let cancelled = false;
    void getVoiceEstimate(bookId).then(loaded => { if (!cancelled) setEstimate(loaded); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [bookId, planKey]);

  async function act(change: () => Promise<VoiceProject>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      setProject(await change());
    } catch (failure) {
      setError(errorMessage(failure, fallback));
    } finally {
      setBusy(false);
    }
  }

  function savePlan(edits: VoiceEdit[], cast: VoiceCastMember[] = project?.cast ?? []) {
    return act(() => saveVoicePlan(bookId, edits, cast), "Could not save the plan.");
  }

  function saveCast(cast: VoiceCastMember[]) {
    return savePlan(project?.edits ?? [], cast);
  }

  /** Every passage in the chapters transcribed so far that opens with this name. */
  function passagesNamed(name: string) {
    return (project?.chapters ?? []).flatMap(chapter =>
      (chapter.passages ?? []).filter(passage => passage.headings.some(heading => headingNames(heading, name)))
    );
  }

  /** Adds stretches to a voice in the cast, making the voice if it is new. */
  function addToCast(name: string, stretches: VoiceStretch[]) {
    if (!project) return;
    const at = project.cast.findIndex(member => sameName(member.name, name));
    const fresh = (member: VoiceCastMember) =>
      stretches.filter(stretch => !member.stretches.some(other => overlaps(stretch, other)));
    if (at >= 0) {
      void saveCast(project.cast.map((member, other) =>
        other === at ? { ...member, stretches: [...member.stretches, ...fresh(member)] } : member
      ));
    } else if (voice) {
      void saveCast([...project.cast, { name, voice, stretches }]);
    }
  }

  /** Adds an edit in place of any earlier one for the same narrator, line or chapter. */
  function addEdit(edit: VoiceEdit) {
    if (!project) return;
    const same = (other: VoiceEdit) =>
      other.kind === edit.kind && other.chapter === edit.chapter && (
        (edit.kind === "speaker" && other.kind === "speaker" && other.speaker === edit.speaker) ||
        (edit.kind === "line" && other.kind === "line" && other.startSeconds === edit.startSeconds) ||
        (edit.kind === "keep" && other.kind === "keep" && other.startSeconds === edit.startSeconds) ||
        edit.kind === "chapter"
      );
    void savePlan([...project.edits.filter(other => !same(other)), edit]);
  }

  function findSpeakers(chapters: number[]) {
    const minutes = Math.round(
      (project?.chapters ?? [])
        .filter(chapter => chapters.includes(chapter.index))
        .reduce((sum, chapter) => sum + chapter.endSeconds - chapter.startSeconds, 0) / 60
    );
    const credits = (Math.max(1, minutes) * TRANSCRIBE_CREDITS_PER_MINUTE).toLocaleString();
    if (!window.confirm(`Send about ${minutes} minutes of this book's audio to ElevenLabs to be transcribed?\n\nElevenLabs bills transcription by the length of the audio: expect about ${credits} credits. A chapter already transcribed is not sent again.`)) return;
    void act(() => findVoiceSpeakers(bookId, chapters), "Could not start finding narrators.");
  }

  function makeCopy() {
    if (!estimate) return;
    const left = creditsLeft === null ? "" : ` Your plan has about ${creditsLeft.toLocaleString()} left this period.`;
    if (!window.confirm(`Make a revoiced copy of this book?\n\nThis uses up to ${estimate.credits.toLocaleString()} ElevenLabs credits.${left} Clips already made are not billed again.`)) return;
    void act(() => makeVoiceCopy(bookId), "Could not start making the copy.");
  }

  async function removeCopy(copyId: string, folder: string) {
    if (!window.confirm(`Remove "${folder}" from the library?\n\nThe revoiced copy's files are deleted. The original book is not touched.`)) return;
    await act(() => removeVoiceCopy(bookId, copyId), "Could not remove that copy.");
    onBooksChanged(await getBooks());
  }

  async function clearWork() {
    if (!window.confirm("Clear this book's plan, transcripts, and saved clips?\n\nCopies already made stay in the library. Making the same changes again will be billed again.")) return;
    setBusy(true);
    setError(null);
    try {
      await clearVoiceProject(bookId);
      setProject(await getVoiceProject(bookId));
    } catch (failure) {
      setError(errorMessage(failure, "Could not clear the saved work."));
    } finally {
      setBusy(false);
    }
  }

  const unanalysed = project?.chapters.filter(chapter => !chapter.speakers).map(chapter => chapter.index) ?? [];
  // What was said as a heading, most heard first, less what the cast already covers.
  // Not every heading is a name: a chapter's title or a date is one too.
  const namesFound = useMemo(() => {
    const found = new Map<string, { name: string; seconds: number; count: number }>();
    for (const chapter of project?.chapters ?? []) {
      for (const passage of chapter.passages ?? []) {
        // A part someone in the cast already covers has nothing left to offer.
        if ((project?.cast ?? []).some(member => member.stretches.some(stretch => overlaps(stretch, passage)))) continue;
        for (const heading of passage.headings) {
          const entry = found.get(heading.toLowerCase()) ?? { name: heading, seconds: 0, count: 0 };
          entry.seconds += passage.endSeconds - passage.startSeconds;
          entry.count += 1;
          found.set(heading.toLowerCase(), entry);
        }
      }
    }
    return [...found.values()]
      .filter(entry => !(project?.cast ?? []).some(member => sameName(member.name, entry.name)))
      .sort((a, b) => b.seconds - a.seconds);
  }, [project]);
  const run = project?.run;
  return (
    <div className="voice-studio">
      <label>
        <span>Book</span>
        <select value={bookId} onChange={event => { stopPlaying(); setBookId(event.target.value); }}>
          <option value="">Choose a book…</option>
          {sortedBooks.map(book => <option key={book.id} value={book.id}>{book.title}</option>)}
        </select>
      </label>
      <label>
        <span>Voice to use</span>
        <select value={voiceId} onChange={event => setVoiceId(event.target.value)} disabled={!voices?.length}>
          {voices === null ? <option value="">Loading your voices…</option> : null}
          {voices?.length === 0 ? <option value="">No voices in this ElevenLabs account</option> : null}
          {voices?.map(candidate => (
            <option key={candidate.voiceId} value={candidate.voiceId}>
              {candidate.name}{candidate.category ? ` (${candidate.category})` : ""}
            </option>
          ))}
        </select>
      </label>
      {error ? <p className="admin-experiment-detail" role="alert">{error}</p> : null}

      {run ? (
        <div className="voice-studio-run" role="status">
          <p>
            {run.state === "failed"
              ? `${run.kind === "render" ? "Making the copy" : "Finding narrators"} stopped: ${run.error ?? "something went wrong."} Clips already made are kept, so trying again picks up where it stopped.`
              : `${run.step} (${run.completed} of ${run.total} chapters done)`}
          </p>
          <div className="admin-update-actions">
            <button type="button" className="quiet-button" disabled={busy} onClick={() => void act(() => stopVoiceRun(bookId), "Could not stop.")}>
              {run.state === "failed" ? "Dismiss" : <><Square size={13} /> Stop</>}
            </button>
          </div>
        </div>
      ) : null}

      {project ? (
        <>
          <p className="admin-experiment-detail">
            Open a chapter to change one narrator, one line, or all of it. Finding a chapter's narrators transcribes it,
            which tells narrators apart by voice; one narrator doing several characters counts as one.
          </p>
          {unanalysed.length > 1 ? (
            <div className="admin-update-actions">
              <button type="button" className="quiet-button" disabled={busy || running} onClick={() => findSpeakers(unanalysed)}>
                Find narrators in every chapter
              </button>
              {voice ? (
                <button
                  type="button"
                  className="quiet-button"
                  disabled={busy || running}
                  onClick={() => void savePlan([
                    ...project.edits.filter(edit => edit.kind !== "chapter"),
                    ...project.chapters.map(chapter => ({ kind: "chapter" as const, chapter: chapter.index, voice, method: "keepPerformance" as const }))
                  ])}
                >
                  Revoice the whole book as {voice.name}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="voice-studio-plan">
            <strong>Cast</strong>
            <p className="admin-experiment-detail">
              To replace one character's narrator through the whole book, add them here. A voice in the cast is replaced
              over exactly the stretches listed under it and nowhere else. Where a book opens each character's part by
              saying their name, those parts are found when a chapter is transcribed and offered below.
            </p>
            {namesFound.length > 0 ? (
              <div className="admin-update-actions">
                {namesFound.slice(0, 24).map(entry => (
                  <button
                    key={entry.name}
                    type="button"
                    className="quiet-button"
                    disabled={busy || running || !voice}
                    onClick={() => addToCast(entry.name, passagesNamed(entry.name).map(({ startSeconds, endSeconds }) => ({ startSeconds, endSeconds })))}
                  >
                    {entry.name}<small> · {formatDurationLabel(entry.seconds)}{entry.count > 1 ? ` in ${entry.count} parts` : ""}</small>
                  </button>
                ))}
              </div>
            ) : project.cast.length === 0 ? (
              <p className="admin-experiment-detail">
                No names found yet. Find the narrators in a chapter, or open a chapter and add one of its parts to a voice.
              </p>
            ) : null}
            {project.cast.map((member, at) => (
              <CastMemberEditor
                key={member.id ?? at}
                bookId={bookId}
                member={member}
                chapters={project.chapters}
                voices={voices ?? []}
                suggested={passagesNamed(member.name).filter(passage => !member.stretches.some(stretch => overlaps(stretch, passage)))}
                credits={estimate?.cast.find(entry => entry.id === member.id)?.credits}
                disabled={busy || running}
                playing={playing}
                onPlay={play}
                onChange={next => void saveCast(project.cast.map((other, index) => index === at ? next : other))}
                onRemove={() => void saveCast(project.cast.filter((_, index) => index !== at))}
              />
            ))}
          </div>

          <ul className="voice-studio-chapters">
            {project.chapters.map(chapter => (
              <li key={chapter.index}>
                <button
                  type="button"
                  className="voice-studio-chapter"
                  aria-expanded={openChapter === chapter.index}
                  onClick={() => setOpenChapter(openChapter === chapter.index ? null : chapter.index)}
                >
                  <span>{chapter.title}</span>
                  <small>
                    {formatDurationLabel(chapter.endSeconds - chapter.startSeconds)}
                    {chapter.speakers ? ` · ${chapter.speakers.length} ${chapter.speakers.length === 1 ? "narrator" : "narrators"}` : ""}
                    {project.edits.some(edit => edit.chapter === chapter.index) || project.cast.some(member => member.stretches.some(stretch => overlaps(stretch, chapter))) ? " · in the plan" : ""}
                  </small>
                </button>
                {openChapter === chapter.index ? (
                  <ChapterEditor
                    bookId={bookId}
                    chapter={chapter}
                    voice={voice}
                    cast={project.cast}
                    disabled={busy || running}
                    playing={playing}
                    onPlay={play}
                    onFindSpeakers={() => findSpeakers([chapter.index])}
                    onAdd={addEdit}
                    onAddToCast={addToCast}
                  />
                ) : null}
              </li>
            ))}
          </ul>

          <div className="voice-studio-plan">
            <strong>Plan</strong>
            {project.edits.length === 0 && project.cast.length === 0 ? (
              <p className="admin-experiment-detail">Nothing yet. Changes you choose above are listed here before anything is made.</p>
            ) : (
              <ul>
                {project.cast.map((member, at) => (
                  <li key={member.id ?? `cast-${at}`}>
                    <span>
                      {member.name} becomes {member.voice.name}:{" "}
                      {formatDurationLabel(member.stretches.reduce((sum, stretch) => sum + stretch.endSeconds - stretch.startSeconds, 0))} in{" "}
                      {member.stretches.length} {member.stretches.length === 1 ? "stretch" : "stretches"}
                    </span>
                  </li>
                ))}
                {project.edits.map((edit, at) => (
                  <li key={edit.id ?? at}>
                    <span>{describeEdit(edit, project.chapters)}</span>
                    <button
                      type="button"
                      className="quiet-button"
                      aria-label="Remove from the plan"
                      disabled={busy || running}
                      onClick={() => void savePlan(project.edits.filter((_, other) => other !== at))}
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {estimate && (project.edits.length > 0 || project.cast.length > 0) ? (
              <p className="admin-experiment-detail">
                {estimate.voiceChangerSeconds > 0 ? `${formatDurationLabel(estimate.voiceChangerSeconds)} through the voice changer` : ""}
                {estimate.voiceChangerSeconds > 0 && estimate.speechCharacters > 0 ? " and " : ""}
                {estimate.speechCharacters > 0 ? `${estimate.speechCharacters.toLocaleString()} characters spoken afresh` : ""}
                {`: up to ${estimate.credits.toLocaleString()} ElevenLabs credits.`}
                {creditsLeft !== null ? ` About ${creditsLeft.toLocaleString()} left this period.` : ""}
                {estimate.chaptersWithoutText.length > 0 ? ` No text yet for ${estimate.chaptersWithoutText.join(", ")}: find its narrators first, which also transcribes it.` : ""}
              </p>
            ) : null}
            <div className="admin-update-actions">
              <button type="button" disabled={busy || running || !estimate || estimate.chaptersChanged === 0 || estimate.chaptersWithoutText.length > 0} onClick={makeCopy}>
                {running && run?.kind === "render" ? <LoaderCircle size={15} className="spin-icon" /> : null}
                Make the revoiced copy
              </button>
              <button type="button" className="quiet-button" disabled={busy || running} onClick={() => void clearWork()}>Clear saved work</button>
            </div>
          </div>

          {project.copies.length > 0 ? (
            <div className="voice-studio-plan">
              <strong>Copies made</strong>
              <ul>
                {project.copies.map(copy => (
                  <li key={copy.id}>
                    <span>
                      {copy.folder}
                      <small> · {new Date(copy.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}{copy.bookId ? "" : " · not in the library"}</small>
                    </span>
                    {copy.bookId && onOpenBook ? (
                      <button type="button" className="quiet-button" onClick={() => onOpenBook(copy.bookId!)}>Open</button>
                    ) : null}
                    <button type="button" className="quiet-button" aria-label={`Remove ${copy.folder}`} disabled={busy || running} onClick={() => void removeCopy(copy.id, copy.folder)}>
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : bookId && !error ? <p className="admin-experiment-detail">Opening…</p> : null}
    </div>
  );
}

function PlayButton({ label, active, disabled, onClick }: { label: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="quiet-button" disabled={disabled} onClick={onClick}>
      {active ? <Square size={13} /> : <Play size={13} />} {active ? "Stop" : label}
    </button>
  );
}

function ChapterEditor({
  bookId,
  chapter,
  voice,
  cast,
  disabled,
  playing,
  onPlay,
  onFindSpeakers,
  onAdd,
  onAddToCast
}: {
  bookId: string;
  chapter: VoiceChapter;
  voice: VoiceChoice | null;
  cast: VoiceCastMember[];
  disabled: boolean;
  playing: string | null;
  onPlay: (key: string, load: () => Promise<Blob>) => Promise<void>;
  onFindSpeakers: () => void;
  onAdd: (edit: VoiceEdit) => void;
  onAddToCast: (name: string, stretches: VoiceStretch[]) => void;
}) {
  const [lines, setLines] = useState<VoiceLine[] | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<VoiceLine | null>(null);
  const [text, setText] = useState("");
  const [perform, setPerform] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const analysed = chapter.speakers !== undefined;

  function showLines() {
    setLoadError(null);
    void getVoiceLines(bookId, chapter.index)
      .then(setLines)
      .catch(failure => setLoadError(errorMessage(failure, "Could not load this chapter's lines.")));
  }

  const matches = useMemo(() => {
    const wanted = search.trim().toLowerCase();
    return (lines ?? []).filter(line => !wanted || line.text.toLowerCase().includes(wanted));
  }, [lines, search]);

  function lineEdit(line: VoiceLine): VoiceEdit | null {
    if (!voice) return null;
    return {
      kind: "line",
      chapter: chapter.index,
      startSeconds: line.startSeconds,
      endSeconds: line.endSeconds,
      voice,
      ...(perform && text.trim() ? { text: text.trim() } : {})
    };
  }

  const preview = (key: string, edit: VoiceEdit | null) => {
    if (edit) void onPlay(key, () => previewVoiceEdit(bookId, edit));
  };
  const wholeChapter = (method: "keepPerformance" | "readText"): VoiceEdit | null =>
    voice ? { kind: "chapter", chapter: chapter.index, voice, method } : null;

  return (
    <div className="voice-studio-chapter-body">
      {!voice ? <p className="admin-experiment-detail">Choose a voice above first.</p> : null}

      <strong>Narrators</strong>
      {analysed ? (
        <ul>
          {chapter.speakers!.map(speaker => {
            const edit: VoiceEdit | null = voice ? { kind: "speaker", chapter: chapter.index, speaker: speaker.id, voice } : null;
            const original = `original:${chapter.index}:${speaker.id}`;
            const changed = `speaker:${chapter.index}:${speaker.id}:${voice?.voiceId}`;
            return (
              <li key={speaker.id}>
                <span>{narratorName(chapter, speaker.id)}<small> · {formatTime(speaker.seconds)} of speech</small></span>
                <PlayButton label="Listen" active={playing === original} onClick={() => void onPlay(original, () => getOriginalVoiceClip(bookId, speaker.sampleStartSeconds, speaker.sampleEndSeconds))} />
                <PlayButton label={`Hear as ${voice?.name ?? "…"}`} active={playing === changed} disabled={!voice} onClick={() => preview(changed, edit)} />
                <button type="button" disabled={disabled || !edit} onClick={() => edit && onAdd(edit)}>Replace</button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="admin-update-actions">
          <button type="button" className="quiet-button" disabled={disabled} onClick={onFindSpeakers}>Find the narrators in this chapter</button>
        </div>
      )}

      {chapter.passages && (chapter.passages.length > 1 || chapter.passages[0]?.headings.length) ? (
        <>
          <strong>Parts of this chapter</strong>
          <ul>
            {chapter.passages.map(passage => {
              const key = `passage:${passage.startSeconds}`;
              const owner = cast.find(member => member.stretches.some(stretch => overlaps(stretch, passage)));
              const own = passage.headings.filter(heading => !cast.some(member => sameName(member.name, heading)));
              return (
                <li key={passage.startSeconds}>
                  <span>
                    {passageLabel(passage)}
                    <small> · {formatTime(passage.startSeconds)} · {formatDurationLabel(passage.endSeconds - passage.startSeconds)}{owner ? ` · replaced as ${owner.name}` : ""}</small>
                  </span>
                  <PlayButton label="Listen" active={playing === key} onClick={() => void onPlay(key, () => getOriginalVoiceClip(bookId, passage.startSeconds, Math.min(passage.endSeconds, passage.startSeconds + 15)))} />
                  {owner ? null : (
                    <select
                      aria-label={`Add ${passageLabel(passage)} to a voice in the cast`}
                      value=""
                      disabled={disabled || (cast.length === 0 && (!voice || own.length === 0))}
                      onChange={event => { if (event.target.value) onAddToCast(event.target.value, [{ startSeconds: passage.startSeconds, endSeconds: passage.endSeconds }]); }}
                    >
                      <option value="">Add to the cast…</option>
                      {cast.map(member => <option key={member.id ?? member.name} value={member.name}>{member.name}</option>)}
                      {voice ? own.map(heading => <option key={heading} value={heading}>New voice: {heading}</option>) : null}
                    </select>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="admin-experiment-detail">
            A part runs from one spoken heading to the next. Listen before adding one: a short line with a pause either
            side can be taken for a heading.
          </p>
        </>
      ) : null}

      <strong>The whole chapter</strong>
      <div className="admin-update-actions">
        <button type="button" className="quiet-button" disabled={disabled || !voice} onClick={() => { const edit = wholeChapter("keepPerformance"); if (edit) onAdd(edit); }}>
          Same performance, as {voice?.name ?? "…"}
        </button>
        <button type="button" className="quiet-button" disabled={disabled || !voice} onClick={() => { const edit = wholeChapter("readText"); if (edit) onAdd(edit); }}>
          Read afresh from the text
        </button>
        <PlayButton label="Hear the reading" active={playing === `read:${chapter.index}:${voice?.voiceId}`} disabled={!voice} onClick={() => preview(`read:${chapter.index}:${voice?.voiceId}`, wholeChapter("readText"))} />
      </div>
      <p className="admin-experiment-detail">
        Keeping the performance holds the original timing and delivery. Reading afresh uses the book's own text when it
        has a follow-along map and this chapter's transcript otherwise, and changes the chapter's length. Hearing a
        sample is billed like any other clip.
      </p>

      {analysed ? (
        <>
          <strong>One line</strong>
          {lines === null ? (
            <div className="admin-update-actions">
              <button type="button" className="quiet-button" onClick={showLines}>Show this chapter's lines</button>
            </div>
          ) : (
            <>
              <label>
                <span>Find a line</span>
                <input type="search" value={search} placeholder="Words from the line" onChange={event => setSearch(event.target.value)} />
              </label>
              <ul className="voice-studio-lines">
                {matches.slice(0, LINES_SHOWN).map(line => {
                  const key = `line:${line.startSeconds}`;
                  const open = editing?.startSeconds === line.startSeconds;
                  return (
                    <li key={line.startSeconds}>
                      <button type="button" className="voice-studio-line" aria-expanded={open} onClick={() => { setEditing(open ? null : line); setText(line.text); setPerform(false); }}>
                        <small>{formatTime(line.startSeconds)} · {narratorName(chapter, line.speaker)}</small>
                        <span>{line.text}</span>
                      </button>
                      {open ? (
                        <div className="voice-studio-line-editor">
                          <label className="voice-studio-check">
                            <input type="radio" name={`delivery-${chapter.index}`} checked={!perform} onChange={() => setPerform(false)} />
                            <span>Keep the delivery, change the voice</span>
                          </label>
                          <label className="voice-studio-check">
                            <input type="radio" name={`delivery-${chapter.index}`} checked={perform} onChange={() => setPerform(true)} />
                            <span>Perform it again</span>
                          </label>
                          {perform ? (
                            <label>
                              <span>What to say, with directions in square brackets, such as [whispers] or [angry]</span>
                              <textarea rows={3} value={text} onChange={event => setText(event.target.value)} />
                            </label>
                          ) : null}
                          <div className="admin-update-actions">
                            <PlayButton label="Listen" active={playing === `${key}:original`} onClick={() => void onPlay(`${key}:original`, () => getOriginalVoiceClip(bookId, line.startSeconds, Math.min(line.endSeconds, line.startSeconds + 30)))} />
                            <PlayButton label={`Hear as ${voice?.name ?? "…"}`} active={playing === `${key}:new`} disabled={!voice || (perform && !text.trim())} onClick={() => preview(`${key}:new`, lineEdit(line))} />
                            <button type="button" disabled={disabled || !voice || (perform && !text.trim())} onClick={() => { const edit = lineEdit(line); if (edit) { onAdd(edit); setEditing(null); } }}>
                              Add to the plan
                            </button>
                            <button type="button" className="quiet-button" disabled={disabled} onClick={() => { onAdd({ kind: "keep", chapter: chapter.index, startSeconds: line.startSeconds, endSeconds: line.endSeconds }); setEditing(null); }}>
                              Keep the original here
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {matches.length > LINES_SHOWN ? (
                <p className="admin-experiment-detail">Showing the first {LINES_SHOWN} of {matches.length.toLocaleString()} lines. Search to narrow them down.</p>
              ) : null}
              {matches.length === 0 ? <p className="admin-experiment-detail">No line has those words.</p> : null}
            </>
          )}
          {loadError ? <p className="admin-experiment-detail" role="alert">{loadError}</p> : null}
        </>
      ) : null}
    </div>
  );
}

/** A number box that reports its value when left, not on every keystroke. */
function SecondsInput({ label, value, disabled, onCommit }: { label: string; value: number; disabled: boolean; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(value.toFixed(1));
  useEffect(() => setDraft(value.toFixed(1)), [value]);
  const commit = () => {
    const next = Number(draft);
    if (Number.isFinite(next) && Math.abs(next - value) >= 0.05) onCommit(next);
    else setDraft(value.toFixed(1));
  };
  return (
    <label className="voice-studio-seconds">
      <span>{label}</span>
      <input
        type="number"
        step={0.1}
        min={0}
        value={draft}
        disabled={disabled}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
    </label>
  );
}

function CastMemberEditor({
  bookId,
  member,
  chapters,
  voices,
  suggested,
  credits,
  disabled,
  playing,
  onPlay,
  onChange,
  onRemove
}: {
  bookId: string;
  member: VoiceCastMember;
  chapters: VoiceChapter[];
  voices: ReplacementVoice[];
  /** Parts of the book headed with this name that the voice does not cover yet. */
  suggested: VoicePassage[];
  credits?: number;
  disabled: boolean;
  playing: string | null;
  onPlay: (key: string, load: () => Promise<Blob>) => Promise<void>;
  onChange: (member: VoiceCastMember) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(member.name);
  // Settings are tried as drafted and saved when a slider is let go.
  const [settings, setSettings] = useState<VoiceSettings | undefined>(member.voice.settings);
  useEffect(() => setName(member.name), [member.name]);
  const savedSettings = JSON.stringify(member.voice.settings ?? null);
  useEffect(() => setSettings(member.voice.settings), [savedSettings]); // eslint-disable-line react-hooks/exhaustive-deps

  const drafted: VoiceChoice = { voiceId: member.voice.voiceId, name: member.voice.name, ...(settings ? { settings } : {}) };
  const saveSettings = (next: VoiceSettings | undefined) => {
    setSettings(next);
    onChange({ ...member, voice: { voiceId: member.voice.voiceId, name: member.voice.name, ...(next ? { settings: next } : {}) } });
  };
  const commitSettings = () => {
    if (JSON.stringify(settings ?? null) !== savedSettings) saveSettings(settings);
  };
  const total = member.stretches.reduce((sum, stretch) => sum + stretch.endSeconds - stretch.startSeconds, 0);
  const tryKey = (stretch: VoiceStretch, from: number) => `try:${from}:${stretch.endSeconds}:${JSON.stringify(drafted)}`;
  const tryFrom = (stretch: VoiceStretch, from: number) => {
    const end = Math.min(stretch.endSeconds, from + TRY_SECONDS);
    const chapterStart = chapters.find(chapter => from >= chapter.startSeconds && from < chapter.endSeconds)?.startSeconds ?? from;
    void onPlay(tryKey(stretch, from), () => auditionVoice(bookId, drafted, from, end, Math.min(TRY_LEAD_SECONDS, from - chapterStart)));
  };
  const slider = (label: string, hint: string, field: "stability" | "similarity" | "style") => settings ? (
    <label>
      <span>{label}: {Math.round(settings[field] * 100)}%<small> · {hint}</small></span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={settings[field]}
        disabled={disabled}
        onChange={event => setSettings({ ...settings, [field]: Number(event.target.value) })}
        onPointerUp={commitSettings}
        onKeyUp={commitSettings}
        onBlur={commitSettings}
      />
    </label>
  ) : null;

  return (
    <div className="voice-studio-cast">
      <div className="voice-studio-cast-head">
        <label>
          <span>Who is replaced</span>
          <input
            type="text"
            value={name}
            maxLength={80}
            disabled={disabled}
            onChange={event => setName(event.target.value)}
            onBlur={() => { if (name.trim() && name.trim() !== member.name) onChange({ ...member, name: name.trim() }); else setName(member.name); }}
          />
        </label>
        <label>
          <span>New voice</span>
          <select
            value={member.voice.voiceId}
            disabled={disabled}
            onChange={event => {
              const found = voices.find(candidate => candidate.voiceId === event.target.value);
              if (found) onChange({ ...member, voice: { voiceId: found.voiceId, name: found.name, ...(settings ? { settings } : {}) } });
            }}
          >
            {voices.some(candidate => candidate.voiceId === member.voice.voiceId) ? null : <option value={member.voice.voiceId}>{member.voice.name}</option>}
            {voices.map(candidate => <option key={candidate.voiceId} value={candidate.voiceId}>{candidate.name}{candidate.category ? ` (${candidate.category})` : ""}</option>)}
          </select>
        </label>
      </div>

      <label className="voice-studio-check">
        <input type="checkbox" checked={settings !== undefined} disabled={disabled} onChange={event => saveSettings(event.target.checked ? DEFAULT_SETTINGS : undefined)} />
        <span>Set how {member.voice.name} performs</span>
      </label>
      {settings ? (
        <>
          {slider("Stability", "lower follows the original's ups and downs more", "stability")}
          {slider("Likeness", "how closely it keeps to the new voice", "similarity")}
          {slider("Style", "how far the original's manner is pushed", "style")}
          <label className="voice-studio-check">
            <input type="checkbox" checked={settings.removeNoise} disabled={disabled} onChange={event => saveSettings({ ...settings, removeNoise: event.target.checked })} />
            <span>Strip music and room noise from the original first</span>
          </label>
        </>
      ) : null}

      {member.stretches.length === 0 ? (
        <p className="admin-experiment-detail">No stretches yet, so nothing is replaced. Open a chapter and add one of its parts.</p>
      ) : (
        <ul>
          {member.stretches.map((stretch, at) => {
            const chapter = chapters.find(candidate => stretch.startSeconds >= candidate.startSeconds - 0.001 && stretch.endSeconds <= candidate.endSeconds + 0.001);
            const length = stretch.endSeconds - stretch.startSeconds;
            const middle = stretch.startSeconds + Math.max(0, (length - TRY_SECONDS) / 2);
            const change = (next: VoiceStretch) => onChange({ ...member, stretches: member.stretches.map((other, index) => index === at ? next : other) });
            const startKey = `stretch:${stretch.startSeconds}:start`;
            const endKey = `stretch:${stretch.endSeconds}:end`;
            return (
              <li key={stretch.startSeconds}>
                <span>
                  {chapter?.title ?? "Not in a chapter"}
                  <small> · {formatTime(stretch.startSeconds)} to {formatTime(stretch.endSeconds)} · {formatDurationLabel(length)}</small>
                </span>
                <SecondsInput label="Starts at (s)" value={stretch.startSeconds} disabled={disabled} onCommit={startSeconds => change({ ...stretch, startSeconds })} />
                <SecondsInput label="Ends at (s)" value={stretch.endSeconds} disabled={disabled} onCommit={endSeconds => change({ ...stretch, endSeconds })} />
                <PlayButton label="Hear its start" active={playing === startKey} onClick={() => void onPlay(startKey, () => getOriginalVoiceClip(bookId, stretch.startSeconds, Math.min(stretch.endSeconds, stretch.startSeconds + 10)))} />
                <PlayButton label="Hear its end" active={playing === endKey} onClick={() => void onPlay(endKey, () => getOriginalVoiceClip(bookId, Math.max(stretch.startSeconds, stretch.endSeconds - 10), stretch.endSeconds))} />
                <PlayButton label={`Try the start as ${member.voice.name}`} active={playing === tryKey(stretch, stretch.startSeconds)} onClick={() => tryFrom(stretch, stretch.startSeconds)} />
                {length > TRY_SECONDS * 2 ? (
                  <PlayButton label="Try the middle" active={playing === tryKey(stretch, middle)} onClick={() => tryFrom(stretch, middle)} />
                ) : null}
                <button type="button" className="quiet-button" aria-label="Remove this stretch" disabled={disabled} onClick={() => onChange({ ...member, stretches: member.stretches.filter((_, index) => index !== at) })}>
                  <Trash2 size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {suggested.length > 0 ? (
        <div className="admin-update-actions">
          <button type="button" className="quiet-button" disabled={disabled} onClick={() => onChange({ ...member, stretches: [...member.stretches, ...suggested.map(({ startSeconds, endSeconds }) => ({ startSeconds, endSeconds }))] })}>
            Add {suggested.length} more {suggested.length === 1 ? "part" : "parts"} headed "{member.name}"
          </button>
        </div>
      ) : null}
      <p className="admin-experiment-detail">
        {formatDurationLabel(total)} to replace{credits !== undefined ? `: up to ${credits.toLocaleString()} ElevenLabs credits` : ""}.
        Trying {TRY_SECONDS} seconds uses about {Math.round(TRY_SECONDS / 60 * CREDITS_PER_MINUTE).toLocaleString()} credits and plays a few
        seconds of the book first, so you hear the join. The same try again is free; a different voice or setting is a new one.
      </p>
      <div className="admin-update-actions">
        <button type="button" className="quiet-button" disabled={disabled} onClick={onRemove}><Trash2 size={13} /> Remove {member.name} from the cast</button>
      </div>
    </div>
  );
}
