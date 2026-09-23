import type { usePurchases } from "./usePurchases";
import { AlertCircle, Download, KeyRound, LoaderCircle, RefreshCcw } from "lucide-react";
import type { AuthUser } from "./types";

export function renderAudibleManagement({
  currentUser,
  native,
  purchases
}: {
  currentUser: AuthUser;
  native: boolean;
  purchases: ReturnType<typeof usePurchases>;
}) {
  const {
    downloadAllLibationJob,
    isRefreshingAudible,
    libationAllPending,
    libationError,
    libationLoading,
    libationRefreshPending,
    libationStatus,
    refreshLibationJob,
    startAllLiberation,
    startLibationSync
  } = purchases;

  return (
    <div className={native ? "store-settings-body audible-settings-body" : "purchase-console-body"}>
      <p className="settings-hint">Add or reconnect Audible accounts in Libation. OperaLibre uses those connections to refresh purchases.</p>
      {libationStatus?.accounts.length ? <div className="account-list">
        {libationStatus.accounts.map((account) => <article key={account.id} className={account.authenticated ? "ok" : "warn"}>
          <span className="account-health-icon">{account.authenticated ? <KeyRound size={13} /> : <AlertCircle size={13} />}</span>
          <span className="account-list-copy">
            <strong>{account.name || account.accountId}</strong>
            <small>{account.locale.toUpperCase()}{account.authenticated ? " · Connected" : account.connectionState === "error" ? " · Connection error" : " · Sign-in required"}</small>
            {!account.authenticated && account.lastError ? <em>{account.lastError}</em> : null}
          </span>
        </article>)}
      </div> : null}
      {native && libationError ? <p className="settings-hint settings-error" role="alert">{libationError}</p> : null}
      <div className="store-settings-actions">
        <button type="button" className="download-btn" onClick={() => void startLibationSync()} aria-busy={isRefreshingAudible} disabled={!libationStatus?.enabled || libationLoading || libationRefreshPending || !!refreshLibationJob}>
          {isRefreshingAudible ? <LoaderCircle size={13} className="spin-icon" /> : <RefreshCcw size={13} />}
          <span>{isRefreshingAudible ? "Refreshing purchases" : "Refresh purchases"}</span>
        </button>
        {currentUser.isAdmin && currentUser.libationAccess === "direct" ? <button type="button" className="download-btn" onClick={() => void startAllLiberation()} aria-busy={libationAllPending || !!downloadAllLibationJob} disabled={!libationStatus?.enabled || libationLoading || libationAllPending || !!downloadAllLibationJob}>
          {libationAllPending || downloadAllLibationJob ? <LoaderCircle size={13} className="spin-icon" /> : <Download size={13} />}
          <span>{libationAllPending || downloadAllLibationJob ? "Downloading purchases" : "Download all purchases"}</span>
        </button> : null}
      </div>
      <p className="settings-hint">{libationStatus?.autoRefreshHours ? `Checks automatically every ${libationStatus.autoRefreshHours} hours.` : "Refresh manually to check for new purchases."}</p>
    </div>
  );
}
