import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, FolderOpen, LoaderCircle, RefreshCcw, Upload } from "lucide-react";
import { configureLibroImports, getBooks, getLibroImports, scanLibroImports } from "./api";
import type { Book, LibroImportStatus } from "./types";

const labels = { waiting: "Waiting for download", imported: "Imported", review: "Needs review", missing: "Missing library copy" };

export function LibroImports({ isOwner, onUpload, onBooksChanged }: {
  isOwner: boolean;
  onUpload: () => void;
  onBooksChanged: (books: Book[]) => void;
}) {
  const [status, setStatus] = useState<LibroImportStatus | null>(null);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const initialized = useRef(false);
  const importRevision = useRef<string | null>(null);
  const running = status?.job?.status === "running" || status?.job?.status === "queued";

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await getLibroImports();
        if (stopped) return;
        setStatus(next);
        setLoadError(null);
        if (!initialized.current) {
          setFolder(next.folder ?? "");
          initialized.current = true;
        }
        if (next.job?.status === "completed") {
          const revision = JSON.stringify(next.items.filter((item) => item.status === "imported"));
          if (revision !== importRevision.current) {
            const books = await getBooks();
            if (stopped) return;
            onBooksChanged(books);
            importRevision.current = revision;
          }
        }
      } catch (err) {
        if (!stopped) setLoadError(err instanceof Error ? err.message : "Could not load imports.");
      } finally {
        if (!stopped) timer = setTimeout(() => void refresh(), 3000);
      }
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [onBooksChanged]);

  async function save(nextFolder: string | null) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await configureLibroImports(nextFolder);
      setStatus(next);
      setFolder(next.folder ?? "");
      setNotice(next.folder ? "Folder saved. Complete downloads will appear in your library automatically." : "Watching stopped. Imported books and original downloads are kept.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this folder.");
    } finally { setBusy(false); }
  }

  async function scan() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await scanLibroImports();
      setStatus(await getLibroImports());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check for downloads.");
    } finally { setBusy(false); }
  }

  return <div className="admin-content libro-imports">
    <section className="admin-card libro-intro">
      <span className="section-label"><FolderOpen size={14} /> Your books, together</span>
      <h2>Import from Libro.fm</h2>
      <p>Bring your Libro.fm purchases into OperaLibre for listening, offline downloads, and read-along.</p>
      <ol className="libro-steps">
        <li><strong>Download your book</strong><span>Open your Libro.fm library and choose Files → M4B, or download and extract all MP3 ZIPs.</span></li>
        <li><strong>Place it in your import folder</strong><span>Use a dedicated folder on the computer running OperaLibre. Add each M4B directly, or put all MP3 tracks for one book in their own folder.</span></li>
        <li><strong>Listen in OperaLibre</strong><span>Complete downloads are copied into your library automatically. Your original files stay where they are.</span></li>
      </ol>
      <a className="quiet-button libro-external" href="https://libro.fm/user/library" target="_blank" rel="noopener noreferrer">Open Libro.fm library <ExternalLink size={14} /></a>
    </section>

    <section className="admin-card">
      <div className="admin-section-head"><div><h2>Watched folder</h2><p>This path is on your OperaLibre server, even when you use the app on your phone.</p></div>
        <span className={`libro-badge ${status?.folder ? "imported" : "waiting"}`}>{status?.folder ? "Watching" : "Not configured"}</span>
      </div>
      {!status && !loadError ? <p role="status"><LoaderCircle size={14} className="spin-icon" /> Loading import settings…</p> : null}
      {isOwner ? <form className="libro-folder-form" onSubmit={(event) => { event.preventDefault(); if (folder.trim()) void save(folder.trim()); }}>
        <label htmlFor="libro-folder">Folder on server</label>
        <input id="libro-folder" value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="/path/to/Libro downloads" autoComplete="off" spellCheck={false} disabled={!status || busy || running} aria-describedby="libro-folder-help" />
        <p id="libro-folder-help">Choose an existing folder outside the library and server data folders. Extract ZIPs elsewhere first, then move the complete book folder here.</p>
        <div className="libro-actions">
          <button type="submit" disabled={!status || !folder.trim() || busy || running}>{busy ? <LoaderCircle size={14} className="spin-icon" /> : <Check size={14} />} Save folder</button>
          {status?.folder ? <button type="button" className="quiet-button" onClick={() => void save(null)} disabled={busy || running}>Stop watching</button> : null}
        </div>
      </form> : <p>{status?.folder ?? "The server owner can choose an import folder here."}</p>}
      {notice ? <p className="admin-message success" role="status">{notice}</p> : null}
      {error || loadError || status?.error ? <p className="admin-message error" role="alert">{error ?? loadError ?? status?.error}</p> : null}
    </section>

    <section className="admin-card">
      <div className="admin-section-head"><div><h2>Import activity</h2><p>{status?.lastChecked ? `Last checked ${new Date(Number(status.lastChecked)).toLocaleString()}.` : "Checks run every 30 seconds. Downloads must stay unchanged for at least 60 seconds."}</p></div>
        <button type="button" className="quiet-button" onClick={() => void scan()} disabled={!status?.folder || busy || running}>{running ? <LoaderCircle size={14} className="spin-icon" /> : <RefreshCcw size={14} />} {running ? "Checking…" : "Check now"}</button>
      </div>
      {running && status?.job?.progress ? <p role="status">{status.job.progress.step}</p> : null}
      {status?.items.length ? <ul className="libro-activity">{status.items.map((item, index) => <li key={`${item.name}-${index}`}>
        <div><strong>{item.name}</strong><p>{item.detail}</p>{item.importedAt ? <small>Imported {new Date(Number(item.importedAt)).toLocaleString()}</small> : null}</div>
        <span className={`libro-badge ${item.status}`}>{labels[item.status]}</span>
      </li>)}</ul> : <div className="libro-empty"><FolderOpen size={28} /><p>{status?.folder ? "No downloads found yet. Add an M4B or a complete MP3 book folder to get started." : "Choose a folder to start importing your Libro.fm books."}</p></div>}
    </section>

    <section className="admin-card">
      <div className="admin-section-head"><div><h2>Other ways to add books</h2><p>Upload audio files from this device, or use the Audible tab for your connected Libation library.</p></div><button type="button" onClick={onUpload}><Upload size={14} /> Upload files</button></div>
      <p>Imported books use the same library access rules as administrator uploads. Libro.fm sign-in and purchases happen on Libro.fm; listening progress stays in OperaLibre.</p>
    </section>
  </div>;
}
