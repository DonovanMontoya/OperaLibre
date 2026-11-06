import { useEffect, useRef, useState } from "react";
import { Gift, ShoppingBag } from "lucide-react";

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
export type GiftFailure = "expired" | "revoked" | "offline" | "unavailable";
export class GiftScreenError extends Error {
  constructor(public readonly reason: GiftFailure) { super(reason); }
}
type Phase = "loading" | "wrapped" | "revealed" | "accepting" | "accepted" | "declined" | "error";

function failureMessage(reason: GiftFailure) {
  switch (reason) {
    case "expired": return "This gift link has expired. Ask the sender for a new one.";
    case "revoked": return "The sender has withdrawn this gift.";
    case "offline": return "You appear to be offline. Reconnect and try again.";
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
    {phase === "loading" ? <div role="status">Opening your gift…</div> : null}
    {phase === "error" ? <section role="alert"><h1 id="gift-heading">Gift unavailable</h1><p>{failureMessage(reason)}</p><div className="gift-actions"><button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button><button type="button" onClick={onClose}>Close</button></div></section> : null}
    {phase === "wrapped" && preview ? <section className="gift-wrapped"><h1 id="gift-heading">{preview.sender} sent you a book</h1><p>A little something just for you.</p><button type="button" className="gift-bag" onClick={() => setPhase("revealed")} aria-label="Unwrap your book gift"><ShoppingBag size={88} aria-hidden="true" /><Gift size={32} aria-hidden="true" /></button><p>Tap the bag to unwrap your gift</p><button type="button" className="gift-skip" onClick={() => setPhase("revealed")}>Skip animation</button></section> : null}
    {(phase === "revealed" || phase === "accepting") && preview ? <section className="gift-reveal" aria-busy={phase === "accepting"}>
      <p className="gift-eyebrow">A book from {preview.sender}</p>
      {safeCover(preview.coverUrl) ? <img className="gift-cover" src={safeCover(preview.coverUrl)!} alt={`Cover of ${preview.title}`} /> : <div className="gift-cover gift-cover-placeholder" aria-hidden="true"><Gift size={48} /></div>}
      <h1 id="gift-heading">{preview.title}</h1>
      {preview.author ? <p className="gift-author">by {preview.author}</p> : null}
      {preview.message ? <blockquote className="gift-message"><p>{preview.message}</p><footer>— {preview.sender}</footer></blockquote> : null}
      {preview.summary ? <p className="gift-summary">{preview.summary}</p> : null}
      <p><strong>Included:</strong> {preview.formats.length ? preview.formats.join(", ") : "Book"} · {friendlySize(preview.sizeBytes)}</p>
      <div className="gift-actions"><button type="button" disabled={phase === "accepting"} onClick={() => void acceptGift()}>{phase === "accepting" ? "Adding book…" : "Accept book"}</button><button type="button" disabled={phase === "accepting"} onClick={() => setPhase("declined")}>Decline</button></div>
      {phase === "accepting" ? <p role="status">Downloading your book to this device…</p> : <p>The book downloads only after you accept.</p>}
    </section> : null}
    {phase === "accepted" ? <section role="status"><h1 id="gift-heading">Your book is in your library</h1><button type="button" onClick={onClose}>Done</button></section> : null}
    {phase === "declined" ? <section><h1 id="gift-heading">Gift declined</h1><p>No book files were downloaded.</p><button type="button" onClick={onClose}>Done</button></section> : null}
  </main>;
}
