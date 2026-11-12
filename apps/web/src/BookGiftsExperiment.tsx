import { useEffect, useState } from "react";
import { Check, FlaskConical, LoaderCircle } from "lucide-react";
import { getBookGiftsStatus, isGiftBrokerTransportSecure, setBookGiftsEnabled, type BookGiftsStatus } from "./api";
import { GiftOwnerConfiguration } from "./GiftOwnerConfiguration";

const GUIDE = "https://donovanmontoya.github.io/OperaLibre/book-gifts.html";

/** The owner's switch for book gifts, and the broker setup behind it. */
export function BookGiftsExperiment() {
  const [status, setStatus] = useState<BookGiftsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getBookGiftsStatus().then(loaded => { if (!cancelled) setStatus(loaded); });
    return () => { cancelled = true; };
  }, []);

  async function toggle() {
    if (!status || busy) return;
    if (status.enabled && !window.confirm("Turn off book gifts?\n\nGifts being sent stop, and links you have already shared stop working until this is turned back on.")) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await setBookGiftsEnabled(!status.enabled));
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Could not change book gifts.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article>
      <div className="admin-software-version-head">
        <div>
          <span>Book gifts</span>
          <strong>{status === null ? "Checking…" : !status.enabled ? "Off" : status.configured ? "On" : "On, needs setup"}</strong>
        </div>
        {status?.enabled ? (
          <span className="admin-current-badge"><Check size={12} /> Enabled</span>
        ) : (
          <span className="admin-experimental-badge">Optional</span>
        )}
      </div>
      <p>
        Send a book to someone as a one-time link. They open it in the OperaLibre app, unwrap it,
        and keep their own copy, with no account on this server. The book goes straight from this
        server to their device, so nothing needs to be port forwarded. A small broker that you
        run yourself introduces the two; it never sees the book.
      </p>
      <p className="admin-experiment-detail">
        Needs a one-time setup. <a href={GUIDE} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>Read the setup guide</a>.
        Only share books you have the right to share.
      </p>
      {error ? <p className="admin-experiment-detail" role="alert">{error}</p> : null}
      <div className="admin-update-actions">
        <button type="button" className={status?.enabled ? "quiet-button" : undefined} disabled={status === null || busy} onClick={() => void toggle()}>
          {busy ? <LoaderCircle size={15} className="spin-icon" /> : <FlaskConical size={15} />}
          {status?.enabled ? "Disable" : "Enable"}
        </button>
      </div>
      {status?.enabled ? (
        <GiftOwnerConfiguration
          secure={isGiftBrokerTransportSecure()}
          onChanged={() => void getBookGiftsStatus().then(setStatus)}
        />
      ) : null}
    </article>
  );
}
