import { BookOpen, ExternalLink, FolderOpen, Globe, LogIn, Network, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ApiError,
  changePassword,
  createUser,
  deleteUser,
  defaultServerUrl,
  getServerUrl,
  getServerType,
  SERVER_SETUP_GUIDE_URL,
  isNativeApp,
  listUsers,
  login,
  pingServer,
  setServerConnection,
  setupAdmin
} from "./api";
import type { AuthUser, LoginResponse, ServerType } from "./types";

type AuthMode = "setup" | "login";

export function ServerSetup({
  onConnected,
  onCancel,
  onDemo,
  onLocal
}: {
  onConnected: () => void;
  onCancel?: () => void;
  onDemo?: () => void;
  onLocal?: () => void;
}) {
  const [serverType, setServerType] = useState<ServerType>(() => getServerType());
  const [url, setUrl] = useState(() => getServerUrl());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nativeApp = isNativeApp();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await pingServer(serverType, url);
      setServerConnection(serverType, url);
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
          Choose where your audiobooks live, then enter the server address. We&rsquo;ll verify it
          can be reached before continuing.
        </p>

        <div className="server-type-grid" role="radiogroup" aria-label="Server type">
          <button
            type="button"
            role="radio"
            aria-checked={serverType === "operalibre"}
            className={serverType === "operalibre" ? "selected" : ""}
            onClick={() => {
              setServerType("operalibre");
              setUrl(defaultServerUrl("operalibre"));
              setError(null);
            }}
          >
            <Network size={17} />
            <span><strong>OperaLibre</strong><small>Native server</small></span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={serverType === "jellyfin"}
            className={serverType === "jellyfin" ? "selected" : ""}
            onClick={() => {
              setServerType("jellyfin");
              setUrl(defaultServerUrl("jellyfin"));
              setError(null);
            }}
          >
            <Globe size={17} />
            <span><strong>Jellyfin</strong><small>Audiobook library</small></span>
          </button>
        </div>

        <label>
          <span>{serverType === "jellyfin" ? "Jellyfin address" : "OperaLibre address"}</span>
          <input
            type="text"
            value={url}
            placeholder={serverType === "jellyfin"
              ? nativeApp ? "My-Mac.local:8096 or jellyfin.example.com" : "http://localhost:8096"
              : nativeApp ? "My-Mac.local:4000 or books.example.com" : "http://localhost:4000"}
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setUrl(event.currentTarget.value)}
            required
            autoFocus={!nativeApp}
          />
        </label>

        <p className="auth-hint">
          <Globe size={12} />
          {serverType === "jellyfin" ? (
            <>
              {nativeApp ? (
                <>Private addresses use HTTP automatically; public names use HTTPS.</>
              ) : (
                <>Default HTTP: <code>localhost:8096</code> HTTPS when enabled: <code>localhost:8920</code></>
              )}
            </>
          ) : (
            <>
              {nativeApp ? (
                <>Private addresses use HTTP automatically; public names use HTTPS.</>
              ) : (
                <>Default: <code>localhost:4000</code> Remote: <code>https://books.example.com</code></>
              )}
            </>
          )}
        </p>

        <p className="auth-server-meta">
          Don&rsquo;t have a server yet?{" "}
          <a className="auth-linklike" href={SERVER_SETUP_GUIDE_URL} target="_blank" rel="noreferrer">
            Read the setup guide <ExternalLink size={11} aria-hidden="true" />
          </a>
        </p>

        {error ? <p className="auth-error">{error}</p> : null}

        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? "Testing…" : "Test & connect"}
        </button>

        {onLocal && !onCancel ? (
          <>
            <div className="auth-demo-separator"><span>or</span></div>
            <button type="button" className="auth-secondary auth-demo-button" onClick={onLocal} disabled={busy}>
              <FolderOpen size={16} />
              Listen from this device
            </button>
            <p className="auth-demo-note">
              Pick audiobook files from Files on iOS or the Android file picker. No server or account required.
            </p>
          </>
        ) : null}

        {onDemo ? (
          <>
            <button type="button" className="auth-secondary auth-demo-button" onClick={onDemo} disabled={busy}>
              <BookOpen size={16} />
              Explore the on-device demo
            </button>
            <p className="auth-demo-note">
              No server or sign-in required. Includes only original OperaLibre demo content.
            </p>
          </>
        ) : null}

        {onCancel ? (
          <button type="button" className="auth-secondary" onClick={onCancel} disabled={busy}>
            Not now — keep listening from this device
          </button>
        ) : null}
      </form>
    </main>
  );
}

export function AuthGate({
  mode,
  onAuthenticated,
  onChangeServer,
  setupTokenRequired = false,
  setupLocalOnly = false
}: {
  mode: AuthMode;
  onAuthenticated: (response: LoginResponse) => void;
  onChangeServer?: () => void;
  setupTokenRequired?: boolean;
  setupLocalOnly?: boolean;
}) {
  const isJellyfin = getServerType() === "jellyfin";
  const nativeApp = isNativeApp();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (mode === "setup" && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (mode === "setup" && setupLocalOnly) {
      setError("Complete first-run setup from a browser on the server machine.");
      return;
    }

    setBusy(true);
    try {
      const response =
        mode === "setup"
          ? await setupAdmin(username, password, setupTokenRequired ? setupToken : undefined)
          : await login(username, password);
      onAuthenticated(response);
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
          {isSetup ? "First-run setup" : isJellyfin ? "Jellyfin sign in" : "Sign in"}
        </span>
        <h1>{isSetup ? "Claim this library" : "Welcome back"}</h1>
        <p>
          {isSetup
            ? setupLocalOnly
              ? "This server uses local setup. Open OperaLibre on the server machine to create its first owner."
              : "Create the first owner account. You can add administrators and readers later."
            : isJellyfin
              ? "Use your Jellyfin account to open its audiobook libraries."
              : "Sign in to track your audiobook progress."}
        </p>

        <label>
          <span>Username</span>
          <input
            value={username}
            autoComplete="username"
            onChange={(event) => setUsername(event.currentTarget.value)}
            required
            autoFocus={!nativeApp}
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
            minLength={isSetup ? 12 : 1}
            maxLength={1024}
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
              minLength={12}
              maxLength={1024}
            />
          </label>
        ) : null}

        {isSetup && setupTokenRequired ? (
          <>
            <label>
              <span>One-time setup token</span>
              <input
                value={setupToken}
                autoComplete="one-time-code"
                onChange={(event) => setSetupToken(event.currentTarget.value.trim())}
                required
                maxLength={256}
              />
            </label>
            <p className="auth-server-meta">
              Find this 30-minute token in the server console or <code>data/server.log</code>.
            </p>
          </>
        ) : null}

        {error ? <p className="auth-error">{error}</p> : null}

        <button type="submit" className="auth-submit" disabled={busy || (isSetup && setupLocalOnly)}>
          {busy ? "Working…" : isSetup ? "Create owner" : "Sign in"}
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
    const next = window.prompt(`New password for ${user.username} (min 12 chars):`);
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
              minLength={12}
              maxLength={1024}
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
