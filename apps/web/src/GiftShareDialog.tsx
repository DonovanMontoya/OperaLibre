import { useEffect, useRef, useState } from "react";
import { AudioLines, BookOpen, Gift, Headphones, ImageIcon, Tag, X, type LucideIcon } from "lucide-react";
import { captureGiftOwnerSetupGuard as captureGiftServerGuard, createSelectedBookGift, getBookGiftInventory, getBookGiftsStatus, subscribeBookGiftsStatus } from "./api";
import { useModalFocus } from "./useModalFocus";
import { alignmentGiftSelection, defaultGiftSelection, giftAssetDisabledReason, giftSelectionSummary, giftSizeLabel, parseCreatedGift, parseGiftInventory, selectedGiftRequest, type CreatedGift, type GiftInventory, type GiftInventoryAsset, type SelectedGiftRequest, type SenderCreatedGift } from "./giftSelectionModel";
import "./giftShare.css";

/** Whether to offer gifting here: the server's owner has turned the experiment
 * on, set up a broker, and allowed this account to send. */
export function useBookGiftSending(eligible: boolean): boolean {
  const [canSend, setCanSend] = useState(false);
  useEffect(() => {
    if (!eligible) { setCanSend(false); return; }
    let sequence = 0;
    const refresh = () => {
      const current = ++sequence;
      const sameServer = captureGiftServerGuard();
      setCanSend(false);
      void getBookGiftsStatus().then(status => {
        if (current === sequence && sameServer()) setCanSend(status.canSend);
      });
    };
    const unsubscribe = subscribeBookGiftsStatus(refresh);
    refresh();
    return () => { sequence++; unsubscribe(); };
  }, [eligible]);
  return eligible && canSend;
}
export type GiftSenderApi = {
  captureGuard?: () => () => boolean;
  inventory(bookId: string, signal: AbortSignal): Promise<GiftInventory>;
  create(input: SelectedGiftRequest, signal: AbortSignal): Promise<SenderCreatedGift>;
};
const senderApi: GiftSenderApi = { captureGuard: captureGiftServerGuard, inventory: getBookGiftInventory, create: createSelectedBookGift };

// Readers choose parts of a book, not files; the file name stays as a hint.
const ASSET_NAMES: Record<GiftInventoryAsset["kind"], [string, LucideIcon]> = {
  metadata: ["Book details", Tag],
  ebook: ["Ebook", BookOpen],
  cover: ["Cover art", ImageIcon],
  audio: ["Audiobook", Headphones],
  alignment: ["Follow-along timing", AudioLines]
};

