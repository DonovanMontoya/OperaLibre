import { Globe, LogIn, Network, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ApiError,
  changePassword,
  createUser,
  deleteUser,
  getServerUrl,
  listUsers,
  login,
  pingServer,
  setServerUrl,
  setupAdmin
} from "./api";
import type { AuthUser } from "./types";

type AuthMode = "setup" | "login";

export function ServerSetup({
  onConnected,
  onCancel
}: {
  onConnected: () => void;
  onCancel?: () => void;
}) {
  const [url, setUrl] = useState(() => getServerUrl());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await pingServer(url);
      setServerUrl(url);
      onConnected();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not reach that server.";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <span className="eyebrow">
          <Network size={13} /> Connect to a server
        </span>
        <h1>Find your library</h1>
        <p>
          Enter the address of your Operalibre server &mdash; an IP and port, or a full URL.
          We&rsquo;ll verify it can be reached before continuing.
        </p>

        <label>
          <span>Server address</span>
          <input
            type="text"
            value={url}
            placeholder="http://192.168.1.10:4000"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setUrl(event.currentTarget.value)}
            required
            autoFocus
          />
        </label>

        <p className="auth-hint">
          <Globe size={12} /> Examples: <code>192.168.1.10:4000</code>, <code>localhost:4000</code>,
          <code>https://books.example.com</code>
        </p>

        {error ? <p className="auth-error">{error}</p> : null}

        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? "Testing…" : "Test & connect"}
        </button>

        {onCancel ? (
          <button type="button" className="auth-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
      </form>
    </main>
  );
}

export function AuthGate({
  mode,
  onAuthenticated,
  onChangeServer
}: {
  mode: AuthMode;
  onAuthenticated: (token: string, user: AuthUser) => void;
  onChangeServer?: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (mode === "setup" && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const response =
        mode === "setup"
          ? await setupAdmin(username, password)
          : await login(username, password);
      onAuthenticated(response.token, response.user);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  const isSetup = mode === "setup";

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <span className="eyebrow">
          {isSetup ? <ShieldCheck size={13} /> : <LogIn size={13} />}{" "}
          {isSetup ? "First-run setup" : "Sign in"}
        </span>
        <h1>{isSetup ? "Claim this library" : "Welcome back"}</h1>
        <p>
          {isSetup
            ? "Create the first administrator account. You can add more readers later."
            : "Sign in to track your audiobook progress."}
        </p>

        <label>
          <span>Username</span>
          <input
            value={username}
            autoComplete="username"
            onChange={(event) => setUsername(event.currentTarget.value)}
            required
            autoFocus
          />
        </label>

        <label>
          <span>Password</span>
          <input
            type="password"
            value={password}
            autoComplete={isSetup ? "new-password" : "current-password"}
            onChange={(event) => setPassword(event.currentTarget.value)}
            required
            minLength={6}
          />
        </label>

        {isSetup ? (
          <label>
            <span>Confirm password</span>
            <input
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(event) => setConfirm(event.currentTarget.value)}
              required
              minLength={6}
            />
          </label>
        ) : null}

        {error ? <p className="auth-error">{error}</p> : null}

        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? "Working…" : isSetup ? "Create administrator" : "Sign in"}
        </button>

        {onChangeServer ? (
          <p className="auth-server-meta">
            Connected to <code>{getServerUrl()}</code>
            <button type="button" className="auth-linklike" onClick={onChangeServer}>
              Change server
            </button>
          </p>
        ) : null}
      </form>
    </main>
  );
}

export function UserManagementModal({
  currentUser,
  onClose
}: {
  currentUser: AuthUser;
  onClose: () => void;
}) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const list = await listUsers();
      setUsers(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load users.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setCreating(true);
    try {
      await createUser(newUsername, newPassword, newIsAdmin);
      setNewUsername("");
      setNewPassword("");
      setNewIsAdmin(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create user.");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(user: AuthUser) {
    if (!window.confirm(`Delete user ${user.username}? Their progress will be removed.`)) {
      return;
    }
    setError(null);
    try {
      await deleteUser(user.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete user.");
    }
  }

  async function handleResetPassword(user: AuthUser) {
    const next = window.prompt(`New password for ${user.username} (min 6 chars):`);
    if (!next) {
      return;
    }
    setError(null);
    try {
      await changePassword(user.id, next);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Failed.";
      setError(message);
    }
  }

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="eyebrow">
            <Users size={13} /> Manage readers
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <h2>Readers</h2>

        {error ? <p className="auth-error">{error}</p> : null}

        {loading ? (
          <p>Loading…</p>
        ) : (
          <ul className="user-list">
            {users.map((user) => (
              <li key={user.id}>
                <div>
                  <strong>{user.username}</strong>
                  <span>
                    {user.isAdmin ? "Administrator" : "Reader"}
                    {user.id === currentUser.id ? " · you" : ""}
                  </span>
                </div>
                <div className="user-actions">
                  <button type="button" onClick={() => void handleResetPassword(user)}>
                    Reset password
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(user)}
                    disabled={user.id === currentUser.id}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <h3>
          <UserPlus size={14} /> Add reader
        </h3>
        <form className="add-user-form" onSubmit={handleCreate}>
          <label>
            <span>Username</span>
            <input
              value={newUsername}
              onChange={(event) => setNewUsername(event.currentTarget.value)}
              required
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={newPassword}
              minLength={6}
              onChange={(event) => setNewPassword(event.currentTarget.value)}
              required
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={newIsAdmin}
              onChange={(event) => setNewIsAdmin(event.currentTarget.checked)}
            />
            <span>Administrator</span>
          </label>
          <button type="submit" disabled={creating}>
            {creating ? "Adding…" : "Add reader"}
          </button>
        </form>
      </div>
    </div>
  );
}
