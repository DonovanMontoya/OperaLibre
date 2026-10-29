import "./AccountDeletion.css";
import { useState } from "react";
import { deleteAccount } from "./api";
import type { AuthUser } from "./types";

export function AccountDeletion({ user, supported, unavailableReason, onDeleted }: {
  user: AuthUser;
  supported: boolean;
  unavailableReason: string;
  onDeleted: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [password, setPassword] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <section className="settings-card account-deletion">
    <h3>Delete account</h3>
    {!supported ? <p>{unavailableReason}</p> : !expanded ? <>
      <p>Permanently delete your OperaLibre account on this server.</p>
      <button type="button" className="download-btn" onClick={() => setExpanded(true)}>Delete my account…</button>
    </> : <form onSubmit={async (event) => {
      event.preventDefault();
      if (!confirmed || busy) return;
      setBusy(true);
      setError("");
      try {
        await deleteAccount(password, transferTo.trim() || undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Deletion failed. Please try again.");
        setBusy(false);
        return;
      }
      setPassword("");
      await onDeleted();
    }}>
      <p>This permanently removes <strong>{user.username}</strong>, listening progress, reading history, preferences, avatar, download requests, server-stored Libro.fm credentials, and access tokens. You will be signed out on all devices. This cannot be undone.</p>
      <p>Shared library files, server settings, and other accounts stay. Device downloads, external provider accounts, copies previously shared with others, and server backups are not deleted.</p>
      {user.isOwner ? <>
        <p>The server must keep an owner. If you are the last owner, enter another account’s username to transfer full control. If needed, first create a replacement account in Administration. Only choose someone you trust to manage this server.</p>
        <label>Transfer ownership to (username)
          <input value={transferTo} disabled={busy} onChange={(event) => setTransferTo(event.target.value)} autoComplete="off" />
        </label>
      </> : null}
      <label>Current password
        <input type="password" required value={password} disabled={busy} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
      </label>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} /> I understand and want to permanently delete my account.</label>
      {error ? <p role="alert" className="auth-error">{error}</p> : null}
      <div className="settings-actions">
        <button type="submit" className="download-btn" disabled={!confirmed || !password || busy}>{busy ? "Deleting…" : "Permanently delete my account"}</button>
        <button type="button" className="download-btn" disabled={busy} onClick={() => { setExpanded(false); setPassword(""); setTransferTo(""); setConfirmed(false); setError(""); }}>Cancel</button>
      </div>
    </form>}
  </section>;
}
