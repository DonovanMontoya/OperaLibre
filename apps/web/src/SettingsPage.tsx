import type { useDisplaySettings } from "./useDisplaySettings";
import type { useOfflineDownloads } from "./useOfflineDownloads";
import type { usePurchases } from "./usePurchases";
import type { useReadalong } from "./useReadalong";
import type { useReaderPreferences } from "./useReaderPreferences";
import type { useServerAliases } from "./useServerAliases";
import type { useUploads } from "./useUploads";
import { ArrowDown, ChevronRight, Gauge, Settings, UserCog } from "lucide-react";
import { PlaybackSpeedControl } from "./PlaybackControls";
import {
  BookStoreSettings,
  ConnectionSettings,
  type DeviceDownloadActivity,
  DeviceLibrarySettings,
  DisplaySettings,
  ExtrasSettings,
  ServerDownloadSettings
} from "./SettingsCards";
import { ProgressSharingCard } from "./ProgressSharing";
import type { AuthUser, Book } from "./types";
import type { DeviceNotice } from "./ConfirmDialogs";
import type { NativeTab } from "./nativeTabs";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import type { ServerCapabilities } from "./serverCapabilities";

export function SettingsPage({
  applyAdminLibraryChange,
  audibleManagement,
  audioRef,
  books,
  capabilities,
  currentUser,
  demoMode,
  deviceDownloadQueue,
  deviceImport,
  displaySettings,
  downloadStatus,
  downloadedBookIds,
  gamesEnabled,
  ios,
  isOperaLibre,
  loadBooks,
  localMode,
  nativeTab,
  offlineDownloads,
  onConnectServer,
  onCurrentUserChanged,
  onLogout,
  openNativeTab,
  pausePlayback,
  purchases,
  readalong,
  readerPreferences,
  rotationLockAvailable,
  serverAliasesState,
  setBooks,
  sharedProgressAvailable,
  speed,
  toggleGamesEnabled,
  updateSpeed,
  uploads
}: {
  applyAdminLibraryChange: (nextBooks: Book[]) => void;
  audibleManagement: ReactNode;
  audioRef: RefObject<HTMLAudioElement | null>;
  books: Book[];
  capabilities: ServerCapabilities;
  currentUser: AuthUser;
  demoMode: boolean;
  deviceDownloadQueue: DeviceDownloadActivity[];
  deviceImport: { completed: number; total: number; } | null;
  displaySettings: ReturnType<typeof useDisplaySettings>;
  downloadStatus: DeviceNotice | null;
  downloadedBookIds: Set<string>;
  gamesEnabled: boolean;
  ios: boolean;
  isOperaLibre: boolean;
  loadBooks: () => Promise<void>;
  localMode: boolean;
  nativeTab: "settings";
  offlineDownloads: ReturnType<typeof useOfflineDownloads>;
  onConnectServer: () => void;
  onCurrentUserChanged: (user: AuthUser) => void;
  onLogout: () => void | Promise<void>;
  openNativeTab: (tab: NativeTab) => void;
  pausePlayback: (audio: HTMLAudioElement | null | undefined) => void;
  purchases: ReturnType<typeof usePurchases>;
  readalong: ReturnType<typeof useReadalong>;
  readerPreferences: ReturnType<typeof useReaderPreferences>;
  rotationLockAvailable: boolean;
  serverAliasesState: ReturnType<typeof useServerAliases>;
  setBooks: Dispatch<SetStateAction<Book[]>>;
  sharedProgressAvailable: boolean;
  speed: number;
  toggleGamesEnabled: () => void;
  updateSpeed: (value: number) => void;
  uploads: ReturnType<typeof useUploads>;
}) {
  const {
    aliasError,
    aliasName,
    aliasUrl,
    saveAlias,
    serverAliases,
    setAliasName,
    setAliasUrl,
    setServerAliases,
    switchToAlias,
    switchingAliasId
  } = serverAliasesState;
  const {
    allAudibleAccounts,
    brokenLibationAccounts,
    canBrowseLibation,
    libroAccounts,
    libroAvailable,
    libroOnDevice,
    libroRefreshKey,
    setLibroAccounts,
    setLibroDestination
  } = purchases;
  const {
    appearanceMode,
    rotationLockBusy,
    rotationLockEnabled,
    rotationLockError,
    toggleRotationLock,
    updateAppearanceMode
  } = displaySettings;
  const {
    cancelOfflineDownload,
    deleteDeviceBook,
    importFromDevice,
    removeOfflineDownload
  } = offlineDownloads;
  const {
    followAggressiveness,
    followSyncEnabled,
    readalongEnabled,
    toggleFollowSyncEnabled,
    updateFollowAggressiveness
  } = readerPreferences;
  const {
    sentenceFollowAvailable,
    toggleReadalongEnabled
  } = readalong;
  const {
    setUploadModalOpen
  } = uploads;

  return (
    <section className="settings-shell" aria-label="Settings">
      <header className="settings-head">
        <div className="settings-heading">
          <span className="eyebrow"><Settings size={13} /> The Study</span>
          <h1>Settings</h1>
        </div>
        {capabilities.administration ? (
          <button type="button" className="settings-admin-button" onClick={() => openNativeTab("admin")}>
            <UserCog size={18} strokeWidth={1.6} />
            <span>Administration</span>
            <ChevronRight size={15} />
          </button>
        ) : null}
      </header>

      {/* Grouped so a wide screen can set the cards in columns; on a phone the
          wrapper steps aside and they stack in the shell as before. */}
      <div className="settings-cards">
        <div
          className="settings-upper"
          role="region"
          aria-label="Listening and source settings. Scrolls independently."
          tabIndex={0}
        >
        <div className="settings-pane-guide" aria-hidden="true">
          <strong>Listening &amp; sources</strong>
          <span><ArrowDown size={12} /> Scroll this half</span>
        </div>
        <section className="settings-card">
          <span className="section-label"><Gauge size={13} /> Playback</span>
          <div className="settings-field">
            <span className="settings-label">Cadence</span>
            <PlaybackSpeedControl value={speed} onChange={updateSpeed} rotary />
            <p className="settings-hint">Applies to every book and is remembered on this device.</p>
          </div>
        </section>

        {ios || rotationLockAvailable ? <DisplaySettings
          appearanceMode={appearanceMode}
          ios={ios}
          rotationLockAvailable={rotationLockAvailable}
          rotationLockBusy={rotationLockBusy}
          rotationLockEnabled={rotationLockEnabled}
          rotationLockError={rotationLockError}
          toggleRotationLock={toggleRotationLock}
          updateAppearanceMode={updateAppearanceMode}
        /> : null}

        {(libroAvailable || canBrowseLibation) ? <BookStoreSettings
          allAudibleAccounts={allAudibleAccounts}
          applyAdminLibraryChange={applyAdminLibraryChange}
          audibleManagement={audibleManagement}
          brokenLibationAccounts={brokenLibationAccounts}
          canBrowseLibation={canBrowseLibation}
          currentUser={currentUser}
          isOperaLibre={isOperaLibre}
          libroAccounts={libroAccounts}
          libroAvailable={libroAvailable}
          libroOnDevice={libroOnDevice}
          libroRefreshKey={libroRefreshKey}
          localMode={localMode}
          nativeTab={nativeTab}
          setBooks={setBooks}
          setLibroAccounts={setLibroAccounts}
          setLibroDestination={setLibroDestination}
        /> : null}
        </div>
        <div
          className="settings-lower"
          role="region"
          aria-label="Device and account settings. Scrolls independently."
          tabIndex={0}
        >
        <div className="settings-pane-guide" aria-hidden="true">
          <strong>Device &amp; account</strong>
          <span><ArrowDown size={12} /> Scroll this half</span>
        </div>

        <ExtrasSettings
          followAggressiveness={followAggressiveness}
          followSyncEnabled={followSyncEnabled}
          gamesEnabled={gamesEnabled}
          readalongEnabled={readalongEnabled}
          sentenceFollowAvailable={sentenceFollowAvailable}
          toggleFollowSyncEnabled={toggleFollowSyncEnabled}
          toggleGamesEnabled={toggleGamesEnabled}
          toggleReadalongEnabled={toggleReadalongEnabled}
          updateFollowAggressiveness={updateFollowAggressiveness}
        />

        {sharedProgressAvailable ? (
          <ProgressSharingCard
            user={currentUser}
            onUserChanged={onCurrentUserChanged}
            onSharingChanged={() => void loadBooks()}
          />
        ) : null}

        <DeviceLibrarySettings
          deleteDeviceBook={deleteDeviceBook}
          deviceImport={deviceImport}
          downloadStatus={downloadStatus}
          importFromDevice={importFromDevice}
        />

        {!localMode ? <ServerDownloadSettings
          books={books}
          cancelOfflineDownload={cancelOfflineDownload}
          demoMode={demoMode}
          deviceDownloadQueue={deviceDownloadQueue}
          downloadedBookIds={downloadedBookIds}
          removeOfflineDownload={removeOfflineDownload}
        /> : null}

        <ConnectionSettings
          aliasError={aliasError}
          aliasName={aliasName}
          aliasUrl={aliasUrl}
          audioRef={audioRef}
          capabilities={capabilities}
          currentUser={currentUser}
          demoMode={demoMode}
          isOperaLibre={isOperaLibre}
          localMode={localMode}
          onConnectServer={onConnectServer}
          onLogout={onLogout}
          pausePlayback={pausePlayback}
          saveAlias={saveAlias}
          serverAliases={serverAliases}
          setAliasName={setAliasName}
          setAliasUrl={setAliasUrl}
          setServerAliases={setServerAliases}
          setUploadModalOpen={setUploadModalOpen}
          switchToAlias={switchToAlias}
          switchingAliasId={switchingAliasId}
        />
        </div>
      </div>
    </section>
  );
}
