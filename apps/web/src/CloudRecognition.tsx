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
          <small>Audio never leaves your server</small>
        </span>
        <em>Default</em>
      </label>
      <label className={choice === "openai" ? "selected" : undefined}>
        <input type="radio" name="recognition" checked={choice === "openai"} onChange={() => setChoice("openai")} />
        <span>
          <strong>OpenAI</strong>
          <small>
            {saved === "openai"
              ? `Narration clips go to ${status.model} with your API key`
              : "Narration clips go to OpenAI with your own API key"}
          </small>
        </span>
        <em>Optional</em>
      </label>

      {switching && choice === "openai" ? (
        <form className="recognition-choice-detail" onSubmit={useOpenAi}>
          <p>
            OpenAI bills your key per minute of audio and handles it under its own terms. It can follow narration the
            on-device recognizer finds hard. Book text, accounts, and listening history stay on this server, and so
            does matching the audio to the text.
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
          <p>Syncs run entirely on this server again, and the saved key is deleted.</p>
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