function expiryLabel(seconds: number) {
  const at = new Date(seconds * 1000);
  const sameDay = at.toDateString() === new Date().toDateString();
  return at.toLocaleString([], sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export function GiftShareAction({ enabled, onOpen }: { enabled: boolean; onOpen(): void }) {
  if (!enabled) return null;
  return <button className="book-action-item" type="button" onClick={onOpen} aria-haspopup="dialog"><Gift size={18} aria-hidden="true" /><span>Gift this book</span></button>;
}

export function GiftShareDialog({ bookId, api = senderApi, alignmentReady = false, onClose }: { bookId: string; api?: GiftSenderApi; alignmentReady?: boolean; onClose(): void }) {
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
  const summary = inventory ? giftSelectionSummary(inventory, selected, { alignmentReady }) : null;
  const messageLength = Array.from(message).length;
  const stopCreation = () => {
    controller.current?.abort(); attempt.current++;
    creating.current = false;
    setPhase("ready");
    setError("Stopped waiting. The server may have created the gift anyway, and it would stay valid until it expires. Stopping does not revoke it. Trying again can create another invitation.");
  };
  const dismiss = () => {
    if (phase === "creating") stopCreation();
    else if (revocation === "pending") { controller.current?.abort(); setRevocation("idle"); setError("Stopped waiting for revocation. The server may have revoked the gift already. Revoke again to be sure."); }
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
    }).catch(() => { if (!active.signal.aborted && sequence === attempt.current) { setPhase("load-error"); setError("Gift inventory is unavailable. This server may not support gifts, or your account may not be allowed to send them. No link was created."); } }).finally(() => requests.delete(active));
    return () => { for (const request of requests) request.abort(); requests.clear(); };
  }, [api, bookId, reload]);

  async function create() {
    if (!inventory || phase !== "ready" || creating.current) return;
    if (!sameServer.current?.()) { setError("The connected server or sign-in changed. Close this and open it again before creating a link."); return; }
    let input: SelectedGiftRequest;
    try { input = selectedGiftRequest(inventory, selected, message, expiry, { alignmentReady }); }
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
        setError("Gift creation could not be confirmed. The server may be offline, or gifts may not be set up on it. An invitation might still exist until it expires, so check before trying again.");
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
      if (!active.signal.aborted) { setRevocation("done"); setStatus("Gift revoked. The link no longer opens. Downloaded or offline copies cannot be recalled."); }
    } catch { if (!active.signal.aborted) { setRevocation("idle"); setError("Revocation could not be confirmed by the original server. It may be offline, or your sign-in there may have expired. Try again before assuming the link has stopped working."); } }
    finally { pending.current.delete(active); creating.current = false; }
  }

  const busy = phase === "creating" || revocation === "pending";
  const audioCount = inventory?.assets.filter(asset => asset.kind === "audio").length ?? 0;
  return <div className="gift-share-scrim">
    <form ref={dialogRef} tabIndex={-1} className="gift-share-dialog" role="dialog" aria-modal="true" aria-labelledby="gift-share-title" onSubmit={event => { event.preventDefault(); void create(); }}>
      <header className="gift-share-head">
        <h2 id="gift-share-title">{created ? "Your gift link" : "Give this book"}</h2>
        <button type="button" className="gift-share-close" aria-label={busy ? "Stop waiting for gift operation" : "Close gift sharing"} onClick={dismiss}><X size={20} aria-hidden="true" /></button>
      </header>
      <div className="gift-share-body">
        {phase === "loading" ? <p className="gift-share-quiet" role="status">Checking what this book can include…</p> : null}
        {phase === "load-error" ? <button type="button" className="gift-share-secondary" onClick={() => setReload(value => value + 1)}>Reload contents</button> : null}
        {inventory && !created ? <>
          <div className="gift-share-book">
            <span className="gift-share-book-mark" aria-hidden="true"><Gift size={22} /></span>
            <div><h3>{inventory.title}</h3><p>Choose what to send. They keep their own copy on their device.</p></div>
          </div>
          <fieldset className="gift-share-group" disabled={phase === "creating"}>
            <legend>What to include</legend>
            <ul className="gift-share-assets">
              {inventory.assets.map((asset, index) => {
                const reason = giftAssetDisabledReason(asset, alignmentReady);
                const descriptionId = `gift-asset-reason-${index}`;
                const [name, Icon] = ASSET_NAMES[asset.kind];
                const note = reason ?? (asset.kind === "metadata" ? "Title, author and chapters. Always included." : asset.kind === "alignment" ? `Adds the ebook and ${audioCount === 1 ? "the audiobook" : `all ${audioCount} audio files`} so the text can follow the narration.` : null);
                const locked = asset.kind === "metadata" || !!reason;
                return <li className="gift-share-asset" data-locked={locked || undefined} key={asset.id}>
                  <label>
                    <input type="checkbox" checked={selected.includes(asset.id)} disabled={locked} aria-describedby={note ? descriptionId : undefined} onChange={event => {
                      const checked = event.currentTarget.checked;
                      if (checked && asset.kind === "alignment") {
                        try { const plan = alignmentGiftSelection(inventory, asset.id, selected, { alignmentReady }); if (plan.disabledReason) throw new Error(plan.disabledReason); setSelected(plan.selectedAssetIds); }
                        catch (failure) { setError(failure instanceof Error ? failure.message : "Alignment dependencies are unavailable."); }
                      } else setSelected(current => checked ? [...current, asset.id] : current.filter(id => id !== asset.id));
                    }} />
                    <Icon className="gift-share-asset-icon" size={18} aria-hidden="true" />
                    <span className="gift-share-asset-name"><strong>{name}</strong><small>{asset.fileName}</small></span>
                    <span className="gift-share-asset-size">{giftSizeLabel(asset.sizeBytes)}</span>
                  </label>
                  {note ? <p className="gift-share-asset-note" id={descriptionId}>{note}</p> : null}
                </li>;
              })}
            </ul>
          </fieldset>
          <fieldset className="gift-share-group" disabled={phase === "creating"}>
            <label className="gift-share-note-label" htmlFor="gift-share-note">Personal message (optional)</label>
            <textarea id="gift-share-note" className="gift-share-note" value={message} maxLength={4000} rows={4} placeholder="Write something for the inside cover" aria-describedby="gift-message-help" onChange={event => setMessage(event.currentTarget.value)} />
            <small id="gift-message-help" className="gift-share-quiet" data-over={messageLength > 1000 || undefined}>{messageLength}/1000. Only the person who opens the gift sees this.</small>
            {messageLength > 1000 ? <p role="alert" className="gift-share-alert">Shorten the message to 1000 characters or fewer.</p> : null}
          </fieldset>
          <fieldset className="gift-share-group" disabled={phase === "creating"}>
            <label className="gift-share-note-label" htmlFor="gift-expiry">Link works for</label>
            <select id="gift-expiry" className="gift-share-expiry" value={expiry} onChange={event => setExpiry(Number(event.currentTarget.value))}>
              {[[300, "5 minutes"], [900, "15 minutes"], [3600, "1 hour"], [21600, "6 hours"], [86400, "24 hours"]].map(([seconds, label]) => <option key={seconds} value={seconds}>{label}</option>)}
            </select>
          </fieldset>
          <p className="gift-share-quiet">Share only books you have permission to share. No DRM removal is provided. Protected files are left out when the server recognizes them, but this is not a guarantee of DRM detection. Gifts are experimental and only work in test builds.</p>
        </> : null}
        {created ? <section className="gift-share-created" aria-label="Created gift link">
          <p>Send this in a private message. Anyone with the link can open the gift until <strong>{expiryLabel(created.expiresAt)}</strong>.</p>
          <label className="gift-share-link-label" htmlFor="gift-share-link">Private gift URL</label>
          <textarea id="gift-share-link" className="gift-share-link" readOnly rows={3} value={created.giftUrl} onFocus={event => event.currentTarget.select()} />
          <button type="button" className="gift-share-primary" disabled={revocation !== "idle"} onClick={() => {
            if (!navigator.clipboard?.writeText) { setStatus("Select the link above and copy it."); return; }
            void navigator.clipboard.writeText(created.giftUrl).then(() => setStatus("Link copied. Paste it into a private message.")).catch(() => setStatus("Could not copy. Select the link above and copy it."));
          }}>Copy gift link</button>
          <div className="gift-share-revoke">
            <p>Changed your mind? Revoking stops the link from opening. A copy someone already accepted stays with them.</p>
            <button type="button" className="gift-share-secondary gift-share-danger" disabled={!revokeGift.current || revocation !== "idle"} onClick={() => void revoke()}>{revocation === "pending" ? "Revoking gift…" : revocation === "done" ? "Gift revoked" : "Revoke gift"}</button>
            {!revokeGift.current ? <p className="gift-share-quiet">This server can't revoke gifts. The link stops working when it expires.</p> : null}
          </div>
        </section> : null}
        {error ? <p role="alert" className="gift-share-alert">{error}</p> : null}
        {status ? <p role="status" className="gift-share-status">{status}</p> : null}
      </div>
      <footer className="gift-share-foot">
        {inventory && !created && summary ? <div className="gift-share-total" aria-live="polite" aria-label="Selected gift contents">
          <span>Gift size: {giftSizeLabel(summary.sizeBytes)}</span>
          <small>Up to {giftSizeLabel(inventory.maxBytes)}</small>
          {summary.errors.length ? <ul className="gift-share-problems">{summary.errors.map(problem => <li key={problem}>{problem}</li>)}</ul> : null}
        </div> : null}
        <div className="gift-share-actions">
          <button type="button" className="gift-share-secondary" onClick={dismiss}>{busy ? "Stop waiting" : created ? "Done" : "Cancel"}</button>
          {inventory && !created ? <button type="submit" className="gift-share-primary" disabled={phase !== "ready" || !!summary?.errors.length || messageLength > 1000}>{phase === "creating" ? "Creating gift…" : "Create gift link"}</button> : null}
        </div>
      </footer>
    </form>
  </div>;
}
