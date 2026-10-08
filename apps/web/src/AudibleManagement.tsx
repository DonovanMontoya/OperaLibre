import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, Download, ExternalLink, KeyRound, LoaderCircle, Plus, RefreshCcw, X } from "lucide-react";
import { cancelLibationLogin, completeLibationLogin, getLibationSetup, removeLibationAccount, setLibationAutoImport, startLibationLogin, updateLibationAccount } from "./api";
import { ApiError } from "./apiError";
import { errorMessage } from "./formatting";
import { libationHelp, validAudibleResponse } from "./libationHelp";
import { useModalFocus } from "./useModalFocus";
import type { usePurchases } from "./usePurchases";
import type { AuthUser, LibationAccount, LibationLoginStarted, LibationSetup, LibationStatus } from "./types";

const SETUP_DOCS = "https://donovanmontoya.github.io/OperaLibre/libation.html";
const MARKETPLACES = [["us", "United States"], ["uk", "United Kingdom"], ["ca", "Canada"], ["de", "Germany"], ["fr", "France"], ["au", "Australia"], ["jp", "Japan"], ["in", "India"], ["es", "Spain"]];

type ManagementProps = { currentUser: AuthUser; native: boolean; purchases: ReturnType<typeof usePurchases>; };

export function LibationError({ detail }: { detail: string; }) {
  return <div className="audible-error" role="alert">
    <p>{libationHelp(detail)}</p>
    <details><summary>Details</summary><pre>{detail}</pre></details>
  </div>;
}

function lastChecked(value: number | string | null | undefined) {
  const seconds = Number(value);
  return seconds > 0 ? new Date(seconds * 1000).toLocaleString() : "Never";
}

