import {
  ArrowUpCircle,
  BookOpen,
  Check,
  CloudDownload,
  Database,
  Download,
  ExternalLink,
  Gauge,
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
import { useEffect, useMemo, useRef, useState } from "react";
import {
  changePassword,
  createUser,
  deleteDownloadedBook,
  deleteUser,
  decideLibationRequest,
  downloadServerBackup,
  getFaststartStatus,
  getBooks,
  getFrontendUpdateStatus,
  getJob,
  getUpdateStatus,
  installFrontendUpdate,
  installServerUpdate,
  isNativeApp,
  listLibationRequests,
  listUsers,
  mediaUrl,
  restoreServerBackup,
  startFaststartConversion,
  updateUserBookAccess,
  updateUserLibationApproval,
  updateUserLibationAccess,
  updateUserRole
} from "./api";
import type {
  AuthUser,
  Book,
  FaststartStatus,
  FrontendUpdateStatus,
  JobStatus,
  LibationAccess,
  LibationDownloadRequest,
  UpdateStatus
} from "./types";
import { FRONTEND_VERSION } from "./version";

type AdminSection = "overview" | "users" | "requests" | "books";
type AccountRole = "owner" | "admin" | "reader";

function isRunningJob(job: JobStatus | null) {
  return !!job && (job.status === "queued" || job.status === "running");
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MiB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

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
  const [libationRequests, setLibationRequests] = useState<LibationDownloadRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<AccountRole>("reader");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [frontendUpdateStatus, setFrontendUpdateStatus] = useState<FrontendUpdateStatus | null>(null);
  const [updateChecking, setUpdateChecking] = useState(true);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [frontendUpdateInstalling, setFrontendUpdateInstalling] = useState(false);
  const [faststart, setFaststart] = useState<FaststartStatus | null>(null);
  const [faststartChecking, setFaststartChecking] = useState(false);
  const faststartSurveyed = useRef(false);
  const [faststartStarting, setFaststartStarting] = useState(false);
  const [faststartConfirming, setFaststartConfirming] = useState(false);
  const [faststartJob, setFaststartJob] = useState<JobStatus | null>(null);
  const [faststartError, setFaststartError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState<"export" | "import" | null>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);

  async function refreshUsers() {
    setLoading(true);
    setError(null);
    try {
      const [nextUsers, nextRequests] = await Promise.all([listUsers(), listLibationRequests()]);
      setUsers(nextUsers);
      setLibationRequests(nextRequests);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load users.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshUpdate(force = false) {
    setUpdateChecking(true);
    if (force) {
      setError(null);
      setNotice(null);
    }
    try {
      const [serverResult, frontendResult] = await Promise.allSettled([
        getUpdateStatus(30_000, force),
        isNativeApp()
          ? Promise.resolve(null)
          : getFrontendUpdateStatus(
              30_000,
              force,
              FRONTEND_VERSION === "dev" ? undefined : FRONTEND_VERSION
            )
      ]);
      if (serverResult.status === "fulfilled") setUpdateStatus(serverResult.value);
      if (frontendResult.status === "fulfilled" && frontendResult.value) {
        setFrontendUpdateStatus(frontendResult.value);
      }
      if (force) {
        if (serverResult.status === "rejected") {
          setError(serverResult.reason instanceof Error ? serverResult.reason.message : "Could not check for server updates.");
        } else if (
          !serverResult.value.updateAvailable
          && (
            frontendResult.status !== "fulfilled"
            || !frontendResult.value?.updateAvailable
          )
        ) {
          setNotice(`The server is up to date at OperaLibre ${serverResult.value.currentVersion}.`);
        }
      }
    } finally {
      // Update discovery should never prevent administration of the server.
      setUpdateChecking(false);
    }
  }

  async function refreshFaststart() {
    setFaststartChecking(true);
    try {
      const status = await getFaststartStatus();
      setFaststart(status);
      setFaststartError(null);
      if (status.activeJobId) {
        const job = await getJob(status.activeJobId).catch(() => null);
        if (job) setFaststartJob(job);
      }
    } catch (err) {
      setFaststartError(
        err instanceof Error ? err.message : "Could not check the library for faststart files."
      );
    } finally {
      setFaststartChecking(false);
    }
  }

  async function handleBackupExport() {
    setBackupBusy("export");
    setError(null);
    setNotice(null);
    try {
      const { blob, filename } = await downloadServerBackup();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice("Server backup downloaded. Store it somewhere private; it contains account credentials and session data.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export the server backup.");
    } finally {
      setBackupBusy(null);
    }
  }

  async function handleBackupImport(file: File) {
    if (backupInputRef.current) backupInputRef.current.value = "";
    const confirmed = window.confirm(
      `Restore ${file.name}?\n\nThis replaces accounts, reading logs, listening progress, permissions, metadata, work links, and other server-owned data. Audiobook files and server.config are not changed. OperaLibre will save the current data as a safety backup first.`
    );
    if (!confirmed) return;
    const typed = window.prompt(`Type RESTORE to replace this server's data from ${file.name}.`);
    if (typed !== "RESTORE") return;

    setBackupBusy("import");
    setError(null);
    setNotice(null);
    try {
      const restored = await restoreServerBackup(file);
      const summary = `Backup restored: ${restored.accounts} accounts, ${restored.progressRecords} progress records, ${restored.readingSessions} reading sessions, and ${restored.completions} completions. The previous state is saved as ${restored.safetyBackup}.`;
      if (!restored.sessionRetained) {
        window.alert(`${summary}\n\nThe restored backup has different sign-in sessions. Sign in with an account from the backup to continue.`);
        window.location.reload();
        return;
      }
      await refreshUsers();
      if (!restored.warning) {
        try {
          onBooksChanged(await getBooks());
        } catch {
          setNotice(`${summary} The restored data is active, but this page could not reload the refreshed library. Reopen OperaLibre to refresh it.`);
          return;
        }
      }
      setNotice(restored.warning ? `${summary} ${restored.warning}` : summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore the server backup.");
    } finally {
      setBackupBusy(null);
    }
  }

  useEffect(() => {
    void refreshUsers();
    void refreshUpdate();
  }, []);

  // Surveying the library reads the head of every MP4 file, so it waits until
  // the tab that shows the result is actually open.
  useEffect(() => {
    if (section !== "books" || faststartSurveyed.current) return;
    faststartSurveyed.current = true;
    void refreshFaststart();
  }, [section]);

  // A conversion runs on the server as a job; follow it until it settles, then
  // pick up the library it rewrote.
  useEffect(() => {
    if (!faststartJob || !isRunningJob(faststartJob)) return;
    const jobId = faststartJob.id;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getJob(jobId)
        .then((next) => {
          if (cancelled) return;
          setFaststartJob(next);
          if (!isRunningJob(next)) {
            void refreshFaststart();
            void onRescan().catch(() => {});
          }
        })
        .catch(() => {
          // A dropped poll is not a failed conversion; try again next tick.
        });
    }, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [faststartJob?.id, faststartJob?.status]);

  const readers = users.filter((user) => !user.isAdmin);
  const pendingRequests = libationRequests.filter((request) => request.status === "pending");
  const canApprove = currentUser.isOwner || currentUser.canApproveLibationRequests;
  const adminSections: AdminSection[] = canApprove
    ? ["overview", "users", "requests", "books"]
    : ["overview", "users", "books"];
  const totalTracks = books.reduce((sum, book) => sum + book.trackCount, 0);
  const totalHours = books.reduce((sum, book) => sum + (book.durationSeconds ?? 0), 0) / 3600;
  const sortedBooks = useMemo(
    () => [...books].sort((a, b) => a.title.localeCompare(b.title)),
    [books]
  );
  // What a conversion started right now would actually touch: books somebody
  // is listening to are left out by the server.
  const faststartPlan = useMemo(() => {
    const convertible = (faststart?.books ?? []).filter((book) => !book.inUse);
    return {
      books: convertible.length,
      files: convertible.reduce((sum, book) => sum + book.pendingFiles, 0),
      bytes: convertible.reduce((sum, book) => sum + book.pendingBytes, 0),
      inUse: (faststart?.books.length ?? 0) - convertible.length
    };
  }, [faststart]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setBusyKey("create");
    setError(null);
    setNotice(null);
    try {
      const isOwner = newRole === "owner";
      const isAdmin = newRole !== "reader";
      const created = await createUser(
        newUsername,
        newPassword,
        isAdmin,
        null,
        isOwner,
        isAdmin ? "direct" : "approval",
        isOwner
      );
      setUsers((existing) => [...existing, created]);
      setNewUsername("");
      setNewPassword("");
      setNewRole("reader");
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
    const password = window.prompt(`Set a new password for ${user.username} (at least 12 characters):`);
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

  async function saveLibationAccess(user: AuthUser, libationAccess: LibationAccess) {
    setBusyKey(`libation-access:${user.id}`);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateUserLibationAccess(user.id, libationAccess);
      setUsers((existing) => existing.map((candidate) => candidate.id === user.id ? updated : candidate));
      setNotice(`Libation access updated for ${user.username}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update Libation access.");
    } finally {
      setBusyKey(null);
    }
  }

  async function saveRole(user: AuthUser, role: AccountRole) {
    setBusyKey(`role:${user.id}`);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateUserRole(user.id, role !== "reader", role === "owner");
      setUsers((existing) => existing.map((candidate) => candidate.id === user.id ? updated : candidate));
      setNotice(`${user.username} is now ${role === "owner" ? "an owner" : role === "admin" ? "an administrator" : "a reader"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the account role.");
    } finally {
      setBusyKey(null);
    }
  }

  async function saveApprovalPermission(user: AuthUser, canApproveLibationRequests: boolean) {
    setBusyKey(`approval:${user.id}`);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateUserLibationApproval(user.id, canApproveLibationRequests);
      setUsers((existing) => existing.map((candidate) => candidate.id === user.id ? updated : candidate));
      setNotice(`Approval permission updated for ${user.username}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update approval permission.");
    } finally {
      setBusyKey(null);
    }
  }

  async function decideRequest(request: LibationDownloadRequest, approved: boolean) {
    setBusyKey(`request:${request.id}`);
    setError(null);
    setNotice(null);
    try {
      const updated = await decideLibationRequest(request.id, approved);
      setLibationRequests((existing) => existing.map((item) => item.id === updated.id ? updated : item));
      setNotice(approved ? `${request.title} was approved and queued.` : `${request.title} was declined.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not decide the download request.");
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

  function askToConvertFaststart() {
    if (!faststart || faststart.pendingFiles === 0) return;
    if (faststartPlan.files === 0) {
      setFaststartError(
        "Every remaining book is being listened to right now. Try again once those sessions end."
      );
      return;
    }
    setFaststartError(null);
    setFaststartConfirming(true);
  }

  async function handleConvertFaststart() {
    setFaststartConfirming(false);
    setFaststartStarting(true);
    setFaststartError(null);
    setNotice(null);
    try {
      const { jobId } = await startFaststartConversion();
      const started = await getJob(jobId).catch(() => null);
      setFaststartJob(
        started ?? {
          id: jobId,
          kind: "library-faststart",
          targetId: null,
          status: "queued",
          startedAt: String(Date.now()),
          finishedAt: null,
          exitCode: null,
          output: "",
          error: null
        }
      );
    } catch (err) {
      setFaststartError(err instanceof Error ? err.message : "Could not start the conversion.");
    } finally {
      setFaststartStarting(false);
    }
  }

  async function handleInstallUpdate() {
    if (!updateStatus?.updateAvailable || !updateStatus.canAutoUpdate || !currentUser.isOwner) return;
    if (!window.confirm(
      `Update this server from ${updateStatus.currentVersion} to ${updateStatus.latestVersion}?\n\nOperaLibre will restart and this page will reconnect automatically.`
    )) return;

    const targetVersion = updateStatus.latestVersion;
    setUpdateInstalling(true);
    setError(null);
    setNotice("Downloading the verified update package…");
    try {
      await installServerUpdate();
      setNotice("The server is restarting. This page will reconnect when the update is ready…");
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        try {
          const status = await getUpdateStatus(3_000);
          if (status.currentVersion === targetVersion) {
            window.location.reload();
            return;
          }
        } catch {
          // The expected restart window temporarily makes the API unavailable.
        }
      }
      setNotice("The update is still finishing. Reload this page in a moment.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not install the server update.");
      setNotice(null);
    } finally {
      setUpdateInstalling(false);
    }
  }

  async function handleInstallFrontendUpdate() {
    if (
      !frontendUpdateStatus?.updateAvailable
      || !frontendUpdateStatus.canAutoUpdate
      || !currentUser.isOwner
    ) return;
    if (!window.confirm(
      `Update the web frontend from ${frontendUpdateStatus.currentVersion} to ${frontendUpdateStatus.latestVersion}?\n\nThe server and active playback will keep running. This page will reload when the new frontend is ready.`
    )) return;

    setFrontendUpdateInstalling(true);
    setError(null);
    setNotice("Downloading the verified web frontend package…");
    try {
      await installFrontendUpdate();
      setNotice("The new web frontend is ready. Reloading…");
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not install the frontend update.");
      setNotice(null);
      setFrontendUpdateInstalling(false);
    }
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
          <button type="button" className="icon-button admin-close" aria-label="Close administration" onClick={onClose}>
            <X size={18} />
          </button>
        ) : null}
      </header>

      <nav className="admin-nav" aria-label="Admin sections">
        {adminSections.map((item) => (
          <button
            key={item}
            type="button"
            className={section === item ? "selected" : ""}
            onClick={() => setSection(item)}
          >
            {item === "overview" ? <Database size={15} /> : item === "users" ? <Users size={15} /> : item === "requests" ? <CloudDownload size={15} /> : <BookOpen size={15} />}
            {item === "overview" ? "Overview" : item === "users" ? "Users & access" : item === "requests" ? `Requests${pendingRequests.length ? ` (${pendingRequests.length})` : ""}` : "Downloaded books"}
          </button>
        ))}
      </nav>

      {error ? <p className="admin-message error">{error}</p> : null}
      {notice ? <p className="admin-message success"><Check size={14} /> {notice}</p> : null}

      {section === "overview" ? (
        <div className="admin-content">
          <div className="admin-metrics">
            <article><span>Accounts</span><strong>{users.length}</strong><small>{readers.length} readers · {users.filter((user) => user.isAdmin && !user.isOwner).length} admins · {users.filter((user) => user.isOwner).length} owners</small></article>
            <article><span>Downloaded books</span><strong>{books.length}</strong><small>{totalTracks} audio tracks on the server</small></article>
            <article><span>Listening time</span><strong>{Math.round(totalHours).toLocaleString()}h</strong><small>available across the collection</small></article>
            <article><span>Pending requests</span><strong>{canApprove ? pendingRequests.length : "—"}</strong><small>{users.filter((user) => !user.isOwner && user.libationAccess === "direct").length} accounts can download directly</small></article>
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

          {currentUser.isOwner ? (
            <section className="admin-card admin-backup-card">
              <div className="admin-software-head">
                <div className="admin-software-copy">
                  <span className="section-label"><Database size={13} /> Server backup</span>
                  <h2>Export or restore server data</h2>
                  <p>
                    Back up accounts, permissions, reading logs, listening progress, per-book settings,
                    metadata, work links, Libation records, and stable library IDs. Audiobook files and
                    <code>server.config</code> are not included; Libation accounts may need to be reconnected
                    after moving to another server. Backup files contain sensitive account data.
                  </p>
                </div>
                <div className="admin-backup-actions">
                  <button
                    type="button"
                    disabled={backupBusy !== null}
                    onClick={() => void handleBackupExport()}
                  >
                    {backupBusy === "export" ? <LoaderCircle size={15} className="spin-icon" /> : <Download size={15} />}
                    {backupBusy === "export" ? "Exporting…" : "Export backup"}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={backupBusy !== null}
                    onClick={() => backupInputRef.current?.click()}
                  >
                    {backupBusy === "import" ? <LoaderCircle size={15} className="spin-icon" /> : <Upload size={15} />}
                    {backupBusy === "import" ? "Restoring…" : "Restore backup"}
                  </button>
                  <input
                    ref={backupInputRef}
                    className="admin-backup-input"
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file) void handleBackupImport(file);
                    }}
                  />
                </div>
              </div>
            </section>
          ) : null}

          <section className="admin-card admin-software-card">
            <div className="admin-software-head">
              <div className="admin-software-copy">
                <span className="section-label"><ArrowUpCircle size={13} /> Software versions</span>
                <h2>OperaLibre software</h2>
                <p>Review installed versions and manage available updates in one place.</p>
              </div>
              <div className="admin-software-actions">
                <button
                  type="button"
                  className="quiet-button"
                  disabled={updateChecking || updateInstalling || frontendUpdateInstalling}
                  onClick={() => void refreshUpdate(true)}
                >
                  {updateChecking ? <LoaderCircle size={14} className="spin-icon" /> : <RefreshCcw size={14} />}
                  {updateChecking ? "Checking…" : "Check for updates"}
                </button>
              </div>
            </div>
            <div className="admin-software-versions" aria-live="polite">
              <article className={updateStatus?.updateAvailable ? "update-available" : ""}>
                <div className="admin-software-version-head">
                  <div>
                    <span>Server</span>
                    <strong>{updateStatus?.currentVersion ?? (updateChecking ? "Checking…" : "Unavailable")}</strong>
                  </div>
                  {updateStatus?.updateAvailable ? (
                    <span className="admin-update-badge"><ArrowUpCircle size={12} /> {updateStatus.latestVersion} available</span>
                  ) : updateStatus && !updateChecking ? (
                    <span className="admin-current-badge"><Check size={12} /> Up to date</span>
                  ) : null}
                </div>
                {updateStatus?.updateAvailable ? (
                  <div className="admin-software-update">
                    <p>
                      {updateStatus.canAutoUpdate
                        ? currentUser.isOwner
                          ? "Install the verified package and restart the server from here."
                          : "An owner can install this update."
                        : updateStatus.message ?? "This installation must be updated manually."}
                    </p>
                    <div className="admin-update-actions">
                      {currentUser.isOwner && updateStatus.canAutoUpdate ? (
                        <button
                          type="button"
                          disabled={updateInstalling || frontendUpdateInstalling}
                          onClick={() => void handleInstallUpdate()}
                        >
                          {updateInstalling ? <LoaderCircle size={15} className="spin-icon" /> : <ArrowUpCircle size={15} />}
                          {updateInstalling ? "Updating…" : "Update server"}
                        </button>
                      ) : null}
                      <a className="quiet-button" href={updateStatus.releaseUrl} target="_blank" rel="noreferrer">
                        <ExternalLink size={14} /> Release notes
                      </a>
                    </div>
                  </div>
                ) : null}
              </article>
              <article className={frontendUpdateStatus?.updateAvailable ? "update-available" : ""}>
                <div className="admin-software-version-head">
                  <div>
                    <span>Web frontend</span>
                    <strong>{frontendUpdateStatus?.currentVersion ?? (FRONTEND_VERSION === "dev" ? "Development" : FRONTEND_VERSION)}</strong>
                  </div>
                  {frontendUpdateStatus?.updateAvailable ? (
                    <span className="admin-update-badge"><ArrowUpCircle size={12} /> {frontendUpdateStatus.latestVersion} available</span>
                  ) : frontendUpdateStatus && !updateChecking ? (
                    <span className="admin-current-badge"><Check size={12} /> Up to date</span>
                  ) : null}
                </div>
                {frontendUpdateStatus?.updateAvailable ? (
                  <div className="admin-software-update">
                    <p>
                      {frontendUpdateStatus.canAutoUpdate
                        ? currentUser.isOwner
                          ? "Install the verified frontend package without restarting the server."
                          : "An owner can install this update."
                        : frontendUpdateStatus.message ?? "This frontend must be updated manually."}
                    </p>
                    <div className="admin-update-actions">
                      {currentUser.isOwner && frontendUpdateStatus.canAutoUpdate ? (
                        <button
                          type="button"
                          disabled={frontendUpdateInstalling || updateInstalling}
                          onClick={() => void handleInstallFrontendUpdate()}
                        >
                          {frontendUpdateInstalling
                            ? <LoaderCircle size={15} className="spin-icon" />
                            : <ArrowUpCircle size={15} />}
                          {frontendUpdateInstalling ? "Updating…" : "Update frontend"}
                        </button>
                      ) : null}
                      <a
                        className="quiet-button"
                        href={frontendUpdateStatus.releaseUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink size={14} /> Release notes
                      </a>
                    </div>
                  </div>
                ) : null}
              </article>
            </div>
          </section>
        </div>
      ) : null}

      {section === "users" ? (
        <div className="admin-content admin-user-layout">
          <section className="admin-card">
            <div className="admin-section-head"><div><h2>Accounts</h2><p>{currentUser.isOwner ? "Assign owners and administrators, then choose how each account can use Libation." : "Manage reader accounts, passwords, and library access."}</p></div><button type="button" className="quiet-button" onClick={() => void refreshUsers()}><RefreshCcw size={14} /> Refresh</button></div>
            {loading ? <p className="admin-empty"><LoaderCircle size={16} className="spin-icon" /> Loading accounts…</p> : (
              <div className="admin-user-list">
                {users.map((user) => {
                  const allBooks = user.isAdmin || user.allowedBookIds === null;
                  const accessBusy = busyKey === `access:${user.id}`;
                  const role: AccountRole = user.isOwner ? "owner" : user.isAdmin ? "admin" : "reader";
                  const canManageTarget = currentUser.isOwner || !user.isAdmin;
                  return (
                    <article className="admin-user" key={user.id}>
                      <div className="admin-user-head">
                        <div className="admin-avatar">{user.username.slice(0, 1).toUpperCase()}</div>
                        <div><strong>{user.username}</strong><span>{user.isOwner ? "Owner" : user.isAdmin ? "Administrator" : allBooks ? "Reader · all books" : `Reader · ${user.allowedBookIds?.length ?? 0} of ${books.length} books`}{user.id === currentUser.id ? " · you" : ""}</span></div>
                        <div className="admin-row-actions">
                          {user.id !== currentUser.id ? <button type="button" disabled={busyKey !== null || !canManageTarget} onClick={() => void handleResetPassword(user)}><KeyRound size={13} /> Reset</button> : null}
                          <button type="button" className="danger" disabled={user.id === currentUser.id || busyKey !== null || !canManageTarget} onClick={() => void handleDelete(user)}><Trash2 size={13} /> Delete</button>
                        </div>
                      </div>
                      <div className="admin-access">
                          {currentUser.isOwner ? (
                            <div className="admin-libation-access">
                              <span><strong>Account role</strong><small>Owners can manage administrators; administrators can manage readers and the library.</small></span>
                              <select aria-label={`Role for ${user.username}`} value={role} disabled={user.id === currentUser.id || busyKey === `role:${user.id}`} onChange={(event) => void saveRole(user, event.currentTarget.value as AccountRole)}>
                                <option value="reader">Reader</option>
                                <option value="admin">Administrator</option>
                                <option value="owner">Owner</option>
                              </select>
                            </div>
                          ) : null}
                          {!user.isOwner ? (
                          <div className="admin-libation-access">
                            <span><strong>Libation downloads</strong><small>Choose whether this account can download directly or must request each title.</small></span>
                            <select
                              aria-label={`Libation access for ${user.username}`}
                              value={user.libationAccess}
                              disabled={busyKey === `libation-access:${user.id}` || (user.isAdmin && !currentUser.isOwner)}
                              onChange={(event) => void saveLibationAccess(user, event.currentTarget.value as LibationAccess)}
                            >
                              <option value="approval">Approval required</option>
                              <option value="direct">Allow direct downloads</option>
                            </select>
                          </div>
                          ) : null}
                          {user.isAdmin ? (
                            <label className="admin-all-access"><input type="checkbox" checked={user.canApproveLibationRequests} disabled={!currentUser.isOwner || user.isOwner || busyKey === `approval:${user.id}`} onChange={(event) => void saveApprovalPermission(user, event.currentTarget.checked)} /><span><strong>Can approve requests</strong><small>May approve or decline per-book Libation download requests</small></span></label>
                          ) : null}
                          {!user.isAdmin ? (
                            <>
                          <label className="admin-all-access"><input type="checkbox" checked={allBooks} disabled={accessBusy} onChange={(event) => void saveAccess(user, event.currentTarget.checked ? null : [])} /><span><strong>All books</strong><small>New downloads are included automatically</small></span></label>
                          {!allBooks ? (
                            <div className="admin-book-checks">
                              {sortedBooks.map((book) => <label key={book.id}><input type="checkbox" checked={user.allowedBookIds?.includes(book.id) ?? false} disabled={accessBusy} onChange={() => toggleBook(user, book.id)} /><span>{book.title}</span></label>)}
                              {books.length === 0 ? <p>No books are currently downloaded.</p> : null}
                            </div>
                          ) : null}
                            </>
                          ) : null}
                        </div>
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
            <label><span>Temporary password</span><input type="password" minLength={12} maxLength={1024} value={newPassword} onChange={(event) => setNewPassword(event.currentTarget.value)} required /></label>
            {currentUser.isOwner ? (
              <label><span>Role</span><select value={newRole} onChange={(event) => setNewRole(event.currentTarget.value as AccountRole)}><option value="reader">Reader</option><option value="admin">Administrator</option><option value="owner">Owner</option></select></label>
            ) : <p className="admin-empty">New accounts are created as readers. An owner can promote them later.</p>}
            <button type="submit" disabled={busyKey === "create"}>{busyKey === "create" ? <LoaderCircle size={15} className="spin-icon" /> : <UserPlus size={15} />} Create account</button>
          </form>
        </div>
      ) : null}

      {section === "requests" ? (
        <div className="admin-content">
          <section className="admin-card">
            <div className="admin-section-head"><div><h2>Libation requests</h2><p>Approve a title to queue its download for the requesting account.</p></div><button type="button" className="quiet-button" onClick={() => void refreshUsers()}><RefreshCcw size={14} /> Refresh</button></div>
            <div className="admin-request-list">
              {libationRequests.map((request) => (
                <article className={`admin-request ${request.status}`} key={request.id}>
                  <div><strong>{request.title}</strong><span>{request.username} · {request.profileName ? `${request.profileName} · ` : ""}{request.asin}</span></div>
                  <span className="admin-request-state">{request.status}</span>
                  {request.status === "pending" && request.userId !== currentUser.id ? (
                    <div className="admin-row-actions">
                      <button type="button" disabled={busyKey !== null} onClick={() => void decideRequest(request, true)}><Check size={13} /> Approve</button>
                      <button type="button" className="danger" disabled={busyKey !== null} onClick={() => void decideRequest(request, false)}><X size={13} /> Decline</button>
                    </div>
                  ) : request.status === "pending" ? <span className="admin-request-state">Another approver required</span> : null}
                </article>
              ))}
              {libationRequests.length === 0 ? <p className="admin-empty">No Libation download requests yet.</p> : null}
            </div>
          </section>
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

          <section className="admin-card admin-faststart-card">
            <div className="admin-software-head">
              <div className="admin-software-copy">
                <span className="section-label"><Gauge size={13} /> Streaming optimization</span>
                <h2>Faststart conversion</h2>
                <p>
                  An MP4 or M4B written without faststart keeps its index at the end of the file, so
                  players fetch the tail before the first second can play. Converting rewrites the
                  container only — audio, chapters, and tags are copied across untouched, the result
                  is verified against the original, and listening progress is unaffected.
                </p>
              </div>
              <div className="admin-software-actions">
                <button
                  type="button"
                  className="quiet-button"
                  disabled={faststartChecking || isRunningJob(faststartJob)}
                  onClick={() => void refreshFaststart()}
                >
                  {faststartChecking ? <LoaderCircle size={14} className="spin-icon" /> : <RefreshCcw size={14} />}
                  {faststartChecking ? "Checking…" : "Check files"}
                </button>
              </div>
            </div>

            {faststartError ? <p className="admin-message error">{faststartError}</p> : null}

            {!faststart && !faststartError ? (
              <p className="admin-faststart-note">
                {faststartChecking
                  ? "Reading the head of every MP4 file in the library…"
                  : "The library has not been checked yet."}
              </p>
            ) : null}

            {faststart && !faststart.enabled ? (
              <p className="admin-faststart-note">
                ffmpeg was not found on this server, so conversion is unavailable. Install ffmpeg and
                restart OperaLibre, or set <code>ffmpeg_path</code> in <code>server.config</code>.
              </p>
            ) : null}

            {faststart?.enabled ? (
              <>
                <dl className="admin-faststart-stats">
                  <div>
                    <dt>Need converting</dt>
                    <dd>{faststart.pendingFiles}</dd>
                  </div>
                  <div>
                    <dt>Already fast</dt>
                    <dd>{faststart.optimizedFiles}</dd>
                  </div>
                  <div>
                    <dt>MP4 files</dt>
                    <dd>{faststart.mp4Files}</dd>
                  </div>
                  <div>
                    <dt>To rewrite</dt>
                    <dd>{formatFileSize(faststart.pendingBytes)}</dd>
                  </div>
                </dl>

                {faststart.unreadableFiles > 0 ? (
                  <p className="admin-faststart-note">
                    {faststart.unreadableFiles} file{faststart.unreadableFiles === 1 ? "" : "s"} could
                    not be read as MP4 containers and will be left alone.
                  </p>
                ) : null}
                {faststart.verificationLimited ? (
                  <p className="admin-faststart-note">
                    ffprobe was not found beside ffmpeg. Conversions can only be verified by container
                    layout and size, not by duration, streams, or chapters.
                  </p>
                ) : null}

                {faststart.books.length > 0 ? (
                  <ul className="admin-faststart-books">
                    {faststart.books.slice(0, 8).map((book) => (
                      <li key={book.bookId}>
                        <span>{book.title}</span>
                        <em>
                          {book.pendingFiles} file{book.pendingFiles === 1 ? "" : "s"} ·{" "}
                          {formatFileSize(book.pendingBytes)}
                          {book.inUse ? " · in use" : ""}
                        </em>
                      </li>
                    ))}
                    {faststart.books.length > 8 ? (
                      <li className="admin-faststart-more">
                        and {faststart.books.length - 8} more
                      </li>
                    ) : null}
                  </ul>
                ) : (
                  <p className="admin-faststart-note">
                    <Check size={13} /> Every MP4 file in the library already starts fast.
                  </p>
                )}

                {faststart.pendingFiles > 0 && faststartConfirming && faststartPlan.files > 0 ? (
                  <div className="admin-faststart-confirm" role="group" aria-label="Confirm conversion">
                    <strong>
                      Convert {faststartPlan.files} file{faststartPlan.files === 1 ? "" : "s"} across{" "}
                      {faststartPlan.books} book{faststartPlan.books === 1 ? "" : "s"}?
                    </strong>
                    <p>
                      {formatFileSize(faststartPlan.bytes)} will be rewritten. Each file is remuxed
                      with its audio, cover, chapters, and tags copied unchanged, checked against the
                      original, and only then swapped in — a file that fails the check is left exactly
                      as it is. Listening progress is not affected.
                    </p>
                    {faststartPlan.inUse > 0 ? (
                      <p>
                        {faststartPlan.inUse} book{faststartPlan.inUse === 1 ? " is" : "s are"} being
                        listened to right now and will be left for a later run.
                      </p>
                    ) : null}
                    <p>Playback already streaming one of these files may stutter once as it is replaced.</p>
                    <div className="admin-faststart-confirm-actions">
                      <button type="button" onClick={() => void handleConvertFaststart()}>
                        <Gauge size={15} /> Convert {faststartPlan.files} file
                        {faststartPlan.files === 1 ? "" : "s"}
                      </button>
                      <button
                        type="button"
                        className="quiet-button"
                        onClick={() => setFaststartConfirming(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : faststart.pendingFiles > 0 ? (
                  <div className="admin-faststart-actions">
                    <button
                      type="button"
                      disabled={faststartStarting || isRunningJob(faststartJob)}
                      onClick={askToConvertFaststart}
                    >
                      {faststartStarting || isRunningJob(faststartJob)
                        ? <LoaderCircle size={15} className="spin-icon" />
                        : <Gauge size={15} />}
                      {isRunningJob(faststartJob)
                        ? "Converting…"
                        : `Convert ${faststart.pendingFiles} file${faststart.pendingFiles === 1 ? "" : "s"}`}
                    </button>
                    <span>
                      Books somebody is listening to right now are skipped, and every original is only
                      replaced after its converted copy passes verification.
                    </span>
                  </div>
                ) : null}
              </>
            ) : null}

            {faststartJob ? (
              <div className="admin-faststart-job">
                <span className={`admin-faststart-job-state ${faststartJob.status}`}>
                  {isRunningJob(faststartJob)
                    ? <LoaderCircle size={13} className="spin-icon" />
                    : faststartJob.status === "failed" ? <X size={13} /> : <Check size={13} />}
                  {isRunningJob(faststartJob)
                    ? "Conversion running"
                    : faststartJob.status === "failed" ? "Conversion finished with failures" : "Conversion complete"}
                </span>
                {faststartJob.output ? (
                  <pre className="admin-faststart-log">{faststartJob.output.trimEnd()}</pre>
                ) : null}
                {faststartJob.error ? <p className="admin-message error">{faststartJob.error}</p> : null}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </section>
  );
}
