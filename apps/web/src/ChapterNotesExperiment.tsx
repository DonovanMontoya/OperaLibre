import { useEffect, useState, type FormEvent } from "react";
import { Check, FlaskConical, LoaderCircle } from "lucide-react";
import {
  getChapterNotesStatus,
  removeChapterNotesProvider,
  setChapterNotesEnabled,
  setChapterNotesProvider,
  type ChapterNotesProviderKind,
  type ChapterNotesStatus
} from "./api";

const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

function failureMessage(failure: unknown, fallback: string) {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

/** The switch for chapter notes, and the owner's choice of model. */
export function ChapterNotesExperiment({ isOwner }: { isOwner: boolean }) {
  const [status, setStatus] = useState<ChapterNotesStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getChapterNotesStatus().then(loaded => { if (!cancelled) setStatus(loaded); });
    return () => { cancelled = true; };
  }, []);

  async function toggle() {
    if (!status || busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await setChapterNotesEnabled(!status.enabled));
    } catch (failure) {
      setError(failureMessage(failure, "Could not change chapter notes."));
    } finally {
      setBusy(false);
    }
  }

  const provider = status?.provider ?? null;
  return (
    <article>
      <div className="admin-software-version-head">
        <div>
          <span>Chapter notes</span>
          <strong>{status === null ? "Checking…" : !status.enabled ? "Off" : provider ? `On, written by ${provider.model}` : "On, transcripts only"}</strong>
        </div>
        {status?.enabled ? (
          <span className="admin-current-badge"><Check size={12} /> Enabled</span>
        ) : (
          <span className="admin-experimental-badge">Optional</span>
        )}
      </div>
      <p>
        Give each chapter a spoiler-free synopsis, a full summary, and the people and places in it.
        Listeners see them on the book's page, and connected AI assistants can read them, only as far as
        the listener has got. Books with a follow-along map use their own text; other books are
        transcribed on this server.
      </p>
      <p className="admin-experiment-detail">
        Transcribing needs the follow-along add-on{status?.enabled ? (status.transcriptionAvailable ? ", which is ready." : ", which is not installed or is off.") : "."}
        {" "}Writing notes needs a language model. Without one, books are transcribed and assistants write their own recaps.
        A chapter's text goes to the model you choose only when an administrator makes notes for that book.
      </p>
      {error ? <p className="admin-experiment-detail" role="alert">{error}</p> : null}
      {isOwner ? (
        <div className="admin-update-actions">
          <button type="button" className={status?.enabled ? "quiet-button" : undefined} disabled={status === null || busy} onClick={() => void toggle()}>
            {busy ? <LoaderCircle size={15} className="spin-icon" /> : <FlaskConical size={15} />}
            {status?.enabled ? "Disable" : "Enable"}
          </button>
        </div>
      ) : null}
      {status?.enabled && isOwner ? <ProviderForm status={status} onSaved={setStatus} /> : null}
    </article>
  );
}

function ProviderForm({ status, onSaved }: { status: ChapterNotesStatus; onSaved: (status: ChapterNotesStatus) => void }) {
  const saved = status.provider ?? null;
  const [kind, setKind] = useState<ChapterNotesProviderKind>(saved?.kind ?? "anthropic");
  const [model, setModel] = useState(saved?.model ?? DEFAULT_ANTHROPIC_MODEL);
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keySaved = saved?.kind === kind && saved.hasApiKey;

  function chooseKind(next: ChapterNotesProviderKind) {
    setKind(next);
    if (next === "anthropic" && !model.trim()) setModel(DEFAULT_ANTHROPIC_MODEL);
    if (next === "openAiCompatible" && model === DEFAULT_ANTHROPIC_MODEL) setModel("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await setChapterNotesProvider({
        kind,
        model: model.trim() || undefined,
        baseUrl: kind === "openAiCompatible" ? baseUrl.trim() : undefined,
        apiKey: apiKey.trim() ? apiKey.trim() : undefined
      }));
      setApiKey("");
    } catch (failure) {
      setError(failureMessage(failure, "Could not save the model."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await removeChapterNotesProvider());
      setApiKey("");
    } catch (failure) {
      setError(failureMessage(failure, "Could not remove the model."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="chapter-notes-provider" onSubmit={event => void save(event)}>
      <fieldset disabled={busy}>
        <legend>Model that writes the notes</legend>
        <label>
          <span>Provider</span>
          <select value={kind} onChange={event => chooseKind(event.target.value as ChapterNotesProviderKind)}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openAiCompatible">OpenAI-compatible, such as Ollama or LM Studio</option>
          </select>
        </label>
        {kind === "openAiCompatible" ? (
          <label>
            <span>Endpoint</span>
            <input type="url" value={baseUrl} placeholder="http://192.168.1.20:11434/v1" onChange={event => setBaseUrl(event.target.value)} required />
          </label>
        ) : null}
        <label>
          <span>Model</span>
          <input value={model} placeholder={kind === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : "llama3.1"} onChange={event => setModel(event.target.value)} required={kind === "openAiCompatible"} />
        </label>
        <label>
          <span>API key{kind === "openAiCompatible" ? " (if the endpoint needs one)" : ""}</span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={keySaved ? "Saved. Paste a new key to replace it." : ""}
            onChange={event => setApiKey(event.target.value)}
            required={kind === "anthropic" && !keySaved}
          />
        </label>
        {error ? <p className="admin-experiment-detail" role="alert">{error}</p> : null}
        <div className="admin-update-actions">
          <button type="submit">{busy ? <LoaderCircle size={15} className="spin-icon" /> : null}Save model</button>
          {saved ? <button type="button" className="quiet-button" onClick={() => void remove()}>Use transcripts only</button> : null}
        </div>
      </fieldset>
    </form>
  );
}
