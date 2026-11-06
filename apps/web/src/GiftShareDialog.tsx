import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Gift, X } from "lucide-react";
import { captureGiftOwnerSetupGuard as captureGiftServerGuard, createSelectedBookGift, getBookGiftInventory } from "./api";
import { useModalFocus } from "./useModalFocus";
import { defaultGiftSelection, giftAssetDisabledReason, giftSelectionSummary, giftSizeLabel, parseCreatedGift, parseGiftInventory, selectedGiftRequest, type CreatedGift, type GiftInventory, type SelectedGiftRequest, type SenderCreatedGift } from "./giftSelectionModel";
import "./giftShare.css";

// The server routes and native recipient path remain experimental. Do not turn
// this into a runtime switch or infer availability from an inventory response.
export const EXPERIMENTAL_GIFT_SENDER_ENABLED = false;
export type GiftSenderApi = {
  captureGuard?: () => () => boolean;
  inventory(bookId: string, signal: AbortSignal): Promise<GiftInventory>;
  create(input: SelectedGiftRequest, signal: AbortSignal): Promise<SenderCreatedGift>;
};
const senderApi: GiftSenderApi = { captureGuard: captureGiftServerGuard, inventory: getBookGiftInventory, create: createSelectedBookGift };

export function GiftShareAction({ bookId, enabled, api = senderApi }: { bookId: string; enabled: boolean; api?: GiftSenderApi }) {
  const [open, setOpen] = useState(false);
  if (!enabled) return null;
  return <>
    <button className="book-action" type="button" onClick={() => setOpen(true)} aria-haspopup="dialog"><span className="book-action-dot"><Gift size={16} aria-hidden="true" /></span><span className="book-action-label">Share gift</span></button>
    {open ? createPortal(<GiftShareDialog key={bookId} bookId={bookId} api={api} onClose={() => setOpen(false)} />, document.body) : null}
  </>;
}

