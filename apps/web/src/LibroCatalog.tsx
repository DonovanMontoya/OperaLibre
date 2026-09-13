import { useEffect, useRef, useState } from "react";
import { BookOpen, CloudDownload, LayoutGrid, List, LoaderCircle, RefreshCcw, Search } from "lucide-react";
import { connectLibroAccount, disconnectLibroAccount, getBooks, getLibroAccount, importLibroPurchase, refreshLibroAccount } from "./api";
import type { Book, JobStatus, LibroAccountStatus } from "./types";
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

const serverBackend = { status: getLibroAccount, connect: connectLibroAccount, disconnect: disconnectLibroAccount,
  refresh: refreshLibroAccount, import: importLibroPurchase, books: getBooks };

const active = (job: JobStatus) => job.status === "running" || job.status === "queued";

export function LibroCatalog({ onBooksChanged, onOpenBook, searchQuery, sortMode = "title", reversed = false, refreshKey = 0, device = false }: {
  device?: boolean;
  refreshKey?: number;
  onBooksChanged: (books: Book[]) => void;
  onOpenBook?: (id: string) => void;
  searchQuery?: string;
  sortMode?: string;
  reversed?: boolean;
}) {
  const backend = device ? libroDeviceBackend : serverBackend;
  const [account, setAccount] = useState<LibroAccountStatus | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reconnect, setReconnect] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("list");
  const [refreshTick, setRefreshTick] = useState(0);
  const booksChanged = useRef(onBooksChanged);
  booksChanged.current = onBooksChanged;
  const completed = useRef(new Set<string>());

  useEffect(() => {
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
  }, [refreshTick, refreshKey, backend]);

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

  const needle = (searchQuery ?? query).trim().toLocaleLowerCase();
  const books = (account?.books ?? []).filter(book => `${book.title} ${book.authors.join(" ")} ${book.audiobook_info.narrators.join(" ")} ${book.isbn}`.toLocaleLowerCase().includes(needle)).sort((a, b) => {
    const comparison = sortMode === "duration" ? (b.audiobook_info.duration ?? 0) - (a.audiobook_info.duration ?? 0)
      : sortMode === "author" ? a.authors.join(", ").localeCompare(b.authors.join(", ")) : a.title.localeCompare(b.title);
    return reversed ? -comparison : comparison;
  });
  const refreshJob = account?.jobs.find(job => job.kind === "libro-refresh");
  const loadingLibrary = !!refreshJob && active(refreshJob);
  return <section className="libro-catalog" aria-label="Libro.fm library">
    <header className="libro-catalog-head">
      {!account?.connected ? <div><h2>Libro.fm</h2><p>Connect your account to browse and import your purchases.</p></div> : null}
      {account?.connected ? <details className="libro-account-details"><summary>Libro.fm account</summary><p>{account.email}</p><div className="libro-catalog-actions">
        <button type="button" disabled={!!busy || loadingLibrary} onClick={() => void act("refresh", backend.refresh)}>{loadingLibrary ? <LoaderCircle size={15} className="spin-icon" /> : <RefreshCcw size={15} />} Refresh</button>
        <button type="button" disabled={!!busy} onClick={() => { setEmail(account.email ?? ""); setReconnect(!reconnect); }}>Reconnect</button>
        <button type="button" disabled={!!busy || account.jobs.some(active)} onClick={() => void act("disconnect", backend.disconnect)}>Disconnect</button>
      </div>{device ? <p className="libro-catalog-summary">Download here, listen offline. No server needed. Reopen this screen to finish background imports.</p> : null}</details> : null}
    </header>
    {!account && !pollError ? <p role="status">Loading your connection…</p> : null}
    {account && (!account.connected || reconnect) ? <form className="libro-connect" onSubmit={event => { event.preventDefault(); void act("connect", () => backend.connect(email, password)); }}>
      <label>Email<input type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} required disabled={!!busy} /></label>
      <label>Password<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required disabled={!!busy} /></label>
      <button type="submit" disabled={!!busy}>{busy === "connect" ? <LoaderCircle size={15} className="spin-icon" /> : <CloudDownload size={15} />} Connect Libro.fm</button>
      <p>{device ? "Your sign-in goes directly from this device to Libro.fm. The token is kept in native secure storage, not sent to your server. This device connection and its cached purchases are shared by anyone using this app on this device. Disconnect before handing the device to another person." : "Your sign-in is sent to Libro.fm through this server. Only the connection token is saved. Your purchase list is private to your OperaLibre account; imported audio joins this server’s library."}</p>
    </form> : null}
    {error || pollError ? <p className="libro-catalog-error" role="alert">{error ?? pollError}</p> : null}
    {account?.connected ? <>
      {searchQuery === undefined ? <label className="libro-catalog-search"><Search size={15} /><input type="search" aria-label="Search Libro.fm purchases" placeholder="Search your purchases…" value={query} onChange={event => setQuery(event.target.value)} /></label> : null}
      <div className="libro-view-toolbar">
        <p className="libro-catalog-summary" role="status">{loadingLibrary ? "Loading your Libro.fm library…" : `${books.length} of ${account.books.length} purchases`}</p>
        <div className="libro-view-toggle" role="group" aria-label="Purchase layout">
          <button type="button" aria-label="Cover grid" aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid size={18} /></button>
          <button type="button" aria-label="Compact list" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={18} /></button>
        </div>
      </div>
      {refreshJob?.status === "failed" ? <p className="libro-catalog-error" role="alert">{refreshJob.error ?? "Library refresh failed. Try reconnecting."}</p> : null}
      {!books.length && !loadingLibrary ? <p className="libro-catalog-empty">{needle ? "No purchases match your search." : account.syncedAt ? "No audiobooks found in this account." : "Refresh your library to load your purchases."}</p> : null}
      <ul className={`libro-purchases libro-purchases--${view}`}>{books.map(book => {
        const job = account.jobs.find(job => job.kind === "libro-download" && job.targetId?.endsWith(`:${book.isbn}`));
        const importing = !!job && active(job);
        return <li key={book.isbn}>
          <LibroCover book={book} device={device} />
          <div className="libro-purchase-copy"><h3>{book.title}</h3><p>{book.authors.join(", ")}</p><small>{book.audiobook_info.narrators.length ? `Narrated by ${book.audiobook_info.narrators.join(", ")}` : book.isbn}</small>
            {importing ? <p role="status">{job.progress?.step ?? "Queued for import…"}</p> : job?.status === "failed" ? <p className="libro-catalog-error">{job.error ?? "Import failed. Try again."}</p> : null}
            {device && importing ? <button type="button" disabled={!!busy} onClick={() => void act("cancel", () => cancelLibroDevice(book.isbn))}>Cancel download</button> : null}
          </div>
          {book.localBookId ? <button type="button" onClick={() => onOpenBook?.(book.localBookId!)} disabled={!onOpenBook}><BookOpen size={15} /> In library</button>
            : <button type="button" disabled={!!busy || importing} onClick={() => void act(book.isbn, () => backend.import(book.isbn))}>{importing || busy === book.isbn ? <LoaderCircle size={15} className="spin-icon" /> : <CloudDownload size={15} />} {importing ? "Importing…" : device ? "Download to device" : "Import"}</button>}
        </li>;
      })}</ul>
    </> : null}
  </section>;
}
