import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import {
  disableCloudRecognition,
  enableCloudRecognition,
  getCloudRecognitionStatus,
  type CloudRecognitionStatus
} from "./api";
import { ExperimentSection } from "./ExperimentSection";

function failureMessage(failure: unknown, fallback: string) {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

/**
 * The owner's opt-in to transcribe follow-along audio with OpenAI instead of
 * on this server. It sends book audio away, so turning it on takes a key and
 * an explicit confirmation.
 */
export function CloudRecognition({ isOwner, onChange }: { isOwner: boolean; onChange: (enabled: boolean) => void }) {
  const [status, setStatus] = useState<CloudRecognitionStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getCloudRecognitionStatus()
      .then(loaded => {
        if (cancelled) return;
        setStatus(loaded);
        onChange(loaded.enabled);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [onChange]);

  function saved(next: CloudRecognitionStatus) {
    setStatus(next);
    onChange(next.enabled);
    setApiKey("");
    setUnderstood(false);
  }

  async function enable(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      saved(await enableCloudRecognition(apiKey.trim()));
    } catch (failure) {
      setError(failureMessage(failure, "Could not turn on OpenAI transcription."));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      saved(await disableCloudRecognition());
    } catch (failure) {
      setError(failureMessage(failure, "Could not turn off OpenAI transcription."));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  return (
    <ExperimentSection title={status.enabled ? "Transcription: OpenAI" : "Transcription: on this server"}>
      <div className="cloud-recognition">
        <p className="cloud-recognition-warning" role="note">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>
            <strong>Greatly reduces privacy.</strong> With an OpenAI key, the narration of every book you
            sync, including scheduled nightly remapping, is uploaded to OpenAI in short clips to be
            transcribed, and OpenAI bills that key per minute of audio. OpenAI handles it under its own terms
            and retention policies, outside your control. Book text, accounts, and listening history are not sent.
          </span>
        </p>
        <p className="admin-experiment-detail">
          OpenAI's {status.model} model can follow narration that the on-device recognizer finds hard and spares a
          small server the work. Matching the narration to the text still happens here, so the follow-along
          add-on is still needed. Books synced before you change this keep their maps.
        </p>
        {error ? <p className="admin-experiment-detail" role="alert">{error}</p> : null}
        {!isOwner ? (
          <p className="admin-experiment-detail">Only an owner can change this.</p>
        ) : status.enabled ? (
          <>
            <div className="admin-update-actions">
              <button type="button" disabled={busy} onClick={() => void disable()}>
                {busy ? <LoaderCircle size={15} className="spin-icon" /> : null}
                Transcribe on this server again
              </button>
            </div>
            <p className="admin-experiment-detail">This deletes the saved key, and a book being synced stops uploading at its next clip.</p>
          </>
        ) : (
          <form onSubmit={event => void enable(event)}>
            <fieldset disabled={busy}>
              <label>
                <span>OpenAI API key</span>
                <input type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} required />
              </label>
              <label className="cloud-recognition-confirm">
                <input type="checkbox" checked={understood} onChange={event => setUnderstood(event.target.checked)} />
                <span>I understand that book audio will leave this server and be sent to OpenAI.</span>
              </label>
              <div className="admin-update-actions">
                <button type="submit" className="danger" disabled={!understood || !apiKey.trim()}>
                  {busy ? <LoaderCircle size={15} className="spin-icon" /> : null}
                  Send audio to OpenAI
                </button>
              </div>
            </fieldset>
          </form>
        )}
      </div>
    </ExperimentSection>
  );
}
