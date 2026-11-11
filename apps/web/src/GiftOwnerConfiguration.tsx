import { useEffect, useRef, useState, type FormEvent } from "react";
import { abandonConfiguredGiftSenders, captureGiftOwnerSetupGuard, cleanupConfiguredGiftBroker, deleteGiftOwnerConfiguration, getGiftOwnerConfiguration, recoverConfiguredGiftSenders, saveGiftOwnerConfiguration } from "./api";
import { giftConnectivityEdit, giftOwnerConfigurationRequest, parseGiftOwnerConfiguration, type GiftOwnerConfiguration as Configuration, type GiftOwnerConfigurationRequest } from "./giftOwnerSetupModel";
import "./giftOwnerSetup.css";

export type GiftOwnerSetupApi = { captureGuard?: () => () => boolean; load(signal: AbortSignal): Promise<Configuration>; save(input: GiftOwnerConfigurationRequest, signal: AbortSignal): Promise<Configuration>; remove(signal: AbortSignal): Promise<void>; cleanup(signal: AbortSignal): Promise<{ completed: number; pending: number }>; recover?(signal: AbortSignal): Promise<{ recovered: number; alreadyActive: number; pending: number }>; abandon?(signal: AbortSignal): Promise<{ abandoned: number; completed: number; pending: number }> };
const setupApi: GiftOwnerSetupApi = { captureGuard: captureGiftOwnerSetupGuard, load: getGiftOwnerConfiguration, save: saveGiftOwnerConfiguration, remove: deleteGiftOwnerConfiguration, cleanup: cleanupConfiguredGiftBroker, recover: recoverConfiguredGiftSenders, abandon: abandonConfiguredGiftSenders };