export function GiftShareDialog({ bookId, api, onClose }: { bookId: string; api: GiftSenderApi; onClose(): void }) {
  const [inventory, setInventory] = useState<GiftInventory | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [expiry, setExpiry] = useState(900);
  const [phase, setPhase] = useState<"loading" | "ready" | "creating" | "created" | "load-error">("loading");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [created, setCreated] = useState<CreatedGift | null>(null);
  const [revocation, setRevocation] = useState<"idle" | "pending" | "done">("idle");
  const revokeGift = useRef<SenderCreatedGift["revoke"]>(undefined);
  const [reload, setReload] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(new Set<AbortController>());
  const creating = useRef(false);
  const attempt = useRef(0);
  const sameServer = useRef<(() => boolean) | null>(null);
  const summary = inventory ? giftSelectionSummary(inventory, selected) : null;
  const messageLength = Array.from(message).length;
  const stopCreation = () => {
    controller.current?.abort(); attempt.current++;
    creating.current = false;
    setPhase("ready");
    setError("Stopped waiting. A gift may already have been created on the server and may remain valid until expiry. Stopping does not revoke it; no link was confirmed. Retrying can create extra invitations and reach the server's invitation quota.");
  };
  const dismiss = () => {
    if (phase === "creating") stopCreation();
    else if (revocation === "pending") { controller.current?.abort(); setRevocation("idle"); setError("Stopped waiting for revocation. The original server may already have revoked the gift; the outcome is unconfirmed. Retry this original-server revocation action before assuming the link is still valid."); }
    else { controller.current?.abort(); onClose(); }
  };
  const dialogRef = useModalFocus<HTMLFormElement>(dismiss);

  useEffect(() => {
    sameServer.current = api.captureGuard?.() ?? (() => true);
    const active = new AbortController(); controller.current = active;
    const requests = pending.current; requests.add(active);
    const sequence = ++attempt.current;
    setInventory(null); setPhase("loading"); setError("");
    void api.inventory(bookId, active.signal).then(value => {
      if (active.signal.aborted || sequence !== attempt.current) return;
      const parsed = parseGiftInventory(value, bookId);
      setInventory(parsed); setSelected(defaultGiftSelection(parsed)); setPhase("ready");
    }).catch(() => { if (!active.signal.aborted && sequence === attempt.current) { setPhase("load-error"); setError("Gift inventory is unavailable. This needs a supported, authorized OperaLibre server with the experimental routes. No link was created."); } }).finally(() => requests.delete(active));
    return () => { for (const request of requests) request.abort(); requests.clear(); };
  }, [api, bookId, reload]);

  async function create() {
    if (!inventory || phase !== "ready" || creating.current) return;
    if (!sameServer.current?.()) { setError("The connected server or sign-in changed. Reopen this gift dialog before sending a personal message or creating a link."); return; }
    let input: SelectedGiftRequest;
    try { input = selectedGiftRequest(inventory, selected, message, expiry); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Check the selected contents."); return; }
    const active = new AbortController(); controller.current = active;
    creating.current = true;
    pending.current.add(active);
    const sequence = ++attempt.current;
    setPhase("creating"); setError(""); setStatus("");
    try {
      const response = await api.create(input, active.signal);
      const result = parseCreatedGift(response);
      if (!active.signal.aborted && sequence === attempt.current) {
        revokeGift.current = response.revoke;
        // Keep the management token only in the API's private bound callback,
        // never in rendered state, copied gift text or persistent storage.
        setCreated({ giftUrl: result.giftUrl, expiresAt: result.expiresAt }); setPhase("created"); setMessage("");
      }
    } catch {
      if (!active.signal.aborted && sequence === attempt.current) {
        setPhase("ready");
        setError("Gift creation could not be confirmed. The server may be unavailable, sharing may be disabled or unconfigured, or the request may have timed out. A submitted invitation may still exist until expiry. No link will be invented; check server state before retrying.");
      }
    } finally { pending.current.delete(active); if (sequence === attempt.current) creating.current = false; }
  }

  async function revoke() {
    if (!revokeGift.current || revocation !== "idle" || creating.current) return;
    creating.current = true;
    const active = new AbortController(); controller.current = active; pending.current.add(active);
    setRevocation("pending"); setError(""); setStatus("");
    try {
      await revokeGift.current(active.signal);
      if (!active.signal.aborted) { setRevocation("done"); setStatus("Revocation confirmed by the original server. Downloaded or offline copies cannot be recalled; in-flight bytes may already have arrived and remote broker cleanup may still be pending."); }
    } catch { if (!active.signal.aborted) { setRevocation("idle"); setError("Revocation could not be confirmed by the original server. It may be offline, or the original sign-in may no longer authorize this request. No management token was sent to a newly selected server. Retry this action before assuming the gift is still valid."); } }
    finally { pending.current.delete(active); creating.current = false; }
  }

  return <div className="gift-share-scrim">
    <form ref={dialogRef} tabIndex={-1} className="gift-share-dialog" role="dialog" aria-modal="true" aria-labelledby="gift-share-title" onSubmit={event => { event.preventDefault(); void create(); }}>
      <header><h2 id="gift-share-title">{created ? "Your gift link" : "Share a book gift"}</h2><button type="button" aria-label={phase === "creating" || revocation === "pending" ? "Stop waiting for gift operation" : "Close gift sharing"} onClick={dismiss}><X size={18} aria-hidden="true" /></button></header>
      <p>Experimental, disabled in normal production builds. Only the server can authorize the contents and return a configured gift link.</p>
      {phase === "loading" ? <p role="status">Loading available contents from your server…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {phase === "load-error" ? <button type="button" onClick={() => setReload(value => value + 1)}>Reload contents</button> : null}
      {inventory && !created ? <>
        <h3>{inventory.title}</h3>
        <p>Select a lightweight ebook gift, or opt in to available audio. Metadata is always included. Unselected files are not requested for this gift.</p>
        <fieldset disabled={phase === "creating"}><legend>Included contents</legend>
          {inventory.assets.map((asset, index) => {
            const reason = giftAssetDisabledReason(asset);
            const descriptionId = `gift-asset-reason-${index}`;
            return <div className="gift-share-asset" key={asset.id}>
              <label><input type="checkbox" checked={selected.includes(asset.id)} disabled={asset.kind === "metadata" || !!reason} aria-describedby={reason || asset.kind === "metadata" ? descriptionId : undefined} onChange={event => { const checked = event.currentTarget.checked; setSelected(current => checked ? [...current, asset.id] : current.filter(id => id !== asset.id)); }} /><span>{asset.fileName} <small>{asset.kind} · {giftSizeLabel(asset.sizeBytes)}</small></span></label>
              {reason || asset.kind === "metadata" ? <small id={descriptionId}>{reason ?? "Required metadata; it cannot be removed."}</small> : null}
            </div>;
          })}
        </fieldset>
        {summary ? <section aria-label="Selected gift contents" aria-live="polite"><p>Included formats: {summary.formats.join(", ") || "None"}</p><p>Selected asset size: {giftSizeLabel(summary.sizeBytes)} · Server limit: {giftSizeLabel(inventory.maxBytes)}. Archive overhead may differ.</p>{summary.errors.length ? <ul>{summary.errors.map(problem => <li key={problem}>{problem}</li>)}</ul> : null}</section> : null}
        <fieldset disabled={phase === "creating"}>
          <label>Personal message (optional)<textarea value={message} maxLength={4000} rows={4} aria-describedby="gift-message-help" onChange={event => setMessage(event.currentTarget.value)} /></label>
          <small id="gift-message-help">{messageLength}/1000 characters. Plain text on the private gift card, not the public landing page or Discord preview.</small>
          {messageLength > 1000 ? <p role="alert">Shorten the message to 1000 characters or fewer.</p> : null}
          <label>Link expiry<select value={expiry} onChange={event => setExpiry(Number(event.currentTarget.value))}><option value={300}>5 minutes</option><option value={900}>15 minutes</option></select></label>
        </fieldset>
        <p>Share only books you have permission to share. No DRM removal is provided. Unsupported or unavailable formats remain disabled by the server inventory; this is not a guarantee of DRM detection.</p>
        <button type="submit" disabled={phase !== "ready" || !!summary?.errors.length || messageLength > 1000}>{phase === "creating" ? "Creating gift…" : "Create gift link"}</button>
      </> : null}
      {created ? <section aria-label="Created gift link"><p>The server returned this private gift link. Anyone receiving it can access its scoped gift; keep it private.</p><label>Private gift URL<textarea readOnly rows={4} value={created.giftUrl} onFocus={event => event.currentTarget.select()} /></label><p>Expires: {new Date(created.expiresAt * 1000).toLocaleString()}</p><button type="button" disabled={revocation !== "idle"} onClick={() => {
        if (!navigator.clipboard?.writeText) { setStatus("Select and copy the private gift URL manually."); return; }
        void navigator.clipboard.writeText(created.giftUrl).then(() => setStatus("Gift link copied. Paste it into your private Discord conversation.")).catch(() => setStatus("Could not copy. Select the private gift URL and copy it manually."));
      }}>Copy gift link</button><p>Revocation uses the original sender server and original sign-in, even if you change the selected server. It cannot recall a recipient's downloaded copy.</p><button type="button" disabled={!revokeGift.current || revocation !== "idle"} onClick={() => void revoke()}>{revocation === "pending" ? "Revoking gift…" : revocation === "done" ? "Gift revoked" : "Revoke gift"}</button>{!revokeGift.current ? <p>This legacy response did not provide a bound revocation action.</p> : null}</section> : null}
      {status ? <p role="status">{status}</p> : null}
      <footer><button type="button" onClick={dismiss}>{phase === "creating" || revocation === "pending" ? "Stop waiting" : created ? "Done" : "Cancel"}</button></footer>
    </form>
  </div>;
}
