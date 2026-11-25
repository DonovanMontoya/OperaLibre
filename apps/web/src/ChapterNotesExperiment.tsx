import { useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import {
  removeChapterNotesProvider,
  setChapterNotesProvider,
  type ChapterNotesProviderKind,
  type ChapterNotesStatus
} from "./api";
import { errorMessage } from "./formatting";

const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** The owner's choice of the model that writes chapter notes. */
export function ChapterNotesProviderForm({ status, onSaved }: { status: ChapterNotesStatus; onSaved: (status: ChapterNotesStatus) => void }) {
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
      setError(errorMessage(failure, "Could not save the model."));
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
      setError(errorMessage(failure, "Could not remove the model."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="chapter-notes-provider" onSubmit={event => void save(event)}>
      <fieldset disabled={busy}>
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