export function GiftOwnerConfiguration({ secure, api = setupApi }: { secure: boolean; api?: GiftOwnerSetupApi }) {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [broker, setBroker] = useState("");
  const [allowReaders, setAllowReaders] = useState(false);
  const [retainSenderState, setRetainSenderState] = useState(false);
  const [autoRecoverSenders, setAutoRecoverSenders] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [abandonConfirmed, setAbandonConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [changeIce, setChangeIce] = useState(false);
  const [stunUrl, setStunUrl] = useState("");
  const [turnUrl, setTurnUrl] = useState("");
  const [relayAllowed, setRelayAllowed] = useState(false);
  const [requireRelay, setRequireRelay] = useState(false);
  const secret = useRef<HTMLInputElement>(null);
  const turnSecret = useRef<HTMLInputElement>(null);
  const pending = useRef(new Set<AbortController>());
  const operating = useRef(false);
  const sameServer = useRef<(() => boolean) | null>(null);
  useEffect(() => { const requests = pending.current; return () => { for (const controller of requests) controller.abort(); requests.clear(); }; }, []);

  function apply(value: Configuration) {
    const redacted = parseGiftOwnerConfiguration(value);
    setConfiguration(redacted); setBroker(redacted.brokerOrigin ?? ""); setAllowReaders(redacted.allowReaders); setConfirmed(false); setDeleteConfirmed(false);
    setRetainSenderState(redacted.retainSenderState === true);
    setAutoRecoverSenders(redacted.autoRecoverSenders === true);
    setAbandonConfirmed(false);
    setChangeIce(false); setStunUrl(""); setTurnUrl(""); setRelayAllowed(false); setRequireRelay(false);
    if (turnSecret.current) turnSecret.current.value = "";
  }
  async function run(kind: "load" | "save" | "delete" | "cleanup" | "recover" | "abandon", input?: GiftOwnerConfigurationRequest) {
    if (!secure || operating.current) return;
    if (kind === "load") sameServer.current = api.captureGuard?.() ?? (() => true);
    else if (!sameServer.current?.()) { setConfiguration(null); setMessage("The connected server or sign-in changed. Reload redacted setup before sending credentials or changing configuration."); return; }
    operating.current = true; setBusy(true); setMessage("");
    const controller = new AbortController(); pending.current.add(controller);
    try {
      if (kind === "load") { const response = await api.load(controller.signal); if (!controller.signal.aborted) { if (!sameServer.current?.()) { setConfiguration(null); throw new Error("setup context changed"); } apply(response); setMessage("Loaded redacted server configuration. This is not a broker, relay, domain or billing test; sharing remains disabled."); } }
      else if (kind === "save") { const response = await api.save(input!, controller.signal); if (!controller.signal.aborted) { apply(response); setMessage("Configuration saved privately on this server. Sharing remains disabled. No deployment, broker or relay probe was performed."); } }
      else if (kind === "delete") { await api.remove(controller.signal); if (!controller.signal.aborted) { setConfiguration(null); setBroker(""); setAllowReaders(false); setConfirmed(false); setDeleteConfirmed(false); setMessage("Configuration removed from the active server document. Server backups may still contain credentials. This does not revoke external provider credentials or invitations, shut down infrastructure, or cancel provider billing."); } }
      else if (kind === "recover") { if (!api.recover) throw new Error("Unavailable sender recovery"); const result = await api.recover(controller.signal); if (!controller.signal.aborted) setMessage(`Retained sender recovery: ${result.recovered} started; ${result.alreadyActive} already active; ${result.pending} pending. This does not prove a recipient connected or imported the book. Production sharing remains disabled.`); }
      else if (kind === "abandon") { if (!api.abandon || !abandonConfirmed) throw new Error("Confirmation required"); const result = await api.abandon(controller.signal); if (!controller.signal.aborted) { setAbandonConfirmed(false); setMessage(`Retained gifts revoked: ${result.abandoned}; broker cleanup completed: ${result.completed}; pending: ${result.pending}. Local retained copies are removed only after confirmed cleanup or expiry. Recipient copies and external backups cannot be recalled.`); } }
      else { const result = await api.cleanup(controller.signal); if (!controller.signal.aborted) setMessage(`Stored-credential cleanup completed: ${result.completed}; still pending: ${result.pending}. Sharing remains disabled.`); }
    } catch {
      if (!controller.signal.aborted) setMessage("Action could not be confirmed. Experimental routes may be unavailable or owner authorization may have failed. Saving credentials requires a trusted HTTPS reverse proxy on loopback and server proxy deployment mode; LAN/Tailscale HTTP is not accepted. Pending broker rooms can block save/delete (409): recover valid retained gifts, or explicitly revoke/abandon them and retry cleanup. Cleanup retries do not abandon recoverable gifts. A timed-out mutation may have completed—reload redacted configuration before retrying.");
    } finally { pending.current.delete(controller); operating.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const entered = secret.current?.value ?? "";
    const enteredTurnSecret = turnSecret.current?.value ?? "";
    if (secret.current) secret.current.value = "";
    if (turnSecret.current) turnSecret.current.value = "";
    if (!configuration || !secure || operating.current) return;
    try {
      const input = giftOwnerConfigurationRequest({ brokerInput: broker, ownerSecret: entered, allowReaders, ownerConfirmed: confirmed, existing: configuration });
      const connectivity = giftConnectivityEdit({ changeIce, stunUrl, turnUrl, turnRestSecret: enteredTurnSecret, relayAllowed, requireRelay });
      void run("save", { ...input, retainSenderState, autoRecoverSenders, ...(connectivity !== undefined ? { connectivity } : {}) });
    }
    catch (failure) { setMessage(failure instanceof Error ? failure.message : "Check the gift configuration."); }
  }

  return <section className="gift-owner-configuration" aria-label="Saved experimental gift setup">
    <p>Optional test-server configuration. Nothing is fetched until you choose Load saved setup. Saves do not deploy infrastructure or enable sharing.</p>
    <p>Credentials are stored in the server's private SQLite database and its backups, never returned here. Protect those files and rotate credentials if a backup is exposed. Leave Change ICE unchecked to retain all existing connectivity entries and private TURN secrets.</p>
    {!secure ? <p role="status">Setup actions require the same secure HTTPS page and direct HTTPS server connection as cleanup. Do not send a broker or TURN secret over LAN/Tailscale HTTP or a development proxy.</p> : null}
    <button type="button" disabled={!secure || busy} onClick={() => void run("load")}>Load saved setup</button>
    {configuration ? <>
      <p>Server configuration: {configuration.configured ? "Stored" : "Not configured"}. Owner secret: {configuration.ownerSecretConfigured ? "Configured (not returned)" : "Not configured"}. Production sharing: disabled.</p>
      <details><summary>Redacted connectivity (not a connection test)</summary><p>Relay allowed: {configuration.connectivity.relayAllowed ? "yes" : "no"}; relay required: {configuration.connectivity.requireRelay ? "yes" : "no"}. No quota or spending cap is verified.</p>
        {configuration.connectivity.iceServers.length ? <ul>{configuration.connectivity.iceServers.map((server, index) => <li key={index}><span style={{ overflowWrap: "anywhere" }}>{server.urls.join(", ")}</span><p>Username configured: {server.usernameConfigured ? "yes" : "no"}; credential configured: {server.credentialConfigured ? "yes" : "no"}; coturn TURN REST shared secret configured: {server.turnRestSecretConfigured ? "yes" : "no"}.</p></li>)}</ul> : <p>No ICE server URLs configured. This does not prove that direct peers can connect.</p>}
        <p>The current runtime supports UDP STUN and UDP TURN only. TCP/TLS and static TURN credentials are unsupported. Owner-configured coturn TURN REST shared secrets are private server settings, not Cloudflare API tokens; do not paste them into gift links. Cloudflare Realtime TURN API credential minting is not implemented. There is no free-operation guarantee or hard billing cap; NAT fallback has not been verified outside the reported tests.</p>
      </details>
      <form className="admin-sync-schedule-form" onSubmit={save} autoComplete="off" noValidate><fieldset disabled={!secure || busy}>
        <label>Saved broker HTTPS origin<input type="url" value={broker} maxLength={512} required onChange={event => { setBroker(event.currentTarget.value); setConfirmed(false); }} /></label>
        <label>New broker owner secret<input ref={secret} type="password" autoComplete="new-password" maxLength={1024} /></label>
        <p>32–1024 printable ASCII characters without spaces. Leave blank only to retain the current secret for this same broker. No masked placeholder is sent. This field is cleared on submit, including invalid submissions.</p>
        <label className="gift-owner-configuration__check"><input type="checkbox" checked={allowReaders} onChange={event => setAllowReaders(event.currentTarget.checked)} /><span>Experimental policy: allow authorized non-owner readers to create gifts (off by default; does not enable production sharing)</span></label>
        <label className="gift-owner-configuration__check"><input type="checkbox" checked={retainSenderState} onChange={event => { setRetainSenderState(event.currentTarget.checked); if (!event.currentTarget.checked) setAutoRecoverSenders(false); }} /><span>Retain private selected archives and signing/decryption keys for sender restart recovery (off by default)</span></label>
        <label className="gift-owner-configuration__check"><input type="checkbox" disabled={!retainSenderState} checked={autoRecoverSenders} onChange={event => setAutoRecoverSenders(event.currentTarget.checked)} /><span>Automatically recover retained gift senders after server restart (contacts your broker; off by default)</span></label>
        <p>Retained gift files and keys are sensitive data in the server data directory. Protect this directory and any system backups; restoring only the server database does not restore these archives. Recovery rechecks invitation expiry, revocation, current book access and broker membership; it cannot extend an invitation. Only the separate automatic-recovery opt-in authorizes startup connections to your configured broker. Production sharing and automatic recovery remain disabled in this build. Storage and provider charges remain your responsibility.</p>
        <label className="gift-owner-configuration__check"><input type="checkbox" checked={changeIce} onChange={event => {
          if (turnSecret.current) turnSecret.current.value = "";
          setChangeIce(event.currentTarget.checked);
          setStunUrl(""); setTurnUrl(""); setRelayAllowed(false); setRequireRelay(false);
        }} /><span>Change ICE (replace all saved connectivity entries)</span></label>
        {changeIce ? <fieldset className="gift-owner-configuration__advanced"><legend>Advanced: owner-controlled UDP connectivity</legend>
          <p>This replaces the entire saved configuration with at most one STUN and one coturn TURN entry. No redacted credential marker is copied into a secret field. Leave Change ICE unchecked to preserve multi-server settings unchanged.</p>
          <label>UDP STUN URL (optional)<input type="text" inputMode="url" autoCapitalize="none" spellCheck={false} value={stunUrl} maxLength={512} placeholder="stun:stun.example:3478" onChange={event => setStunUrl(event.currentTarget.value)} /></label>
          <label>UDP coturn TURN URL (optional)<input type="text" inputMode="url" autoCapitalize="none" spellCheck={false} value={turnUrl} maxLength={512} placeholder="turn:relay.example:3478?transport=udp" onChange={event => { if (turnSecret.current) turnSecret.current.value = ""; setTurnUrl(event.currentTarget.value); }} /></label>
          <label>Private coturn TURN REST shared secret<input ref={turnSecret} type="password" autoComplete="new-password" maxLength={512} /></label>
          <p>32–512 printable ASCII characters without spaces; not a Cloudflare API token or static TURN password. Re-enter the full secret whenever TURN is included in a replacement, including an unchanged URL. Both password fields clear on every submission; this secret also clears when the TURN URL changes or Change ICE is switched off.</p>
          <label className="gift-owner-configuration__check"><input type="checkbox" checked={relayAllowed} onChange={event => setRelayAllowed(event.currentTarget.checked)} /><span>Allow this owner's UDP TURN relay (possible provider charges)</span></label>
          <label className="gift-owner-configuration__check"><input type="checkbox" checked={requireRelay} onChange={event => setRequireRelay(event.currentTarget.checked)} /><span>Require relay rather than direct peers</span></label>
          <p>Only UDP is supported. TCP/TLS URLs and Cloudflare Realtime TURN API credential minting are not implemented. The relay must be reachable by recipients outside your LAN/Tailscale; these fields perform no connectivity or provider diagnostics and do not guarantee NAT fallback, free service or a hard billing cap.</p>
          <p>Saving blank URLs with both relay options off explicitly clears private connectivity from the active server configuration (host-only peers). It does not revoke provider credentials, erase backups, shut down infrastructure or stop provider billing.</p>
        </fieldset> : null}
        <label className="gift-owner-configuration__check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.currentTarget.checked)} /><span>I control this broker and accept responsibility for its infrastructure, credentials and possible charges.</span></label>
        <button type="submit" disabled={!confirmed}>Save private server configuration</button>
      </fieldset></form>
      {configuration.configured ? <div className="gift-owner-configuration__actions">
        <button type="button" disabled={!secure || busy || !configuration.retainSenderState || !api.recover} onClick={() => void run("recover")}>Recover retained gift senders</button>
        <p>Explicitly contacts the saved broker after a sender restart. Unexpired retained invitations keep the same gift link, archive and pinned signing identity; a new broker generation discards stale signaling. Retention does not automatically start a sender on server boot.</p>
        <button type="button" disabled={!secure || busy} onClick={() => void run("cleanup")}>Retry cleanup using saved credentials</button>
        <p>This explicit action contacts the broker using credentials already stored on this server. It is not performed during load/save.</p>
        <p>Cleanup retries preserve valid dormant gifts that can still recover. To abandon them instead, confirm the separate action below. It affects every retained gift on this configured broker, including gifts created by allowed readers, and cannot recall an accepted recipient copy.</p>
        <label className="gift-owner-configuration__check"><input type="checkbox" checked={abandonConfirmed} disabled={!secure || busy} onChange={event => setAbandonConfirmed(event.currentTarget.checked)} /><span>Revoke all retained gifts on this broker and discard their local sender copies after confirmed cleanup</span></label>
        <button type="button" disabled={!secure || busy || !abandonConfirmed || !api.abandon} onClick={() => void run("abandon")}>Abandon retained gifts</button>
        <label className="gift-owner-configuration__check"><input type="checkbox" checked={deleteConfirmed} disabled={!secure || busy} onChange={event => setDeleteConfirmed(event.currentTarget.checked)} /><span>I understand removal does not erase backups or revoke invitations.</span></label>
        <button type="button" disabled={!secure || busy || !deleteConfirmed} onClick={() => void run("delete")}>Remove saved gift setup</button>
      </div> : null}
    </> : null}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
