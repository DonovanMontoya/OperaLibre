import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { abandonConfiguredGiftSenders, captureGiftOwnerSetupGuard, cleanupConfiguredGiftBroker, deleteGiftOwnerConfiguration, getGiftOwnerConfiguration, installGiftBrokerOnCloudflare, recoverConfiguredGiftSenders, saveGiftOwnerConfiguration } from "./api";
import { giftConnectivityEdit, giftOwnerConfigurationRequest, parseGiftOwnerConfiguration, type GiftOwnerConfiguration as Configuration, type GiftOwnerConfigurationRequest } from "./giftOwnerSetupModel";
import "./giftOwnerSetup.css";

export type GiftOwnerSetupApi = { captureGuard?: () => () => boolean; load(signal: AbortSignal): Promise<Configuration>; install?(input: { apiToken: string; accountId?: string }, signal: AbortSignal): Promise<Configuration>; save(input: GiftOwnerConfigurationRequest, signal: AbortSignal): Promise<Configuration>; remove(signal: AbortSignal): Promise<void>; cleanup(signal: AbortSignal): Promise<{ completed: number; pending: number }>; recover?(signal: AbortSignal): Promise<{ recovered: number; alreadyActive: number; pending: number }>; abandon?(signal: AbortSignal): Promise<{ abandoned: number; completed: number; pending: number }> };
const setupApi: GiftOwnerSetupApi = { captureGuard: captureGiftOwnerSetupGuard, load: getGiftOwnerConfiguration, install: installGiftBrokerOnCloudflare, save: saveGiftOwnerConfiguration, remove: deleteGiftOwnerConfiguration, cleanup: cleanupConfiguredGiftBroker, recover: recoverConfiguredGiftSenders, abandon: abandonConfiguredGiftSenders };
type Action = "load" | "save" | "install" | "delete" | "cleanup" | "recover" | "abandon";
// Opens Cloudflare's token form with only the one permission the broker needs.
const CLOUDFLARE_TOKEN_LINK = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent('[{"key":"workers_scripts","type":"edit"}]')}&accountId=${encodeURIComponent("*")}&zoneId=all&name=${encodeURIComponent("OperaLibre book gifts")}`;

function connectionSummary(connectivity: Configuration["connectivity"]) {
  const urls = connectivity.iceServers.flatMap(server => server.urls);
  if (!urls.length) return "Direct connections only, with no STUN or TURN server.";
  return `${urls.join(", ")}. ${connectivity.requireRelay ? "Every gift goes through the TURN relay." : connectivity.relayAllowed ? "The TURN relay is used when a direct connection fails." : "Direct connections only."}`;
}

/** Broker and connection settings for book gifts. Secrets go to the server
 * only over HTTPS, are never returned, and are cleared from the form on submit. */
export function GiftOwnerConfiguration({ secure, api = setupApi, onChanged }: { secure: boolean; api?: GiftOwnerSetupApi; onChanged?: () => void }) {
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
  const cloudflareToken = useRef<HTMLInputElement>(null);
  const [cloudflareAccount, setCloudflareAccount] = useState("");
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
  async function run(kind: Action, input?: GiftOwnerConfigurationRequest, cloudflare?: { apiToken: string; accountId?: string }) {
    if (!secure || operating.current) return;
    if (kind === "load") sameServer.current = api.captureGuard?.() ?? (() => true);
    else if (!sameServer.current?.()) { setConfiguration(null); setMessage("The connected server or sign-in changed. Reload these settings before saving."); return; }
    operating.current = true; setBusy(true); setMessage("");
    const controller = new AbortController(); pending.current.add(controller);
    try {
      if (kind === "load") { const response = await api.load(controller.signal); if (!controller.signal.aborted) { if (!sameServer.current?.()) { setConfiguration(null); throw new Error("setup context changed"); } apply(response); } }
      else if (kind === "save") { const response = await api.save(input!, controller.signal); if (!controller.signal.aborted) { apply(response); setMessage("Saved. Gifts can be sent from a book's page."); onChanged?.(); } }
      else if (kind === "install") { if (!api.install || !cloudflare) throw new Error("Cloudflare setup is unavailable."); const response = await api.install(cloudflare, controller.signal); if (!controller.signal.aborted) { apply(response); setCloudflareAccount(""); setMessage("Your broker is installed and gifts are ready. Send one from a book's page. A brand new broker can take a minute to answer."); onChanged?.(); } }
      else if (kind === "delete") { await api.remove(controller.signal); if (!controller.signal.aborted) { apply({ configured: false, brokerOrigin: null, ownerSecretConfigured: false, allowReaders: false, productionEnabled: false, connectivity: { iceServers: [], relayAllowed: false, requireRelay: false } }); setMessage("Setup removed from this server. Server backups may still contain the secrets, and your broker keeps running until you delete it."); onChanged?.(); } }
      else if (kind === "recover") { if (!api.recover) throw new Error("Unavailable sender recovery"); const result = await api.recover(controller.signal); if (!controller.signal.aborted) setMessage(`Kept gifts: ${result.recovered} started; ${result.alreadyActive} already active; ${result.pending} pending.`); }
      else if (kind === "abandon") { if (!api.abandon || !abandonConfirmed) throw new Error("Confirmation required"); const result = await api.abandon(controller.signal); if (!controller.signal.aborted) { setAbandonConfirmed(false); setMessage(`Kept gifts cancelled: ${result.abandoned}. Broker cleanup completed: ${result.completed}; pending: ${result.pending}. Copies a recipient already accepted cannot be recalled.`); } }
      else { const result = await api.cleanup(controller.signal); if (!controller.signal.aborted) setMessage(`Broker cleanup completed: ${result.completed}; still pending: ${result.pending}.`); }
    } catch (failure) {
      if (!controller.signal.aborted) setMessage(kind === "load"
        ? "Gift settings could not be loaded."
        : kind === "install" ? (failure instanceof Error && failure.message ? failure.message : "Cloudflare setup could not be confirmed. Reload before trying again.")
        : "That could not be confirmed. Saving secrets needs the server in proxy deployment mode behind an HTTPS reverse proxy on the same machine. Gifts that are still waiting can also block a change: cancel them or retry cleanup first. A request that timed out may still have gone through, so reload before trying again.");
    } finally { pending.current.delete(controller); operating.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  // Reading the redacted settings sends no secret and contacts no broker.
  const load = useRef(run);
  load.current = run;
  useEffect(() => { if (secure) void load.current("load"); }, [secure]);

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
    catch (failure) { setMessage(failure instanceof Error ? failure.message : "Check the gift settings."); }
  }

  function install(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const apiToken = (cloudflareToken.current?.value ?? "").trim();
    if (cloudflareToken.current) cloudflareToken.current.value = "";
    if (!configuration || !secure || operating.current) return;
    if (!apiToken) { setMessage("Paste the Cloudflare API token first."); return; }
    const accountId = cloudflareAccount.trim();
    void run("install", undefined, { apiToken, ...(accountId ? { accountId } : {}) });
  }
  const cloudflare = api.install ? <form onSubmit={install} autoComplete="off" noValidate><fieldset disabled={busy}>
    <h4>{configuration?.configured ? "Update or reinstall the broker" : "Set up with Cloudflare"}</h4>
    <p>{configuration?.configured
      ? "Installs the current broker again in your Cloudflare account, with new secrets. Do this after a server update that changes gifts. Links you have already sent stop working."
      : "Gifts need a small broker that introduces your server and the recipient's phone. OperaLibre installs it in your own Cloudflare account. A free account is enough for personal use."}</p>
    <ol className="gift-owner-configuration__steps">
      <li><a href={CLOUDFLARE_TOKEN_LINK} target="_blank" rel="noreferrer">Create a Cloudflare token</a>. Sign in or make a free account, then choose <strong>Continue to summary</strong> and <strong>Create Token</strong>.</li>
      <li>Copy the token and paste it here.</li>
    </ol>
    <label>Cloudflare API token<input ref={cloudflareToken} type="password" autoComplete="new-password" maxLength={512} /><small>Used once to install the broker, then forgotten. It is not stored on this server, and you can delete it in Cloudflare afterwards.</small></label>
    <details><summary>More than one Cloudflare account?</summary>
      <label>Account ID (optional)<input type="text" autoCapitalize="none" spellCheck={false} value={cloudflareAccount} maxLength={64} onChange={event => setCloudflareAccount(event.currentTarget.value)} /><small>Shown in the Cloudflare dashboard under Workers &amp; Pages. Only needed when the token works for several accounts.</small></label>
    </details>
    <button type="submit" className="gift-owner-configuration__primary">{busy ? "Setting up…" : configuration?.configured ? "Reinstall broker" : "Set up gifts"}</button>
  </fieldset></form> : null;

  if (!secure) return <section className="gift-owner-configuration" aria-label="Book gift setup">
    <p role="status">Open OperaLibre in a browser over HTTPS to set up gifts. The broker secret is never sent over plain HTTP, and the phone apps cannot change these settings.</p>
  </section>;

  // With no broker yet, the Cloudflare setup leads and the manual form is the alternative.
  const manual = (form: ReactNode) => configuration?.configured || !cloudflare ? form : <details><summary>Use a broker you deployed yourself</summary>{form}</details>;

  return <section className="gift-owner-configuration" aria-label="Book gift setup">
    {!configuration ? <>
      {busy ? <p role="status">Loading gift settings…</p> : null}
      {!busy ? <button type="button" onClick={() => void run("load")}>Reload gift settings</button> : null}
    </> : <>
      {configuration.configured ? null : cloudflare}
      {manual(<form onSubmit={save} autoComplete="off" noValidate><fieldset disabled={busy}>
        <h4>{configuration.configured ? "Your gift broker" : "Connect your gift broker"}</h4>
        <label>Broker address<input type="url" inputMode="url" autoCapitalize="none" spellCheck={false} value={broker} maxLength={512} required placeholder="https://operalibre-share-broker.example.workers.dev" onChange={event => { setBroker(event.currentTarget.value); setConfirmed(false); }} /></label>
        <label>Broker owner secret<input ref={secret} type="password" autoComplete="new-password" maxLength={1024} /><small>{configuration.ownerSecretConfigured ? "Saved. Leave blank to keep it." : "The secret you chose when you deployed the broker, 32 characters or more."}</small></label>
        <label className="gift-owner-configuration__check"><input type="checkbox" checked={allowReaders} onChange={event => setAllowReaders(event.currentTarget.checked)} /><span>Let readers send gifts too<small>Readers can gift only books they can already open. Off means only you can send.</small></span></label>

        <details><summary>Connection servers</summary>
          <p>{connectionSummary(configuration.connectivity)}</p>
          <p>A STUN server lets two devices behind home routers find each other. A TURN relay carries the book when they still cannot connect, and may cost money. Only UDP servers work.</p>
          <label className="gift-owner-configuration__check"><input type="checkbox" checked={changeIce} onChange={event => {
            if (turnSecret.current) turnSecret.current.value = "";
            setChangeIce(event.currentTarget.checked);
            setStunUrl(""); setTurnUrl(""); setRelayAllowed(false); setRequireRelay(false);
          }} /><span>Replace the connection servers<small>Whatever you enter below replaces every saved server.</small></span></label>
          {changeIce ? <fieldset className="gift-owner-configuration__advanced">
            <label>STUN server (optional)<input type="text" inputMode="url" autoCapitalize="none" spellCheck={false} value={stunUrl} maxLength={512} placeholder="stun:stun.cloudflare.com:3478" onChange={event => setStunUrl(event.currentTarget.value)} /></label>
            <label>TURN relay (optional)<input type="text" inputMode="url" autoCapitalize="none" spellCheck={false} value={turnUrl} maxLength={512} placeholder="turn:relay.example:3478?transport=udp" onChange={event => { if (turnSecret.current) turnSecret.current.value = ""; setTurnUrl(event.currentTarget.value); }} /></label>
            <label>TURN shared secret<input ref={turnSecret} type="password" autoComplete="new-password" maxLength={512} /><small>The coturn <code>static-auth-secret</code>, 32 characters or more. Enter it again whenever you save a TURN relay.</small></label>
            <label className="gift-owner-configuration__check"><input type="checkbox" checked={relayAllowed} onChange={event => setRelayAllowed(event.currentTarget.checked)} /><span>Allow the TURN relay</span></label>
            <label className="gift-owner-configuration__check"><input type="checkbox" checked={requireRelay} onChange={event => setRequireRelay(event.currentTarget.checked)} /><span>Always use the relay<small>Hides this server's address from recipients.</small></span></label>
          </fieldset> : null}
        </details>

        <details><summary>Server restarts</summary>
          <p>A gift link normally stops working if the server restarts before it is opened.</p>
          <label className="gift-owner-configuration__check"><input type="checkbox" checked={retainSenderState} onChange={event => { setRetainSenderState(event.currentTarget.checked); if (!event.currentTarget.checked) setAutoRecoverSenders(false); }} /><span>Keep waiting gifts across restarts<small>Stores each waiting gift and its keys in the server's data folder until it is received or expires.</small></span></label>
          <label className="gift-owner-configuration__check"><input type="checkbox" disabled={!retainSenderState} checked={autoRecoverSenders} onChange={event => setAutoRecoverSenders(event.currentTarget.checked)} /><span>Resume them automatically at startup</span></label>
        </details>

        <label className="gift-owner-configuration__check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.currentTarget.checked)} /><span>I run this broker and accept its costs.</span></label>
        <button type="submit" className="gift-owner-configuration__primary" disabled={!confirmed}>{busy ? "Saving…" : "Save gift setup"}</button>
        <p className="gift-owner-configuration__quiet">Secrets are stored in this server's database and its backups, and are never shown again.</p>
      </fieldset></form>)}
      {configuration.configured && cloudflare ? <details><summary>Update or reinstall the broker</summary>{cloudflare}</details> : null}
      {configuration.configured ? <details><summary>Maintenance</summary><div className="gift-owner-configuration__actions">
        <div><button type="button" disabled={busy || !configuration.retainSenderState || !api.recover} onClick={() => void run("recover")}>Resume kept gifts</button>
          <p>Restarts gifts that were kept across a server restart. Their links stay the same.</p></div>
        <div><button type="button" disabled={busy} onClick={() => void run("cleanup")}>Retry broker cleanup</button>
          <p>Tells the broker again about gifts you revoked while it was unreachable.</p></div>
        <div><label className="gift-owner-configuration__check"><input type="checkbox" checked={abandonConfirmed} disabled={busy} onChange={event => setAbandonConfirmed(event.currentTarget.checked)} /><span>Cancel every kept gift, including readers' gifts</span></label>
          <button type="button" disabled={busy || !abandonConfirmed || !api.abandon} onClick={() => void run("abandon")}>Cancel kept gifts</button></div>
        <div><label className="gift-owner-configuration__check"><input type="checkbox" checked={deleteConfirmed} disabled={busy} onChange={event => setDeleteConfirmed(event.currentTarget.checked)} /><span>Remove the broker from this server<small>Backups keep the old secrets, and gifts already sent are not revoked.</small></span></label>
          <button type="button" disabled={busy || !deleteConfirmed} onClick={() => void run("delete")}>Remove gift setup</button></div>
      </div></details> : null}
    </>}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
