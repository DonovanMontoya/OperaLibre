import { Bot, Check, Copy, FlaskConical, LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import {
  type AgentAccessStatus,
  type AgentScope,
  type AgentToken,
  agentEndpointUrl,
  createAgentToken,
  getAgentAccessStatus,
  listAgentTokens,
  revokeAgentToken,
  setAgentAccessEnabled
} from "./api";
import { ApiError } from "./apiError";
import { errorMessage } from "./formatting";
import { useModalFocus } from "./useModalFocus";

const SCOPES: { scope: AgentScope; title: string; detail: string }[] = [
  {
    scope: "library",
    title: "Your library",
    detail: "Titles, authors, series, and descriptions of the books you can open."
  },
  {
    scope: "progress",
    title: "Where you are",
    detail: "How far through each book you are and what you are listening to now."
  },
  {
    scope: "history",
    title: "Listening history",
    detail: "When you listened, what you finished, your listening stats, and your achievements."
  },
  {
    scope: "text",
    title: "Book text so far",
    detail: "A book's text up to the sentence you have reached, for spoiler-free recaps. Only books with a follow-along map have it."
  }
];

const DEFAULT_SCOPES = SCOPES.map((entry) => entry.scope);

function describeScopes(scopes: AgentScope[]) {
  return `Reads ${SCOPES.filter((entry) => scopes.includes(entry.scope))
    .map((entry) => entry.title.toLowerCase())
    .join(", ")}`;
}

function describeLastUsed(token: AgentToken) {
  if (!token.lastUsedAt) return "Not used yet";
  return `Last used ${new Date(token.lastUsedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  })}`;
}

/**
 * The listener's own assistants. Nothing is shared until they connect one
 * here, and each can be removed on its own. Hidden until the list loads, and
 * for good when the owner has not turned assistants on (or the server
 * predates them), which the list answers with a 404.
 */
export function AgentAccessCard({ labelId }: { labelId?: string }) {
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<AgentScope[]>(DEFAULT_SCOPES);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState<"address" | "token" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAgentTokens()
      .then((loaded) => {
        if (!cancelled) setTokens(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof ApiError && err.status === 404)) return;
        setTokens([]);
        setError(errorMessage(err, "Could not load your connected assistants."));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (tokens === null) return null;

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createAgentToken(name.trim(), scopes);
      setTokens((current) => [result.agentToken, ...(current ?? [])]);
      setCreated({ name: result.agentToken.name, token: result.token });
      setAdding(false);
      setName("");
      setScopes(DEFAULT_SCOPES);
    } catch (err) {
      setError(errorMessage(err, "Could not connect the assistant."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(token: AgentToken) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await revokeAgentToken(token.id);
      setTokens((current) => (current ?? []).filter((candidate) => candidate.id !== token.id));
    } catch (err) {
      setError(errorMessage(err, `Could not remove ${token.name}.`));
    } finally {
      setBusy(false);
    }
  }

  async function copy(kind: "address" | "token", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setError("Copying was blocked. Select the text and copy it yourself.");
    }
  }

  function toggleScope(scope: AgentScope) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((candidate) => candidate !== scope) : [...current, scope]
    );
  }

  return (
    <section className="settings-card">
      <span className="section-label" id={labelId}><Bot size={13} /> AI assistants</span>
      <p className="settings-hint">
        Let an assistant you already use read from this server, to recap a book without spoilers
        or suggest what to read next. It can only read what you allow here, never change your
        listening, and never see other listeners. Whatever it reads is sent to the company that
        runs the assistant.
      </p>

      {created ? (
        <div className="agent-created">
          <strong>{created.name} is connected</strong>
          <p className="settings-hint">
            Add this address and token to the assistant's MCP settings. Copy the token now: it
            will not be shown again.
          </p>
          {([
            ["address", agentEndpointUrl(), "Address"],
            ["token", created.token, "Token"]
          ] as const).map(([kind, value, label]) => (
            <div className="server-alias-form agent-secret-row" key={kind}>
              <input readOnly value={value} aria-label={`Assistant ${kind}`} onFocus={(event) => event.currentTarget.select()} />
              <button type="button" className="download-btn" onClick={() => void copy(kind, value)}>
                {copied === kind ? <Check size={13} /> : <Copy size={13} />} {label}
              </button>
            </div>
          ))}
          <div className="settings-actions">
            <button
              type="button"
              className="download-btn"
              onClick={() => {
                setCreated(null);
                setCopied(null);
              }}
            >
              Done
            </button>
          </div>
        </div>
      ) : null}

      {tokens.length > 0 ? (
        <div className="server-aliases">
          {tokens.map((token) => (
            <div className="server-alias-row" key={token.id}>
              <span>
                <strong>{token.name}</strong>
                <small>{describeScopes(token.scopes)} · {describeLastUsed(token)}</small>
              </span>
              <div>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${token.name}`}
                  disabled={busy}
                  onClick={() => void remove(token)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {adding ? (
        <form className="agent-connect" onSubmit={(event) => void connect(event)}>
          {SCOPES.map((entry) => (
            <div className="settings-toggle-row" key={entry.scope}>
              <span>
                <strong>{entry.title}</strong>
                <small>{entry.detail}</small>
              </span>
              <button
                type="button"
                className="settings-switch"
                role="switch"
                aria-checked={scopes.includes(entry.scope)}
                aria-label={entry.title}
                onClick={() => toggleScope(entry.scope)}
              >
                <span aria-hidden="true" />
              </button>
            </div>
          ))}
          <div className="server-alias-form agent-secret-row">
            <input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Name (Claude on my laptop)"
              aria-label="Assistant name"
              maxLength={64}
              required
            />
            <button type="submit" className="download-btn connection-primary" disabled={busy || scopes.length === 0}>
              Connect
            </button>
          </div>
          <div className="settings-actions">
            <button type="button" className="download-btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : created ? null : (
        <div className="settings-actions">
          <button type="button" className="download-btn" onClick={() => setAdding(true)}>
            <Plus size={13} /> Connect an assistant
          </button>
        </div>
      )}

      {error ? <p className="settings-hint settings-error">{error}</p> : null}
    </section>
  );
}

/** The browser's way in: the account menu offers assistants only when the
    owner has turned them on, which listing them tells it. */
export function AgentAccessMenuItem({ onOpen }: { onOpen: () => void }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    listAgentTokens().then(
      () => {
        if (!cancelled) setAvailable(true);
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, []);
  if (!available) return null;
  return (
    <button type="button" role="menuitem" onClick={onOpen}>
      <Bot size={16} /> AI assistants
    </button>
  );
}

/** The card on its own in a browser, which has no Settings page. */
export function AgentAccessDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useModalFocus<HTMLElement>(onClose);
  const labelId = useId();
  return createPortal(
    <div className="modal-scrim" role="presentation">
      <section ref={dialogRef} tabIndex={-1} className="modal-card agent-access-dialog" role="dialog" aria-modal="true" aria-labelledby={labelId}>
        <button type="button" className="icon-button agent-access-close" aria-label="Close AI assistants" onClick={onClose}>
          <X size={18} />
        </button>
        <AgentAccessCard labelId={labelId} />
      </section>
    </div>,
    document.body
  );
}

/** The owner's switch under Administration → Experiments. */
export function AgentAccessExperiment({ isOwner }: { isOwner: boolean }) {
  const [status, setStatus] = useState<AgentAccessStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAgentAccessStatus().then(
      (loaded) => {
        if (!cancelled) setStatus(loaded);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "Could not check AI assistants."));
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle() {
    if (!status || busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await setAgentAccessEnabled(!status.enabled));
    } catch (err) {
      setError(errorMessage(err, "Could not change AI assistants."));
    } finally {
      setBusy(false);
    }
  }

  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  return (
    <article>
      <div className="admin-software-version-head">
        <div>
          <span>AI assistants</span>
          <strong>{status === null ? "Checking…" : status.enabled ? "On" : "Off"}</strong>
        </div>
        {status?.enabled ? (
          <span className="admin-current-badge"><Check size={12} /> Enabled</span>
        ) : (
          <span className="admin-experimental-badge">Optional</span>
        )}
      </div>
      <p>
        Lets each listener connect an AI assistant they already use, such as Claude or Codex, for
        spoiler-free recaps, what to read next, and their series and achievements. Each listener chooses what their assistant may
        do in Settings, and an assistant never sees other listeners. What it reads is sent to the
        company that runs it. Built into the server, so there is nothing to install.
      </p>
      {status?.enabled ? (
        <p className="admin-experiment-detail">
          {status.assistants
            ? `${plural(status.assistants, "assistant")} connected by ${plural(status.listeners, "listener")}.`
            : "No one has connected an assistant yet."}
          {" "}Turning this off stops them until it is turned back on.
        </p>
      ) : null}
      {error ? <p className="admin-experiment-detail">{error}</p> : null}
      <div className="admin-update-actions">
        {isOwner ? (
          <button type="button" className={status?.enabled ? "quiet-button" : undefined} disabled={status === null || busy} onClick={() => void toggle()}>
            {busy ? <LoaderCircle size={15} className="spin-icon" /> : <FlaskConical size={15} />}
            {status?.enabled ? "Disable" : "Enable"}
          </button>
        ) : (
          <span>Only an owner can change experiments.</span>
        )}
      </div>
    </article>
  );
}
