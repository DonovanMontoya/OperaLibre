import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, CloudDownload, LayoutGrid, List, LoaderCircle, RefreshCcw, Search } from "lucide-react";
import { connectLibroAccount, disconnectLibroAccount, getBooks, getLibroAccount, importLibroPurchase, refreshLibroAccount, renameLibroAccount } from "./api";
import type { Book, JobStatus, LibroAccountStatus, LibroAccountSummary } from "./types";
import { libroDeviceBackend, cancelLibroDevice } from "./libroDevice";
import { libroCoverURL } from "./libroDevicePolicy";
import { getDeviceBooks } from "./localLibrary";
import { getOfflineCoverUrl } from "./offline";

function LibroCover({ book, device }: { book: LibroAccountStatus["books"][number]; device: boolean }) {
  const [local, setLocal] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => {
    let stopped = false;
    let ownedURL: string | null = null;
    setLocal(null);
    setFailed([]);
    const imported = device && book.localBookId ? getDeviceBooks().find(item => item.id === book.localBookId) : null;
    if (imported) void getOfflineCoverUrl(imported).then(url => {
      ownedURL = url;
      if (!stopped) setLocal(url);
      else if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    }).catch(() => undefined);
    return () => { stopped = true; if (ownedURL?.startsWith("blob:")) URL.revokeObjectURL(ownedURL); };
  }, [device, book.localBookId, book.cover_url]);
  const remote = libroCoverURL(book.cover_url);
  const cover = local && !failed.includes(local) ? local : remote && !failed.includes(remote) ? remote : null;
  return <div className="libro-purchase-cover">
    <span className="libro-cover-fallback" aria-hidden="true"><BookOpen size={28} /><span>{book.title}</span></span>
    {cover ? <img src={cover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(previous => [...previous, cover])} /> : null}
  </div>;
}

const serverBackend = { rename: renameLibroAccount, status: getLibroAccount, connect: connectLibroAccount, disconnect: disconnectLibroAccount,
  refresh: refreshLibroAccount, import: importLibroPurchase, books: getBooks };

const active = (job: JobStatus) => job.status === "running" || job.status === "queued";

function LibroNickname({ account, busy, onSave }: { account: LibroAccountSummary; busy: boolean; onSave: (nickname: string) => void }) {
  const [nickname, setNickname] = useState(account.nickname ?? "");
  useEffect(() => { setNickname(account.nickname ?? ""); }, [account.nickname]);
  return <form className="libro-nickname" onSubmit={event => { event.preventDefault(); onSave(nickname.trim()); }}>
    <label>Nickname<input aria-label={`Nickname for ${account.email}`} value={nickname} maxLength={80} placeholder="e.g. Personal" disabled={busy} onChange={event => setNickname(event.target.value)} /></label>
    <button type="submit" disabled={busy || nickname.trim() === (account.nickname ?? "")}>Save nickname</button>
  </form>;
}