export function AudibleManagement({ currentUser, native, purchases }: ManagementProps) {
  const { downloadAllLibationJob, isRefreshingAudible, libationAllPending, libationError, libationLoading, libationRefreshPending, libationStatus, refreshLibationJob, startAllLiberation, startLibationSync, loadLibationStatus, setLibationStatus } = purchases;
  const [setup, setSetup] = useState<LibationSetup | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [login, setLogin] = useState<{ account?: LibationAccount; pending?: LibationLoginStarted; } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    if (currentUser.isAdmin) {
      setChecking(true);
      void getLibationSetup().then(result => { if (mounted.current) setSetup(result); })
        .catch(cause => { if (mounted.current) setError(errorMessage(cause, "Setup could not be checked.")); })
        .finally(() => { if (mounted.current) setChecking(false); });
    }
    return () => { mounted.current = false; };
  }, [currentUser.isAdmin]);

  async function checkSetup() {
    setChecking(true); setError(null);
    try { setSetup(await getLibationSetup()); await loadLibationStatus(); }
    catch (cause) { setError(errorMessage(cause, "Setup could not be checked.")); }
    finally { setChecking(false); }
  }

  async function changeAccount(id: string, action: () => Promise<LibationStatus | void>, message: string) {
    setBusy(id); setError(null); setNotice(null);
    try {
      const result = await action();
      if (result) setLibationStatus(result);
      else await loadLibationStatus();
      setEditing(null); setRemoving(null); setNotice(message);
    } catch (cause) { setError(errorMessage(cause, "The account could not be updated.")); }
    finally { setBusy(null); }
  }

  const pending = libationStatus?.pendingLogin;
  const enabled = !!libationStatus?.enabled;
  return <div className={native ? "store-settings-body audible-settings-body" : "purchase-console-body"}>
    {currentUser.isAdmin ? <div className="audible-setup">
      <div className="audible-section-head"><strong>Audible setup</strong><button type="button" className="quiet-button" disabled={checking} onClick={() => void checkSetup()}>{checking ? <LoaderCircle size={13} className="spin-icon" /> : <RefreshCcw size={13} />} Check setup</button></div>
      <ol className="audible-setup-steps">
        <li><span>{enabled ? <Check size={14} /> : "1"}</span><div><strong>Install Libation on the server</strong><p>{enabled ? "Libation was found. Your Audible credentials stay with Libation." : "Use the OperaLibre installer's --libation option, or configure an existing installation and restart."}</p></div></li>
        <li><span>{libationStatus?.accounts.some(account => account.authenticated) ? <Check size={14} /> : "2"}</span><div><strong>Connect your Audible account</strong><p>Sign in with Amazon below, or use accounts already connected in Libation.</p></div></li>
        <li><span>3</span><div><strong>Add purchases to your server library</strong><p>Choose titles in Get books → Audible. Download to this device separately for offline listening.</p></div></li>
      </ol>
      <details className="audible-setup-details"><summary>Installation and storage checks</summary>
        {setup?.checks.map(check => <div className="audible-check" key={check.id}>{check.ready ? <Check size={14} /> : <AlertCircle size={14} />}<div><strong>{check.label}</strong><p>{check.ready || check.id === "installed" || check.id === "settings" || check.id === "storage" ? check.message : libationHelp(check.message)}</p>{!check.ready && <details><summary>Details</summary><pre>{check.message}</pre></details>}</div></div>)}
        {!setup ? <p>{checking ? "Checking this server…" : "Choose Check setup to inspect this server."}</p> : null}
        {libationStatus?.cliPath ? <p className="settings-hint">Libation: <code>{libationStatus.cliPath}</code></p> : null}
        <a href={SETUP_DOCS} target="_blank" rel="noreferrer">Server setup instructions <ExternalLink size={12} /></a>
      </details>
      <div className="store-settings-actions">
        {pending ? <><button type="button" className="download-btn" onClick={() => setLogin({ pending, account: libationStatus?.accounts.find(account => account.id === pending.profileId) })}><KeyRound size={13} /> Continue sign-in</button><button type="button" className="quiet-button" disabled={!!busy} onClick={() => void changeAccount("cancel", () => cancelLibationLogin(pending.sessionId), "Sign-in cancelled.")}>Cancel sign-in</button></> : <button type="button" className="download-btn" disabled={!setup?.canSignIn || !!busy} onClick={() => setLogin({})}><Plus size={13} /> Connect Audible</button>}
      </div>
      {!pending && setup && !setup.canSignIn ? <p className="settings-hint">{setup.busy ? "Finish the current Libation operation, then check setup again to sign in." : "Check installation details above to enable browser sign-in. Accounts connected in Libation remain available."}</p> : null}
    </div> : null}
    {libationStatus?.accounts.length ? <div className="account-list audible-accounts">
      {libationStatus.accounts.map(account => <article key={account.id} className={account.authenticated ? "ok" : "warn"}>
        <span className="account-health-icon">{account.authenticated ? <KeyRound size={13} /> : <AlertCircle size={13} />}</span>
        <div className="account-list-copy">
          <strong>{account.name || account.accountId}</strong>
          <small>{account.locale.toUpperCase()}{account.connectionState === "signing_in" ? " · Signing in" : account.authenticated ? " · Connected" : account.connectionState === "error" ? " · Refresh error" : " · Sign-in required"}</small>
          {currentUser.isAdmin ? <>
            <small>Last refreshed: {lastChecked(account.lastSuccessfulRefresh ?? libationStatus.lastSuccessfulRefresh)}</small>
            {account.lastError ? <LibationError detail={account.lastError} /> : null}
            <div className="account-list-actions">
              {account.id !== "legacy" ? <button type="button" disabled={!setup?.canSignIn || !!busy || !!pending} onClick={() => setLogin({ account })}>Reconnect</button> : null}
              {account.managed ? <button type="button" disabled={!!busy || !!pending} onClick={() => { setEditing(editing === account.id ? null : account.id); setLabel(account.name ?? ""); }}>Rename</button> : <a href={SETUP_DOCS} target="_blank" rel="noreferrer">Managed in Libation <ExternalLink size={12} /></a>}
              {account.managed && currentUser.isOwner ? <button type="button" disabled={!!busy || !!pending} onClick={() => setRemoving(account.id)} className="danger">Disconnect</button> : null}
            </div>
            {editing === account.id ? <form className="audible-account-edit" onSubmit={event => { event.preventDefault(); void changeAccount(account.id, () => updateLibationAccount(account.id, label.trim()), "Account renamed."); }}><label>Account label<input value={label} maxLength={80} onChange={event => setLabel(event.currentTarget.value)} required /></label><button type="submit" className="quiet-button" disabled={!!busy || !label.trim()}>Save</button><button type="button" className="quiet-button" onClick={() => setEditing(null)}>Cancel</button></form> : null}
            {removing === account.id ? <div className="audible-disconnect"><p>Disconnect {account.name}? Downloaded books and listening progress stay in your library.</p><button type="button" className="quiet-button" disabled={!!busy} onClick={() => void changeAccount(account.id, () => removeLibationAccount(account.id), "Account disconnected.")}>Disconnect account</button><button type="button" className="quiet-button" onClick={() => setRemoving(null)}>Keep connected</button></div> : null}
            {currentUser.libationAccess === "direct" && account.id !== "legacy" ? <label className="audible-auto-import"><input type="checkbox" checked={libationStatus.autoImportAccountIds?.includes(account.id) ?? false} disabled={!!busy || !!pending || (!account.authenticated && !libationStatus.autoImportAccountIds?.includes(account.id))} onChange={event => { const value = event.currentTarget.checked; void changeAccount(account.id, () => setLibationAutoImport(account.id, value), value ? "Future purchases will be imported after a refresh." : "Automatic imports turned off."); }} /><span><strong>Automatically add new purchases</strong><small>Future purchases go to the server after a refresh. Existing purchases and Audible Plus titles stay manual. Reader access rules still apply.</small></span></label> : null}
          </> : null}
        </div>
      </article>)}
    </div> : null}
    {error || libationError ? <LibationError detail={error ?? libationError!} /> : null}
    {notice ? <p className="settings-hint" role="status">{notice}</p> : null}
    <div className="store-settings-actions">
      <button type="button" className="download-btn" onClick={() => void startLibationSync()} aria-busy={isRefreshingAudible} disabled={!enabled || libationLoading || libationRefreshPending || !!refreshLibationJob || !!pending}>
        {isRefreshingAudible ? <LoaderCircle size={13} className="spin-icon" /> : <RefreshCcw size={13} />}<span>{isRefreshingAudible ? "Refreshing purchases" : "Refresh purchases"}</span>
      </button>
      {currentUser.isAdmin && currentUser.libationAccess === "direct" ? <button type="button" className="download-btn" onClick={() => void startAllLiberation()} aria-busy={libationAllPending || !!downloadAllLibationJob} disabled={!enabled || libationLoading || libationAllPending || !!downloadAllLibationJob || !!pending}>
        {libationAllPending || downloadAllLibationJob ? <LoaderCircle size={13} className="spin-icon" /> : <Download size={13} />}<span>{libationAllPending || downloadAllLibationJob ? "Adding purchases" : "Add all purchases to server"}</span>
      </button> : null}
    </div>
    <p className="settings-hint">{libationStatus?.autoRefreshHours ? `Checks automatically every ${libationStatus.autoRefreshHours} hours.` : "Refresh manually to check for new purchases."}{currentUser.isAdmin ? ` Last successful refresh: ${lastChecked(libationStatus?.lastSuccessfulRefresh)}.` : ""}</p>
    {login ? <AudibleLoginDialog account={login.account} pending={login.pending} onClose={() => { setLogin(null); void checkSetup(); }} onConnected={status => { setLibationStatus(status); purchases.setLibationBooksLoaded(false); setNotice("Audible connected. Your purchases are refreshing."); setLogin(null); void checkSetup(); }} /> : null}
  </div>;
}

