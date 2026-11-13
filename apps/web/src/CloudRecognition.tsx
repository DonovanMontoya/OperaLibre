import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import {
  disableCloudRecognition,
  enableCloudRecognition,
  getCloudRecognitionStatus,
  type CloudRecognitionStatus
} from "./api";

type Choice = "local" | "openai";

function failureMessage(failure: unknown, fallback: string) {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

/**
 * Where follow-along speech recognition runs. On this server is the default;
 * OpenAI is an opt-in for owners who bring their own key.
 */
export function CloudRecognition({ isOwner, onChange }: { isOwner: boolean; onChange: (enabled: boolean) => void }) {
  const [status, setStatus] = useState<CloudRecognitionStatus | null>(null);
  const [choice, setChoice] = useState<Choice>("local");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getCloudRecognitionStatus()
      .then(loaded => {
        if (cancelled) return;
        setStatus(loaded);
        setChoice(loaded.enabled ? "openai" : "local");
        onChange(loaded.enabled);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [onChange]);

  async function apply(change: () => Promise<CloudRecognitionStatus>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await change();
      setStatus(next);
      setChoice(next.enabled ? "openai" : "local");
      onChange(next.enabled);
      setApiKey("");
    } catch (failure) {
      setError(failureMessage(failure, fallback));
    } finally {
      setBusy(false);
    }
  }

  function useOpenAi(event: FormEvent) {
    event.preventDefault();
    void apply(() => enableCloudRecognition(apiKey.trim()), "Could not save the OpenAI key.");
  }

  if (!status) return null;
  const saved: Choice = status.enabled ? "openai" : "local";
  const switching = choice !== saved;
  return (
    <fieldset className="recognition-choice" disabled={!isOwner || busy}>
      <legend>Speech recognition</legend>
      <label className={choice === "local" ? "selected" : undefined}>
        <input type="radio" name="recognition" checked={choice === "local"} onChange={() => setChoice("local")} />
        <span>
          <strong>On this server</strong>
          <small>Default. Audio never leaves your server.</small>
        </span>
      </label>
      <label className={choice === "openai" ? "selected" : undefined}>
        <input type="radio" name="recognition" checked={choice === "openai"} onChange={() => setChoice("openai")} />
        <span>
          <strong>OpenAI</strong>
          <small>
            {saved === "openai"
              ? `Using your API key with ${status.model}.`
              : "Optional. Uses your own API key; can help with hard-to-follow narration."}
          </small>
        </span>
      </label>

      {switching && choice === "openai" ? (
        <form className="recognition-choice-detail" onSubmit={useOpenAi}>
          <p>
            Clips of each book's narration are sent to OpenAI while it syncs, and billed to your key. Book text,
            accounts, and listening history stay here. Matching audio to text still runs on this server.
          </p>
          <label>
            <span>OpenAI API key</span>
            <input type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} required />
          </label>
          <div className="admin-update-actions">
            <button type="submit" disabled={!apiKey.trim()}>
              {busy ? <LoaderCircle size={15} className="spin-icon" /> : null}
              Use OpenAI
            </button>
            <button type="button" className="quiet-button" onClick={() => setChoice("local")}>Cancel</button>
          </div>
        </form>
      ) : null}

      {switching && choice === "local" ? (
        <div className="recognition-choice-detail">
          <p>Syncs go back to running entirely on this server. The saved key is deleted.</p>
          <div className="admin-update-actions">
            <button type="button" onClick={() => void apply(disableCloudRecognition, "Could not switch back to this server.")}>
              {busy ? <LoaderCircle size={15} className="spin-icon" /> : null}
              Use this server
            </button>
            <button type="button" className="quiet-button" onClick={() => setChoice("openai")}>Cancel</button>
          </div>
        </div>
      ) : null}

      {error ? <p className="admin-experiment-detail" role="alert">{error}</p> : null}
      {!isOwner ? <p className="admin-experiment-detail">Only an owner can change this.</p> : null}
    </fieldset>
  );
}