export function LibroCatalog({ filterEmail, hidden = false, mode = "full", polling = true, onAccountsChanged, onBooksChanged, onOpenBook, onOpenSettings, searchQuery, sortMode = "title", reversed = false, refreshKey = 0, device = false, viewMode }: {
  filterEmail?: string | null;
  hidden?: boolean;
  mode?: "full" | "catalog" | "management";
  polling?: boolean;
  onAccountsChanged?: (accounts: LibroAccountSummary[]) => void;
  device?: boolean;
  refreshKey?: number;
  onBooksChanged: (books: Book[]) => void;
  onOpenBook?: (id: string) => void;
  onOpenSettings?: () => void;
  searchQuery?: string;
  sortMode?: string;
  reversed?: boolean;
  viewMode?: "grid" | "list" | "compact";
}) {
  const backend = device ? libroDeviceBackend : serverBackend;
  const [account, setAccount] = useState<LibroAccountStatus | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accountFilter, setAccountFilter] = useState("all");
  const [reconnect, setReconnect] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("list");
  const activeView = viewMode ?? view;
  const [refreshTick, setRefreshTick] = useState(0);
  const booksChanged = useRef(onBooksChanged);
  booksChanged.current = onBooksChanged;
  const completed = useRef(new Set<string>());

  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let delay = 15000;
      try {
        const next = await backend.status();
        if (stopped) return;
        setAccount(next);
        setPollError(null);
        if (next.jobs.some(active)) delay = 2000;
        const newDownloads = next.jobs.filter(job => job.kind === "libro-download" && job.status === "completed" && !completed.current.has(job.id));
        if (newDownloads.length) {
          const books = await backend.books();
          if (stopped) return;
          booksChanged.current(books);
          newDownloads.forEach(job => completed.current.add(job.id));
        }
      } catch (err) {
        if (!stopped) setPollError(err instanceof Error ? err.message : "Could not load Libro.fm.");
        delay = 5000;
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), delay);
      }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refreshTick, refreshKey, backend, polling]);

  async function act(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      setAccount(await backend.status());
      setRefreshTick(tick => tick + 1);
      if (key === "connect") setReconnect(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Libro.fm could not complete the request.");
    } finally {
      if (key === "connect") setPassword("");
      setBusy(null);
    }
  }

  const accountsChanged = useRef(onAccountsChanged);
  accountsChanged.current = onAccountsChanged;
  const accounts = useMemo<LibroAccountSummary[]>(
    () => account?.accounts ?? (account?.email ? [{ email: account.email, syncedAt: account.syncedAt }] : []),
    [account]
  );
  useEffect(() => {
    if (account) accountsChanged.current?.(accounts);
  }, [account, accounts]);
  useEffect(() => {
    if (accountFilter !== "all" && account && !accounts.some(item => item.email === accountFilter)) setAccountFilter("all");
  }, [account, accountFilter, accounts]);
  const selectedEmail = filterEmail === undefined ? (accountFilter === "all" ? null : accountFilter) : filterEmail;
  const needle = (searchQuery ?? query).trim().toLocaleLowerCase();
  const books = (account?.books ?? []).filter(book => selectedEmail === null || (book.accountEmail ?? account?.email) === selectedEmail).filter(book => `${book.title} ${book.authors.join(" ")} ${book.audiobook_info.narrators.join(" ")} ${book.isbn}`.toLocaleLowerCase().includes(needle)).sort((a, b) => {
    const comparison = sortMode === "duration" ? (b.audiobook_info.duration ?? 0) - (a.audiobook_info.duration ?? 0)
      : sortMode === "author" ? a.authors.join(", ").localeCompare(b.authors.join(", ")) : a.title.localeCompare(b.title);
    return reversed ? -comparison : comparison;
  });
  const refreshJob = account?.jobs.find(job => job.kind === "libro-refresh");
  const loadingLibrary = !!refreshJob && active(refreshJob);
  return <section className="libro-catalog" aria-label="Libro.fm library" style={hidden ? { display: "none" } : undefined}>
    <header className="libro-catalog-head">
      {mode !== "management" || !account?.connected ? <div><h2>{mode === "management" ? "Connect Libro.fm" : "Libro.fm"}</h2>{!account?.connected ? <p>{mode === "catalog" ? "Connect your account in Settings to browse your purchases." : "Connect your account to browse and import your purchases."}</p> : null}</div> : null}
      {mode === "catalog" && !account?.connected && onOpenSettings ? <button type="button" className="libro-settings-link" onClick={onOpenSettings}>Open Settings</button> : null}
      {mode !== "catalog" && account?.connected ? <details className="libro-account-details"><summary>{mode === "management" ? "Manage connected accounts" : "Libro.fm accounts"} ({accounts.length})</summary>
        {accounts.map(item => <div key={item.email}><p><span className="purchase-provider-tag">Libro.fm</span> {item.nickname || item.email}</p>{item.nickname ? <p>{item.email}</p> : null}
          <LibroNickname account={item} busy={!!busy} onSave={nickname => void act("rename", () => backend.rename(item.email, nickname))} /><div className="libro-catalog-actions">
          <button type="button" disabled={!!busy} onClick={() => { setEmail(item.email); setReconnect(true); }}>Reconnect</button>
          <button type="button" aria-label={`Disconnect ${item.email}`} disabled={!!busy || account.jobs.some(active)} onClick={() => void act("disconnect", () => backend.disconnect(item.email))}>Disconnect</button>
        </div></div>)}
        <div className="libro-catalog-actions">
          <button type="button" disabled={!!busy || loadingLibrary} onClick={() => void act("refresh", backend.refresh)}>{loadingLibrary ? <LoaderCircle size={15} className="spin-icon" /> : <RefreshCcw size={15} />} Refresh all accounts</button>
          <button type="button" disabled={!!busy} onClick={() => { setEmail(""); setPassword(""); setReconnect(true); }}>Add Libro.fm account</button>
        </div>
      </details> : null}
    </header>
    {!account && !pollError ? <p role="status">Loading your connection…</p> : null}
    {mode !== "catalog" && account && (!account.connected || reconnect) ? <form className="libro-connect" onSubmit={event => { event.preventDefault(); void act("connect", () => backend.connect(email, password)); }}>
      <label>Email<input type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} required disabled={!!busy} /></label>
      <label>Password<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required disabled={!!busy} /></label>
      <button type="submit" disabled={!!busy}>{busy === "connect" ? <LoaderCircle size={15} className="spin-icon" /> : <CloudDownload size={15} />} Connect Libro.fm</button>
      {account.connected ? <button type="button" disabled={!!busy} onClick={() => { setReconnect(false); setPassword(""); }}>Cancel</button> : null}
      <p>{device ? "Your sign-in goes directly from this device to Libro.fm. The token is kept in native secure storage, not sent to your server. This device connection and its cached purchases are shared by anyone using this app on this device. Disconnect before handing the device to another person." : "Your sign-in is sent to Libro.fm through this server. Only the connection token is saved. Your purchase list is private to your OperaLibre account; imported audio joins this server’s library."}</p>
    </form> : null}
    {error || pollError ? <p className="libro-catalog-error" role="alert">{error ?? pollError}</p> : null}
    {account?.connected && refreshJob?.status === "failed" ? <p className="libro-catalog-error" role="alert">{refreshJob.error ?? "Library refresh failed. Try reconnecting."}</p> : null}
    {mode !== "management" && account?.connected ? <>
      {filterEmail === undefined && accounts.length > 1 ? <label className="libro-account-filter">Account<select aria-label="Libro.fm account" value={accountFilter} onChange={event => setAccountFilter(event.target.value)}><option value="all">All Libro.fm accounts</option>{accounts.map(item => <option key={item.email} value={item.email}>{item.nickname || item.email}</option>)}</select></label> : null}
      {searchQuery === undefined ? <label className="libro-catalog-search"><Search size={15} /><input type="search" aria-label="Search Libro.fm purchases" placeholder="Search your purchases…" value={query} onChange={event => setQuery(event.target.value)} /></label> : null}
      <div className="libro-view-toolbar">
        <p className="libro-catalog-summary" role="status">{loadingLibrary ? "Loading your Libro.fm library…" : `${books.length} of ${account.books.length} purchases`}</p>
        {viewMode === undefined ? <div className="libro-view-toggle" role="group" aria-label="Purchase layout">
          <button type="button" aria-label="Cover grid" aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid size={18} /></button>
          <button type="button" aria-label="Compact list" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={18} /></button>
        </div> : null}
      </div>
      {!books.length && !loadingLibrary ? <p className="libro-catalog-empty">{needle ? "No purchases match your search." : account.syncedAt ? "No audiobooks found in this account." : "Refresh your library to load your purchases."}</p> : null}
      <ul className={`libro-purchases purchase-book-list purchase-book-list--${activeView} libro-purchases--${activeView}`}>{books.map(book => {
        const job = account.jobs.find(job => job.kind === "libro-download" && job.targetId?.endsWith(`:${book.isbn}`));
        const importing = !!job && active(job);
        return <li className="purchase-book-row" key={`${book.accountEmail ?? ""}:${book.isbn}`}>
          <LibroCover book={book} device={device} />
          <div className="libro-purchase-copy"><h3>{book.title}</h3><small className="libro-purchase-account"><span className="purchase-provider-tag">Libro.fm</span> {accounts.find(item => item.email === (book.accountEmail ?? account.email))?.nickname || book.accountEmail || account.email}</small><p>{book.authors.join(", ")}</p><small>{book.audiobook_info.narrators.length ? `Narrated by ${book.audiobook_info.narrators.join(", ")}` : book.isbn}</small>
            {book.localBookId ? <span className="libro-owned-status">In library</span> : null}
            {importing ? <p role="status">{job.progress?.step ?? "Queued for import…"}</p> : job?.status === "failed" ? <p className="libro-catalog-error">{job.error ?? "Import failed. Try again."}</p> : null}
          </div>
          {book.localBookId ? <button type="button" aria-label={`Open ${book.title}`} onClick={() => onOpenBook?.(book.localBookId!)} disabled={!onOpenBook}><BookOpen size={15} /> Open</button>
            : device && importing ? <button type="button" aria-label={`Cancel download of ${book.title}`} disabled={!!busy} onClick={() => void act("cancel", () => cancelLibroDevice(book.isbn))}>Cancel</button>
            : <button type="button" aria-label={`${device ? "Download" : "Import"} ${book.title}`} disabled={!!busy || importing} onClick={() => void act(book.isbn, () => backend.import(book.isbn, book.accountEmail))}>{importing || busy === book.isbn ? <LoaderCircle size={15} className="spin-icon" /> : <CloudDownload size={15} />} {importing ? "Adding…" : device ? "Download" : "Import"}</button>}
        </li>;
      })}</ul>
    </> : null}
  </section>;
}