function AudibleLoginDialog({ account, pending, onClose, onConnected }: { account?: LibationAccount; pending?: LibationLoginStarted; onClose: () => void; onConnected: (status: LibationStatus) => void; }) {
  const [label, setLabel] = useState(account?.name?.trim() || (account ? "Audible account" : ""));
  const [accountId, setAccountId] = useState(account?.accountId ?? "");
  const [locale, setLocale] = useState(account?.locale || "us");
  const [session, setSession] = useState(pending ?? null);
  const [response, setResponse] = useState("");
  const [phase, setPhase] = useState<"idle" | "starting" | "completing" | "cancelling">("idle");
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const sessionRef = useRef(session);
  const phaseRef = useRef(phase);
  sessionRef.current = session;
  phaseRef.current = phase;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current && sessionRef.current && phaseRef.current !== "completing") void cancelLibationLogin(sessionRef.current.sessionId).catch(() => undefined);
      });
    };
  }, []);
  useEffect(() => {
    if (!session || phase === "completing") return;
    const timer = window.setTimeout(() => {
      void cancelLibationLogin(session.sessionId).catch(() => undefined);
      sessionRef.current = null; setSession(null); setResponse(""); setError("The Audible sign-in session expired. Start again.");
    }, Math.max(0, session.expiresAt * 1000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [phase, session]);

  async function close() {
    if (phaseRef.current === "completing" || phaseRef.current === "cancelling") return;
    const active = sessionRef.current;
    if (active) {
      phaseRef.current = "cancelling"; setPhase("cancelling"); sessionRef.current = null;
      await cancelLibationLogin(active.sessionId).catch(() => undefined);
    }
    onClose();
  }
  const dialogRef = useModalFocus<HTMLElement>(() => void close());

  async function start() {
    setPhase("starting"); setError(null);
    try {
      const next = await startLibationLogin({ profileId: account?.id, label: label.trim(), accountId: accountId.trim(), locale });
      if (!mounted.current) { await cancelLibationLogin(next.sessionId); return; }
      sessionRef.current = next; setSession(next);
    } catch (cause) { if (mounted.current) setError(errorMessage(cause, "Sign-in could not start.")); }
    finally { if (mounted.current) setPhase("idle"); }
  }

  async function complete() {
    if (!session) return;
    setPhase("completing"); setError(null);
    const finalUrl = response.trim(); setResponse("");
    try {
      const status = await completeLibationLogin(session.sessionId, finalUrl);
      sessionRef.current = null;
      if (mounted.current) onConnected(status);
    } catch (cause) {
      if (mounted.current) {
        setError(errorMessage(cause, "Sign-in could not finish."));
        if (!(cause instanceof ApiError && cause.status === 400)) { sessionRef.current = null; setSession(null); }
      }
    } finally { if (mounted.current) setPhase("idle"); }
  }

  return createPortal(<div className="modal-scrim audible-login-scrim" role="presentation"><section ref={dialogRef} tabIndex={-1} className="modal-card audible-login-dialog" role="dialog" aria-modal="true" aria-labelledby="audible-login-title" aria-describedby="audible-login-description">
    <div className="modal-head"><h2 id="audible-login-title">{account ? "Reconnect Audible" : "Connect Audible"}</h2><button type="button" className="icon-button" aria-label="Cancel Audible sign-in" disabled={phase === "completing" || phase === "cancelling"} onClick={() => void close()}><X size={18} /></button></div>
    <p id="audible-login-description">{session ? "Sign in on Amazon's website, then return here to finish connecting." : "OperaLibre uses Libation on your server. Your password is entered only on Amazon's website."}</p>
    {error ? <LibationError detail={error} /> : null}
    {!session ? <form className="audible-login-form" onSubmit={event => { event.preventDefault(); void start(); }}>
      <label>Account label<input aria-label="Account label" aria-describedby="audible-account-label-help" data-modal-initial-focus autoComplete="off" maxLength={80} value={label} disabled={phase !== "idle" || !!account && !account.managed} onChange={event => setLabel(event.currentTarget.value)} required /><small id="audible-account-label-help">A name such as Personal or Family, shown on your books.</small></label>
      <label>Audible email or login<input autoComplete="username" maxLength={320} value={accountId} disabled={phase !== "idle" || !!account} onChange={event => setAccountId(event.currentTarget.value)} required /></label>
      <label>Marketplace<select value={locale} disabled={phase !== "idle" || !!account} onChange={event => setLocale(event.currentTarget.value)}>{MARKETPLACES.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      <div className="store-settings-actions"><button type="submit" className="download-btn" disabled={phase !== "idle" || !label.trim() || !accountId.trim()}>{phase === "starting" ? <LoaderCircle size={14} className="spin-icon" /> : <KeyRound size={14} />}{phase === "starting" ? "Preparing sign-in…" : "Continue to Amazon"}</button><button type="button" className="quiet-button" onClick={() => void close()}>Cancel</button></div>
    </form> : <form className="audible-login-form" onSubmit={event => { event.preventDefault(); void complete(); }}>
      <ol className="audible-sign-in-steps"><li><strong>Open Amazon and sign in</strong><p><a className="download-btn" href={session.loginUrl} target="_blank" rel="noreferrer">Open Amazon sign-in <ExternalLink size={14} /></a></p></li><li><strong>Copy the final address</strong><p>After signing in, Amazon may show a blank page or say the page cannot open. Copy the complete address from the browser's address bar, then return here.</p></li><li><label>Paste the final sign-in address<textarea data-modal-initial-focus autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={16384} value={response} disabled={phase === "completing"} onChange={event => setResponse(event.currentTarget.value)} rows={3} /><small>This address completes sign-in and is not saved in your browser.</small></label></li></ol>
      <div className="store-settings-actions"><button type="submit" className="download-btn" disabled={phase === "completing" || !validAudibleResponse(response)}>{phase === "completing" ? <LoaderCircle size={14} className="spin-icon" /> : <Check size={14} />}{phase === "completing" ? "Finishing sign-in…" : "Finish connecting"}</button><button type="button" className="quiet-button" disabled={phase === "completing" || phase === "cancelling"} onClick={() => void close()}>Cancel sign-in</button></div>
      {phase === "completing" ? <p role="status">Libation is completing the connection. This can take a moment.</p> : null}
    </form>}
    <p className="settings-hint">Having trouble? Connect this account in Libation on the server and choose Refresh purchases in OperaLibre. <a href={SETUP_DOCS} target="_blank" rel="noreferrer">Sign-in help</a></p>
  </section></div>, document.body);
}
