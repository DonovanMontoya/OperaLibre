import {
  BookOpen,
  Check,
  Database,
  KeyRound,
  LoaderCircle,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  changePassword,
  createUser,
  deleteDownloadedBook,
  deleteUser,
  listUsers,
  mediaUrl,
  updateUserBookAccess
} from "./api";
import type { AuthUser, Book } from "./types";

type AdminSection = "overview" | "users" | "books";

export function AdminPanel({
  currentUser,
  books,
  onClose,
  onUpload,
  onRescan,
  onOpenBook,
  onBooksChanged
}: {
  currentUser: AuthUser;
  books: Book[];
  onClose?: () => void;
  onUpload: () => void;
  onRescan: () => Promise<void>;
  onOpenBook?: (bookId: string) => void;
  onBooksChanged: (books: Book[]) => void;
}) {
  const [section, setSection] = useState<AdminSection>("overview");
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);

  async function refreshUsers() {
    setLoading(true);
    setError(null);
    try {
      setUsers(await listUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load users.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshUsers();
  }, []);

  const readers = users.filter((user) => !user.isAdmin);
  const restrictedReaders = readers.filter((user) => user.allowedBookIds !== null);
  const totalTracks = books.reduce((sum, book) => sum + book.trackCount, 0);
  const totalHours = books.reduce((sum, book) => sum + (book.durationSeconds ?? 0), 0) / 3600;
  const sortedBooks = useMemo(
    () => [...books].sort((a, b) => a.title.localeCompare(b.title)),
    [books]
  );

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setBusyKey("create");
    setError(null);
    setNotice(null);
    try {
      const created = await createUser(newUsername, newPassword, newIsAdmin);
      setUsers((existing) => [...existing, created]);
      setNewUsername("");
      setNewPassword("");
      setNewIsAdmin(false);
      setNotice(`${created.username} can now sign in.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the account.");
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDelete(user: AuthUser) {
    if (!window.confirm(`Delete ${user.username}? Their listening progress will also be removed.`)) return;
    setBusyKey(`delete:${user.id}`);
    setError(null);
    try {
      await deleteUser(user.id);
      setUsers((existing) => existing.filter((candidate) => candidate.id !== user.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the account.");
    } finally {
      setBusyKey(null);
    }
  }

  async function handleResetPassword(user: AuthUser) {
    const password = window.prompt(`Set a new password for ${user.username} (at least 6 characters):`);
    if (!password) return;
    setBusyKey(`password:${user.id}`);
    setError(null);
    try {
      await changePassword(user.id, password);
      setNotice(`Password reset for ${user.username}. Their other sessions were signed out.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset the password.");
    } finally {
      setBusyKey(null);
    }
  }

  async function saveAccess(user: AuthUser, allowedBookIds: string[] | null) {
    setBusyKey(`access:${user.id}`);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateUserBookAccess(user.id, allowedBookIds);
      setUsers((existing) => existing.map((candidate) => candidate.id === user.id ? updated : candidate));
      setNotice(`Book access updated for ${user.username}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update book access.");
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDeleteBook(book: Book) {
    if (!window.confirm(
      `Delete the downloaded copy of ${book.title}?\n\nIts Libation catalog entry, listening progress, metadata, and user access settings will be kept so you can download it again later.`
    )) return;
    setBusyKey(`book:${book.id}`);
    setError(null);
    setNotice(null);
    try {
      const nextBooks = await deleteDownloadedBook(book.id);
      onBooksChanged(nextBooks);
      setNotice(`${book.title} was removed from this server. It remains available to redownload from Libation.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the downloaded book.");
    } finally {
      setBusyKey(null);
    }
  }

  function toggleBook(user: AuthUser, bookId: string) {
    const current = user.allowedBookIds ?? books.map((book) => book.id);
    const next = current.includes(bookId)
      ? current.filter((candidate) => candidate !== bookId)
      : [...current, bookId];
    void saveAccess(user, next);
  }

  return (
    <section className={`admin-shell ${onClose ? "admin-overlay" : ""}`} aria-label="Administration">
      <header className="admin-head">
        <div>
          <span className="eyebrow"><ShieldCheck size={13} /> Administration</span>
          <h1>Library control room</h1>
          <p>Manage accounts, permissions, and the books available from this server.</p>
        </div>
        {onClose ? (
          <button type="button" className="icon-button" aria-label="Close administration" onClick={onClose}>
            <X size={18} />
          </button>
        ) : null}
      </header>

      <nav className="admin-nav" aria-label="Admin sections">
        {(["overview", "users", "books"] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={section === item ? "selected" : ""}
            onClick={() => setSection(item)}
          >
            {item === "overview" ? <Database size={15} /> : item === "users" ? <Users size={15} /> : <BookOpen size={15} />}
            {item === "overview" ? "Overview" : item === "users" ? "Users & access" : "Downloaded books"}
          </button>
        ))}
      </nav>

      {error ? <p className="admin-message error">{error}</p> : null}
      {notice ? <p className="admin-message success"><Check size={14} /> {notice}</p> : null}

      {section === "overview" ? (
        <div className="admin-content">
          <div className="admin-metrics">
            <article><span>Accounts</span><strong>{users.length}</strong><small>{readers.length} readers · {users.length - readers.length} admins</small></article>
            <article><span>Downloaded books</span><strong>{books.length}</strong><small>{totalTracks} audio tracks on the server</small></article>
            <article><span>Listening time</span><strong>{Math.round(totalHours).toLocaleString()}h</strong><small>available across the collection</small></article>
            <article><span>Restricted readers</span><strong>{restrictedReaders.length}</strong><small>{readers.length - restrictedReaders.length} can access every book</small></article>
          </div>
          <section className="admin-card admin-quick-actions">
            <div><h2>Library operations</h2><p>Add a download to the collection or scan the server folders for changes.</p></div>
            <div>
              <button type="button" onClick={onUpload}><Upload size={15} /> Upload audiobook</button>
              <button
                type="button"
                disabled={busyKey === "rescan"}
                onClick={async () => {
                  setBusyKey("rescan");
                  setError(null);
                  try { await onRescan(); setNotice("Library rescan complete."); }
                  catch (err) { setError(err instanceof Error ? err.message : "Rescan failed."); }
                  finally { setBusyKey(null); }
                }}
              >
                {busyKey === "rescan" ? <LoaderCircle size={15} className="spin-icon" /> : <RefreshCcw size={15} />}
                Rescan library
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {section === "users" ? (
        <div className="admin-content admin-user-layout">
          <section className="admin-card">
            <div className="admin-section-head"><div><h2>Accounts</h2><p>Reset passwords, remove readers, and control each reader&rsquo;s shelf.</p></div><button type="button" className="quiet-button" onClick={() => void refreshUsers()}><RefreshCcw size={14} /> Refresh</button></div>
            {loading ? <p className="admin-empty"><LoaderCircle size={16} className="spin-icon" /> Loading accounts…</p> : (
              <div className="admin-user-list">
                {users.map((user) => {
                  const allBooks = user.isAdmin || user.allowedBookIds === null;
                  const accessBusy = busyKey === `access:${user.id}`;
                  return (
                    <article className="admin-user" key={user.id}>
                      <div className="admin-user-head">
                        <div className="admin-avatar">{user.username.slice(0, 1).toUpperCase()}</div>
                        <div><strong>{user.username}</strong><span>{user.isAdmin ? "Administrator" : allBooks ? "All books" : `${user.allowedBookIds?.length ?? 0} of ${books.length} books`}{user.id === currentUser.id ? " · you" : ""}</span></div>
                        <div className="admin-row-actions">
                          {user.id !== currentUser.id ? <button type="button" disabled={busyKey !== null} onClick={() => void handleResetPassword(user)}><KeyRound size={13} /> Reset</button> : null}
                          <button type="button" className="danger" disabled={user.id === currentUser.id || busyKey !== null} onClick={() => void handleDelete(user)}><Trash2 size={13} /> Delete</button>
                        </div>
                      </div>
                      {!user.isAdmin ? (
                        <div className="admin-access">
                          <label className="admin-all-access"><input type="checkbox" checked={allBooks} disabled={accessBusy} onChange={(event) => void saveAccess(user, event.currentTarget.checked ? null : [])} /><span><strong>All books</strong><small>New downloads are included automatically</small></span></label>
                          {!allBooks ? (
                            <div className="admin-book-checks">
                              {sortedBooks.map((book) => <label key={book.id}><input type="checkbox" checked={user.allowedBookIds?.includes(book.id) ?? false} disabled={accessBusy} onChange={() => toggleBook(user, book.id)} /><span>{book.title}</span></label>)}
                              {books.length === 0 ? <p>No books are currently downloaded.</p> : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <form className="admin-card admin-create-user" onSubmit={handleCreate}>
            <span className="section-label"><UserPlus size={13} /> New account</span>
            <h2>Create a user</h2>
            <label><span>Username</span><input value={newUsername} onChange={(event) => setNewUsername(event.currentTarget.value)} required /></label>
            <label><span>Temporary password</span><input type="password" minLength={6} value={newPassword} onChange={(event) => setNewPassword(event.currentTarget.value)} required /></label>
            <label className="admin-checkbox"><input type="checkbox" checked={newIsAdmin} onChange={(event) => setNewIsAdmin(event.currentTarget.checked)} /><span><strong>Administrator</strong><small>Can manage users and the full library</small></span></label>
            <button type="submit" disabled={busyKey === "create"}>{busyKey === "create" ? <LoaderCircle size={15} className="spin-icon" /> : <UserPlus size={15} />} Create account</button>
          </form>
        </div>
      ) : null}

      {section === "books" ? (
        <div className="admin-content">
          <section className="admin-card">
            <div className="admin-section-head"><div><h2>Downloaded books</h2><p>These titles are stored in the OperaLibre library and can be streamed or downloaded by permitted users.</p></div><button type="button" onClick={onUpload}><Upload size={14} /> Add book</button></div>
            <div className="admin-library-list">
              {sortedBooks.map((book) => {
                const granted = users.filter((user) => user.isAdmin || user.allowedBookIds === null || user.allowedBookIds.includes(book.id)).length;
                return <div className="admin-library-row" key={book.id}><button type="button" className="admin-book-open" onClick={() => onOpenBook?.(book.id)}><span className="admin-book-cover">{book.coverArtUrl ? <img src={mediaUrl(book.coverArtUrl)} alt="" /> : <BookOpen size={18} />}</span><span><strong>{book.title}</strong><small>{book.author ?? "Unknown author"} · {book.trackCount} track{book.trackCount === 1 ? "" : "s"}</small></span><span className="admin-grant-count"><Users size={13} /> {granted}</span></button><button type="button" className="admin-delete-book danger" disabled={busyKey !== null} onClick={() => void handleDeleteBook(book)} aria-label={`Delete downloaded copy of ${book.title}`}>{busyKey === `book:${book.id}` ? <LoaderCircle size={14} className="spin-icon" /> : <Trash2 size={14} />}<span>Delete copy</span></button></div>;
              })}
              {books.length === 0 ? <p className="admin-empty">No downloaded books were found. Upload one or rescan the library.</p> : null}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
