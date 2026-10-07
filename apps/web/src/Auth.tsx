import { Capacitor } from "@capacitor/core";
import { BookOpen, ChevronRight, ExternalLink, LogIn, ShieldCheck, Smartphone } from "lucide-react";
import { useRef, useState } from "react";
import {
  defaultServerUrl,
  getServerUrl,
  getServerType,
  SERVER_SETUP_GUIDE_URL,
  login,
  pingServer,
  setServerConnection,
  setupAdmin
} from "./api";
import type { LoginResponse, ServerType } from "./types";

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
  const addressInput = useRef<HTMLInputElement>(null);
  const nativeApp = Capacitor.isNativePlatform();
  const jellyfin = serverType === "jellyfin";

  // The second way in is always one that needs no server: the device library
  // on native apps (a way back to it when this screen was opened from there),
  // otherwise the bundled demo, which then leaves the secondary links.
  const offline = onCancel
    ? {
      action: onCancel,
      icon: <Smartphone size={20} />,
      title: "Keep listening from this device",
      note: "Return to the audiobooks already saved on this device."
    }
    : onLocal
      ? {
        action: onLocal,
        icon: <Smartphone size={20} />,
        title: "Listen from this device",
        note: "Fully offline, from audiobook files on this device. No server or account."
      }
      : onDemo
        ? {
          action: onDemo,
          icon: <BookOpen size={20} />,
          title: "Explore the on-device demo",
          note: "Alice’s Adventures in Wonderland, with public-domain audio and ebook (USA). No server or sign-in."
        }
        : null;
  const demoLink = offline?.action !== onDemo ? onDemo : undefined;

  function switchServerType(next: ServerType) {
    setServerType(next);
    setUrl(defaultServerUrl(next));
    setError(null);
    if (!nativeApp) addressInput.current?.focus();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const serverId = await pingServer(serverType, url);
      setServerConnection(serverType, url, serverId);
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
      <div className="connect-page">
        <div className="connect-brand">
          <span className="connect-mark" aria-hidden="true"><i /><i /><i /></span>
          <span className="connect-wordmark">OperaLibre</span>
        </div>
        <h1>Connect your library</h1>

        <form className="connect-form" onSubmit={submit}>
          <label>
            <span>{jellyfin ? "Jellyfin server address" : "OperaLibre server address"}</span>
            <input
              ref={addressInput}
              type="text"
              value={url}
              placeholder={jellyfin
                ? nativeApp ? "My-Mac.local:8096" : "http://localhost:8096"
                : nativeApp ? "My-Mac.local:4920" : "http://localhost:4920"}
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

          <p className="connect-hint">
            {nativeApp ? (
              <>
                Private addresses use HTTP automatically; public names such
                as <code>{jellyfin ? "jellyfin.example.com" : "books.example.com"}</code> use HTTPS.
              </>
            ) : jellyfin ? (
              <>Usually <code>localhost:8096</code>, or <code>localhost:8920</code> with HTTPS.</>
            ) : (
              <>Usually <code>localhost:4920</code> on the server itself, or its HTTPS name from elsewhere.</>
            )}
          </p>

          {error ? <p className="auth-error" role="alert">{error}</p> : null}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>

        {offline ? (
          <>
            <div className="connect-or"><span>or</span></div>
            <button type="button" className="connect-offline" onClick={offline.action} disabled={busy}>
              <span className="connect-offline-icon" aria-hidden="true">{offline.icon}</span>
              <span>
                <strong>{offline.title}</strong>
                <small>{offline.note}</small>
              </span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </>
        ) : null}

        <div className="connect-more">
          <button
            type="button"
            onClick={() => switchServerType(jellyfin ? "operalibre" : "jellyfin")}
            disabled={busy}
          >
            {jellyfin ? "Use an OperaLibre server" : "Use a Jellyfin server"}
          </button>
          {demoLink ? (
            <button type="button" onClick={demoLink} disabled={busy}>
              Explore the on-device demo
            </button>
          ) : null}
          {jellyfin ? null : (
            <a href={SERVER_SETUP_GUIDE_URL} target="_blank" rel="noreferrer">
              Server setup guide <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
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
  const nativeApp = Capacitor.isNativePlatform();
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
