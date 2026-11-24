import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import {
  disableCloudRecognition,
  enableCloudRecognition,
  getCloudRecognitionStatus,
  getRecognitionGpuStatus,
  setRecognitionGpu,
  type CloudRecognitionStatus,
  type RecognitionGpuStatus
} from "./api";
import { errorMessage } from "./formatting";

type Choice = "local" | "openai";

/**
 * Where follow-along speech recognition runs. On this server is the default,
 * with its graphics card as an opt-in where it has one the add-on can use;
 * OpenAI is an opt-in for owners who bring their own key.
 */
export function CloudRecognition({ isOwner, onChange }: { isOwner: boolean; onChange: (enabled: boolean) => void }) {
  const [status, setStatus] = useState<CloudRecognitionStatus | null>(null);
  const [choice, setChoice] = useState<Choice>("local");
  const [gpu, setGpu] = useState<RecognitionGpuStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function accept(next: CloudRecognitionStatus) {
    setStatus(next);
    setChoice(next.enabled ? "openai" : "local");
    onChange(next.enabled);
  }

  useEffect(() => {
    let cancelled = false;
    void getCloudRecognitionStatus()
      .then(loaded => { if (!cancelled) accept(loaded); })
      .catch(() => undefined);
    // A server from before the setting existed has no such route, and offers no card.
    void getRecognitionGpuStatus()
      .then(loaded => { if (!cancelled) setGpu(loaded); })
      .catch(() => undefined);
    return () => { cancelled = true; };
    // `onChange` is a state setter, so this runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(change: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await change();
    } catch (failure) {
      setError(errorMessage(failure, fallback));
    } finally {
      setBusy(false);
    }
  }

  function apply(change: () => Promise<CloudRecognitionStatus>, fallback: string) {
    return run(async () => {
      accept(await change());
      setApiKey("");
    }, fallback);
  }

  function saveGraphicsCard(enabled: boolean) {
    return run(async () => setGpu(await setRecognitionGpu(enabled)), "Could not change the graphics card setting.");
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
      {gpu?.supported && saved === "local" && !switching ? (
        <div className="recognition-choice-detail">
          <label className="recognition-choice-option">
            <input type="checkbox" checked={gpu.enabled} onChange={event => void saveGraphicsCard(event.currentTarget.checked)} />
            <span>
              <strong>Use the graphics card</strong>
              <small>
                Runs a larger English model on this server’s NVIDIA card, which places sentences more closely.
                It needs NVIDIA’s CUDA 12 and cuDNN 9 libraries on the server, and the first sync with it downloads
                about 3 GB. A sync that cannot use the card says why and runs on the processor.
              </small>
            </span>
          </label>
        </div>
      ) : null}
      <label className={choice === "openai" ? "selected" : undefined}>
        <input type="radio" name="recognition" checked={choice === "openai"} onChange={() => setChoice("openai")} />
        <span>
          <strong>OpenAI</strong>
          <small>Narration clips go to OpenAI with your own API key</small>
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
