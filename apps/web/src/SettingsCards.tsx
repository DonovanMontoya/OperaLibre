import {
  ChevronDown,
  CloudDownload,
  Download,
  FolderOpen,
  Gamepad2,
  LoaderCircle,
  LogOut,
  Moon,
  Network,
  Plus,
  Smartphone,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { supportsLibroDevice } from "./libroDevice";
import { LibroCatalog } from "./LibroCatalog";
import { getDeviceBooks, mergeDeviceAndServerBooks } from "./localLibrary";
import { FOLLOW_AGGRESSIVENESS_LABELS, type FollowAggressiveness } from "./readalongPreferences";
import type { CSSProperties, Dispatch, FormEvent, ReactNode, RefObject, SetStateAction } from "react";
import {
  getServerAliases,
  getServerIdentityUrl,
  getServerUrl,
  removeServerAlias,
  type ServerAlias
} from "./api";
import type { AppearanceMode } from "./appearance";
import type { AuthUser, Book, LibationAccount, LibroAccountSummary } from "./types";
import type { DeviceNotice } from "./ConfirmDialogs";
import type { NativeTab } from "./nativeTabs";
import type { ServerCapabilities } from "./serverCapabilities";

export type DeviceDownloadActivity = {
  bookId: string;
  // Kept alongside the id so the queue row survives the book leaving `books`
  // (a library refresh, a filter, a server switch) with Cancel still reachable.
  title: string;
  fraction: number | null;
  state: "queued" | "running";
  queuedAt: number;
};

export function DisplaySettings({
  appearanceMode,
  ios,
  rotationLockAvailable,
  rotationLockBusy,
  rotationLockEnabled,
  rotationLockError,
  toggleRotationLock,
  updateAppearanceMode
}: {
  appearanceMode: AppearanceMode;
  ios: boolean;
  rotationLockAvailable: boolean;
  rotationLockBusy: boolean;
  rotationLockEnabled: boolean;
  rotationLockError: string | null;
  toggleRotationLock: () => Promise<void>;
  updateAppearanceMode: (mode: AppearanceMode) => void;
}) {
  return (
    <section className="settings-card">
      <span className="section-label"><Smartphone size={13} /> Display</span>
      {ios ? <div className="settings-toggle-row settings-appearance-row">
        <span>
          <strong><Moon size={15} aria-hidden="true" /> Appearance</strong>
          <small>System follows your device's light or dark theme.</small>
        </span>
        <div className="settings-mode-toggle" role="radiogroup" aria-label="Appearance">
          {(["light", "dark", "system"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={appearanceMode === mode}
              className={appearanceMode === mode ? "selected" : undefined}
              onClick={() => updateAppearanceMode(mode)}
            >
              {mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System"}
            </button>
          ))}
        </div>
      </div> : null}
      {rotationLockAvailable ? <div className="settings-toggle-row">
        <span>
          <strong>Rotation lock</strong>
          <small>Keeps OperaLibre in its current orientation, even when device rotation is on.</small>
        </span>
        <button
          type="button"
          className="settings-switch"
          role="switch"
          aria-checked={rotationLockEnabled}
          aria-label="Rotation lock"
          disabled={rotationLockBusy}
          onClick={() => void toggleRotationLock()}
        >
          <span aria-hidden="true" />
        </button>
      </div> : null}
      {rotationLockError ? <p className="settings-hint settings-error">{rotationLockError}</p> : null}
    </section>
  );
}

export function BookStoreSettings({
  allAudibleAccounts,
  applyAdminLibraryChange,
  audibleManagement,
  brokenLibationAccounts,
  canBrowseLibation,
  currentUser,
  isOperaLibre,
  libroAccounts,
  libroAvailable,
  libroOnDevice,
  libroRefreshKey,
  localMode,
  nativeTab,
  setBooks,
  setLibroAccounts,
  setLibroDestination
}: {
  allAudibleAccounts: { id: string; name: string; }[];
  applyAdminLibraryChange: (nextBooks: Book[]) => void;
  audibleManagement: ReactNode;
  brokenLibationAccounts: LibationAccount[];
  canBrowseLibation: boolean;
  currentUser: AuthUser;
  isOperaLibre: boolean;
  libroAccounts: LibroAccountSummary[] | null;
  libroAvailable: boolean;
  libroOnDevice: boolean;
  libroRefreshKey: number;
  localMode: boolean;
  nativeTab: NativeTab;
  setBooks: Dispatch<SetStateAction<Book[]>>;
  setLibroAccounts: Dispatch<SetStateAction<LibroAccountSummary[] | null>>;
  setLibroDestination: Dispatch<SetStateAction<"server" | "device">>;
}) {
  return (
    <section className="settings-card purchase-provider-settings">
      <span className="section-label"><CloudDownload size={13} /> Book stores</span>
      <p className="settings-hint">Connections and download behavior live here. Get Books stays focused on finding titles.</p>

      {libroAvailable ? <details className="store-settings-group">
        <summary>
          <span><strong>Libro.fm</strong><small>{libroAccounts?.length ? `${libroAccounts.length} connected account${libroAccounts.length === 1 ? "" : "s"}` : "Account and download settings"}</small></span>
          <ChevronDown size={16} />
        </summary>
        <div className="store-settings-body">
          {supportsLibroDevice() && !localMode && isOperaLibre ? <label className="store-destination" htmlFor="settings-libro-destination">
            <span><strong>Download purchases to</strong><small>Choose where new Libro.fm imports are kept.</small></span>
            <select id="settings-libro-destination" value={libroOnDevice ? "device" : "server"} onChange={event => setLibroDestination(event.currentTarget.value === "device" ? "device" : "server")}>
              <option value="server">OperaLibre server</option>
              <option value="device">This device</option>
            </select>
          </label> : null}
          <LibroCatalog
            key={`settings:${currentUser.id}:${libroOnDevice ? "device" : "server"}`}
            mode="management"
            polling={nativeTab === "settings"}
            device={libroOnDevice}
            refreshKey={libroRefreshKey}
            onAccountsChanged={setLibroAccounts}
            onBooksChanged={libroOnDevice ? () => setBooks(current => mergeDeviceAndServerBooks(current.filter(book => book.source !== "device"), getDeviceBooks())) : applyAdminLibraryChange}
          />
        </div>
      </details> : null}

      {canBrowseLibation ? <details className="store-settings-group">
        <summary>
          <span><strong>Audible</strong><small>{brokenLibationAccounts.length > 0 ? `${brokenLibationAccounts.length} account${brokenLibationAccounts.length === 1 ? " needs" : "s need"} attention` : `${allAudibleAccounts.length} connected account${allAudibleAccounts.length === 1 ? "" : "s"}`}</small></span>
          <ChevronDown size={16} />
        </summary>
        {audibleManagement}
      </details> : null}
    </section>
  );
}

export function ExtrasSettings({
  followAggressiveness,
  gamesEnabled,
  sentenceFollowAvailable,
  toggleGamesEnabled,
  updateFollowAggressiveness
}: {
  followAggressiveness: FollowAggressiveness;
  gamesEnabled: boolean;
  sentenceFollowAvailable: boolean;
  toggleGamesEnabled: () => void;
  updateFollowAggressiveness: (value: FollowAggressiveness) => void;
}) {
  return (
    <section className="settings-card">
      <span className="section-label"><Gamepad2 size={13} /> Extras</span>
      <div className="settings-toggle-row">
        <span>
          <strong>Games tab</strong>
          <small>Shows optional, on-device games in the bottom navigation.</small>
        </span>
        <button
          type="button"
          className="settings-switch"
          role="switch"
          aria-checked={gamesEnabled}
          aria-label="Games tab"
          onClick={toggleGamesEnabled}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {sentenceFollowAvailable ? (
        <div className="settings-follow-group">
          <div className="settings-toggle-row">
            <span>
              <strong>Follow timing</strong>
              <small>Press Follow in the ebook to follow the narration. The reader remembers your choice.</small>
            </span>
          </div>
          <div className="follow-aggressiveness">
            <div className="follow-aggressiveness-heading">
              <label htmlFor="follow-aggressiveness">Aggressiveness</label>
              <output htmlFor="follow-aggressiveness" aria-live="polite">
                {FOLLOW_AGGRESSIVENESS_LABELS[followAggressiveness]}
              </output>
            </div>
            <input
              id="follow-aggressiveness"
              type="range"
              min="0"
              max="2"
              step="1"
              value={followAggressiveness}
              style={{ "--scrub-progress": `${followAggressiveness * 50}%` } as CSSProperties}
              aria-valuetext={FOLLOW_AGGRESSIVENESS_LABELS[followAggressiveness]}
              onChange={(event) => updateFollowAggressiveness(Number(event.currentTarget.value) as FollowAggressiveness)}
            />
            <div className="follow-aggressiveness-labels" aria-hidden="true">
              <span>Current timing</span>
              <span>A little ahead</span>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function DeviceLibrarySettings({
  deleteDeviceBook,
  deviceImport,
  downloadStatus,
  importFromDevice
}: {
  deleteDeviceBook: (book: Book) => Promise<void>;
  deviceImport: { completed: number; total: number; } | null;
  downloadStatus: DeviceNotice | null;
  importFromDevice: () => Promise<void>;
}) {
  return (
    <section className="settings-card">
      <span className="section-label"><FolderOpen size={13} /> On this device</span>
      <button type="button" className="download-btn" disabled={deviceImport !== null} onClick={() => void importFromDevice()}>
        {deviceImport ? <LoaderCircle size={13} className="spin-icon" /> : <Plus size={13} />}
        <span>{deviceImport ? `Importing ${deviceImport.completed}/${deviceImport.total || "…"}` : "Add audiobook files"}</span>
      </button>
      {getDeviceBooks().length ? (
        <div className="settings-downloads">
          {getDeviceBooks().map((book) => (
            <div key={book.id} className="settings-download-row">
              <strong>{book.title}</strong>
              <button type="button" className="download-btn" onClick={() => void deleteDeviceBook(book)}>
                <Trash2 size={13} /><span>Remove</span>
              </button>
            </div>
          ))}
        </div>
      ) : <p className="settings-hint">Files you pick are copied into OperaLibre so playback remains available offline.</p>}
      {downloadStatus ? <p className="settings-hint">{downloadStatus.message}</p> : null}
    </section>
  );
}

export function ServerDownloadSettings({
  books,
  cancelOfflineDownload,
  demoMode,
  deviceDownloadQueue,
  downloadedBookIds,
  removeOfflineDownload
}: {
  books: Book[];
  cancelOfflineDownload: (book: Pick<Book, "id" | "title">) => Promise<void>;
  demoMode: boolean;
  deviceDownloadQueue: DeviceDownloadActivity[];
  downloadedBookIds: Set<string>;
  removeOfflineDownload: (book: Book) => Promise<void>;
}) {
  return (
    <section className="settings-card">
      <span className="section-label"><Download size={13} /> Server downloads</span>
      {demoMode ? (
        <p className="settings-hint">Demo books and their procedural audio are included on this device.</p>
      ) : (
        <>
          {deviceDownloadQueue.length > 0 ? (
            <div className="settings-downloads" aria-label="Download queue">
              {deviceDownloadQueue.map((activity, index) => {
                const title = activity.title || "Audiobook";
                return (
                  <div key={activity.bookId} className="settings-download-row">
                    <strong>{title}</strong>
                    <span className="download-status">
                      {activity.state === "queued"
                        ? `Queued${index > 0 ? ` · ${index + 1}` : ""}`
                        : activity.fraction === null
                          ? "Starting…"
                          : `${Math.round(activity.fraction * 100)}%`}
                    </span>
                    <button
                      type="button"
                      className="download-btn"
                      onClick={() => void cancelOfflineDownload({ id: activity.bookId, title })}
                      aria-label={`Cancel download of ${title}`}
                    >
                      <X size={13} />
                      <span>Cancel</span>
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
          {books.some((book) => downloadedBookIds.has(book.id) && !book.deviceBookId) ? (
            <div className="settings-downloads">
              {books
                .filter((book) => downloadedBookIds.has(book.id) && !book.deviceBookId)
                .map((book) => (
                  <div key={book.id} className="settings-download-row">
                    <strong>{book.title}</strong>
                    <button
                      type="button"
                      className="download-btn"
                      onClick={() => void removeOfflineDownload(book)}
                      aria-label={`Remove downloaded copy of ${book.title}`}
                    >
                      <Trash2 size={13} />
                      <span>Remove</span>
                    </button>
                  </div>
                ))}
            </div>
          ) : deviceDownloadQueue.length === 0 ? (
            <p className="settings-hint">No books are downloaded for offline listening yet.</p>
          ) : null}
        </>
      )}
    </section>
  );
}

export function ConnectionSettings({
  aliasError,
  aliasName,
  aliasUrl,
  audioRef,
  capabilities,
  currentUser,
  demoMode,
  isOperaLibre,
  localMode,
  onConnectServer,
  onLogout,
  pausePlayback,
  saveAlias,
  serverAliases,
  setAliasName,
  setAliasUrl,
  setServerAliases,
  setUploadModalOpen,
  switchToAlias,
  switchingAliasId
}: {
  aliasError: string | null;
  aliasName: string;
  aliasUrl: string;
  audioRef: RefObject<HTMLAudioElement | null>;
  capabilities: ServerCapabilities;
  currentUser: AuthUser;
  demoMode: boolean;
  isOperaLibre: boolean;
  localMode: boolean;
  onConnectServer: () => void;
  onLogout: () => void | Promise<void>;
  pausePlayback: (audio: HTMLAudioElement | null | undefined) => void;
  saveAlias: (event: FormEvent) => void;
  serverAliases: ServerAlias[];
  setAliasName: Dispatch<SetStateAction<string>>;
  setAliasUrl: Dispatch<SetStateAction<string>>;
  setServerAliases: Dispatch<SetStateAction<ServerAlias[]>>;
  setUploadModalOpen: Dispatch<SetStateAction<boolean>>;
  switchToAlias: (alias: ServerAlias) => Promise<void>;
  switchingAliasId: string | null;
}) {
  return (
    <section className="settings-card">
      <span className="section-label"><Network size={13} /> Connection</span>
      <div className="settings-kv">
        <span>Server</span>
        <span className="settings-value">
          {localMode ? "Not connected · on-device only" : demoMode ? "On-device demo · no network connection" : `${isOperaLibre ? "OperaLibre" : "Jellyfin"} · ${getServerUrl()}`}
        </span>
      </div>
      <div className="settings-kv">
        <span>Signed in as</span>
        <span className="settings-value">
          {currentUser.username} · {localMode ? "No account required" : demoMode ? "Demo reader" : currentUser.isOwner ? "Owner" : currentUser.isAdmin ? "Administrator" : "Reader"}
        </span>
      </div>
      {!demoMode && !localMode ? <div className="server-aliases">
        <span className="settings-label">Address aliases</span>
        <p className="settings-hint">
          Save other routes to this server, such as LAN, Tailscale, or a forwarded address.
        </p>
        {[
          { id: "primary", name: "Original address", url: getServerIdentityUrl() },
          ...serverAliases
        ].map((alias) => {
          const active = alias.url === getServerUrl();
          return (
            <div className="server-alias-row" key={alias.id}>
              <span>
                <strong>{alias.name}</strong>
                <small>{alias.url}</small>
              </span>
              <div>
                <button
                  type="button"
                  className="download-btn"
                  disabled={active || switchingAliasId !== null}
                  onClick={() => void switchToAlias(alias)}
                >
                  {active ? "Active" : switchingAliasId === alias.id ? "Testing…" : "Use"}
                </button>
                {alias.id !== "primary" ? (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${alias.name} alias`}
                    onClick={() => {
                      removeServerAlias(alias.id);
                      setServerAliases(getServerAliases());
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        <form className="server-alias-form" onSubmit={saveAlias}>
          <input
            value={aliasName}
            onChange={(event) => setAliasName(event.currentTarget.value)}
            placeholder="Name (Tailscale)"
            aria-label="Alias name"
            required
          />
          <input
            value={aliasUrl}
            onChange={(event) => setAliasUrl(event.currentTarget.value)}
            placeholder="http://100.x.x.x:4920"
            aria-label="Alias server address"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            required
          />
          <button type="submit" className="download-btn"><Plus size={13} /> Add</button>
        </form>
        {aliasError ? <p className="auth-error">{aliasError}</p> : null}
      </div> : null}
      <div className="settings-actions">
        {localMode ? (
          <button type="button" className="download-btn connection-primary" onClick={() => {
            pausePlayback(audioRef.current);
            onConnectServer();
          }}>
            <Network size={13} />
            <span>Connect a server</span>
          </button>
        ) : null}
        {capabilities.administration ? (
          <>
            <button type="button" className="download-btn" onClick={() => setUploadModalOpen(true)}>
              <Upload size={13} />
              <span>Upload audiobook</span>
            </button>
          </>
        ) : null}
        <button type="button" className="download-btn" onClick={() => {
          pausePlayback(audioRef.current);
          void onLogout();
        }}>
          <LogOut size={13} />
          <span>{localMode ? "Leave local mode" : "Sign out"}</span>
        </button>
      </div>
    </section>
  );
}
