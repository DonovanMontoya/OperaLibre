import { useEffect, useRef, useState } from "react";

export type GiftPreview = {
  sender: string;
  title: string;
  author: string | null;
  summary: string | null;
  message: string | null;
  /** Only an already-fetched, in-memory preview URL; never an invitation URL. */
  coverUrl: string | null;
  formats: string[];
  sizeBytes: number | null;
};
export type GiftFailure = "expired" | "revoked" | "offline" | "unsupported" | "unavailable";
export class GiftScreenError extends Error {
  constructor(public readonly reason: GiftFailure) { super(reason); }
}
type Phase = "loading" | "wrapped" | "opening" | "revealed" | "accepting" | "accepted" | "declined" | "error";

function failureMessage(reason: GiftFailure) {
  switch (reason) {
    case "expired": return "This gift link has expired. Ask the sender for a new one.";
    case "revoked": return "The sender has withdrawn this gift.";
    case "offline": return "You appear to be offline. Reconnect and try again.";
    case "unsupported": return "This gift includes contents this app cannot import yet. Ask the sender for an EPUB or supported audiobook without read-along data.";
    default: return "This gift is unavailable right now. Please try again.";
  }
}
function friendlySize(bytes: number | null) {
  if (bytes === null || !Number.isSafeInteger(bytes) || bytes < 0) return "Size unavailable";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MiB`;
  return `${(bytes / (1024 ** 3)).toFixed(2)} GiB`;
}
function safeCover(url: string | null) {
  return url && (url.startsWith("blob:") || /^data:image\/(?:png|jpeg|webp);base64,/i.test(url)) ? url : null;
}

function BookFace({ preview, className }: { preview: GiftPreview; className: string }) {
  const cover = safeCover(preview.coverUrl);
  if (cover) return <img className={className} src={cover} alt={`Cover of ${preview.title}`} />;
  // No cover in the preview: a cloth binding stamped with the title.
  return <div className={`${className} gift-cloth`} aria-hidden="true"><span>{preview.title}</span>{preview.author ? <small>{preview.author}</small> : null}</div>;
}

const prefersReducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Presentation only. The caller must fetch a lightweight preview and must not
 * download assets until `accept` is called. No server account is required here. */
export function GiftScreen({ loadPreview, accept, onClose }: {
  loadPreview: (signal: AbortSignal) => Promise<GiftPreview>;
  accept: (signal: AbortSignal) => Promise<void>;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<GiftPreview | null>(null);
  const [reason, setReason] = useState<GiftFailure>("unavailable");
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  const accepting = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setPhase("loading");
    loadPreview(controller.signal).then(value => {
      if (!controller.signal.aborted) { setPreview(value); setPhase("wrapped"); }
    }).catch(error => {
      if (!controller.signal.aborted) { setReason(error instanceof GiftScreenError ? error.reason : "unavailable"); setPhase("error"); }
    });
    return () => { controller.abort(); request.current?.abort(); };
  }, [loadPreview, retry]);
  // The unwrap animation ends the opening phase; this only covers a browser
  // that never fires animationend (hidden tab, animation disabled by CSS).
  useEffect(() => {
    if (phase !== "opening") return;
    const timer = window.setTimeout(() => setPhase(current => current === "opening" ? "revealed" : current), 1400);
    return () => window.clearTimeout(timer);
  }, [phase]);

  function unwrap() {
    if (phase !== "wrapped") return;
    setPhase(prefersReducedMotion() ? "revealed" : "opening");
  }

  async function acceptGift() {
    if (accepting.current || phase !== "revealed") return;
    accepting.current = true;
    const controller = new AbortController();
    request.current = controller;
    setPhase("accepting");
    try {
      await accept(controller.signal);
      if (!controller.signal.aborted) setPhase("accepted");
    } catch (error) {
      if (!controller.signal.aborted) { setReason(error instanceof GiftScreenError ? error.reason : "unavailable"); setPhase("error"); }
    } finally { accepting.current = false; }
  }

  return <main className="gift-screen" aria-labelledby="gift-heading">
    {phase === "loading" ? <div className="gift-loading" role="status">Opening your gift…</div> : null}
    {phase === "error" ? <section className="gift-plain" role="alert"><h1 id="gift-heading">Gift unavailable</h1><p>{failureMessage(reason)}</p><div className="gift-actions"><button type="button" className="gift-primary" onClick={() => setRetry(value => value + 1)}>Try again</button><button type="button" className="gift-secondary" onClick={onClose}>Close</button></div></section> : null}
    {(phase === "wrapped" || phase === "opening") && preview ? <section className="gift-wrapped">
      <h1 id="gift-heading">{preview.sender} sent you a book</h1>
      <button type="button" className="gift-parcel" data-opening={phase === "opening" || undefined} disabled={phase === "opening"} onClick={unwrap} aria-label="Unwrap your book gift">
        {phase === "opening" ? <BookFace preview={preview} className="gift-parcel-book" /> : null}
        <span className="gift-wrap gift-wrap-left" aria-hidden="true" />
        <span className="gift-wrap gift-wrap-right" aria-hidden="true" onAnimationEnd={() => setPhase(current => current === "opening" ? "revealed" : current)} />
        <span className="gift-tag" aria-hidden="true">From {preview.sender}</span>
      </button>
      <p className="gift-hint">Tap to unwrap</p>
      <button type="button" className="gift-skip" onClick={() => setPhase("revealed")}>Skip animation</button>
    </section> : null}
    {(phase === "revealed" || phase === "accepting") && preview ? <section className="gift-reveal" aria-busy={phase === "accepting"}>
      <p className="gift-from">A gift from {preview.sender}</p>
      <BookFace preview={preview} className="gift-cover" />
      <h1 id="gift-heading">{preview.title}</h1>
      {preview.author ? <p className="gift-author">by {preview.author}</p> : null}
      {preview.message ? <figure className="gift-inscription"><blockquote><p>{preview.message}</p></blockquote><figcaption>{preview.sender}</figcaption></figure> : null}
      {preview.summary ? <p className="gift-summary">{preview.summary}</p> : null}
      <p className="gift-contents">Includes {preview.formats.length ? preview.formats.join(", ") : "the book"}. {friendlySize(preview.sizeBytes)}.</p>
      <div className="gift-actions"><button type="button" className="gift-primary" disabled={phase === "accepting"} onClick={() => void acceptGift()}>{phase === "accepting" ? "Adding book…" : "Accept book"}</button><button type="button" className="gift-secondary" disabled={phase === "accepting"} onClick={() => setPhase("declined")}>Decline</button></div>
      {phase === "accepting" ? <p className="gift-fineprint" role="status">Downloading your book to this device…</p> : <p className="gift-fineprint">Nothing downloads until you accept.</p>}
    </section> : null}
    {phase === "accepted" && preview ? <section className="gift-plain" role="status"><BookFace preview={preview} className="gift-cover gift-cover-small" /><h1 id="gift-heading">Your book is in your library</h1><p>{preview.title} is saved on this device.</p><div className="gift-actions"><button type="button" className="gift-primary" onClick={onClose}>Done</button></div></section> : null}
    {phase === "declined" ? <section className="gift-plain"><h1 id="gift-heading">Gift declined</h1><p>No book files were downloaded.</p><div className="gift-actions"><button type="button" className="gift-secondary" onClick={onClose}>Done</button></div></section> : null}
  </main>;
}
