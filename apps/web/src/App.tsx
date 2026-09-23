import { hasPlaybackSource } from "./nativeAudioStartup";
import { useDeviceFold, usesFoldLayout } from "./deviceFold";
import { refreshPurchaseSources } from "./purchaseRefresh";
import { createPlaybackTransitions, playbackReportPosition } from "./playbackReporting";
import {
  ownsPendingPlay,
  playbackEventOwnsPendingPlay,
  playbackIntentBelongsToBook
} from "./playbackPending";
import { serverCapabilities } from "./serverCapabilities";
import { Capacitor } from "@capacitor/core";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bell,
  BookOpen,
  Bookmark,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Cloud,
  CloudDownload,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Gamepad2,
  Gauge,
  Headphones,
  Images,
  KeyRound,
  LoaderCircle,
  LayoutGrid,
  Library,
  List,
  ListMusic,
  LocateFixed,
  LogOut,
  Maximize2,
  Minimize2,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Pencil,
  Play,
  RefreshCcw,
  RotateCcw,
  RotateCw,
  Rows3,
  Search,
  Settings,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Upload,
  ScrollText,
  UserCog,
  Users,
  Volume2,
  X
} from "lucide-react";
import {
  READ_ALONG_MODE_LABELS,
  companionKindLabel,
  describeCompanion
} from "./readalong";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  adoptableServerProgress,
  endedShortOfTrack,
  freshestProgress,
  isSuspectProgressReset,
  PROGRESS_RESET_GUARD_SECONDS,
  progressAfterSave,
  progressFromBookSummary,
  progressTimestamp,
  readProgressCheckpoint,
  resolveActivePlaybackBookId,
  resolveBookId,
  resolveProgressLocation,
  saveWasOverruled,
  shouldFlagIntentionalRegression,
  shouldResumeSavedPosition,
  summarizeBookProgress,
  writeProgressCheckpoint
} from "./reliability";
import {
  normalizePlaybackSpeed
} from "./playbackSpeed";
import {
  formatSleepTimerMinutes,
  SLEEP_TIMER_MAX_MINUTES,
  SLEEP_TIMER_MIN_MINUTES
} from "./sleepTimer";
import {
  BOOK_GAIN_DEFAULT,
  bookGainFromDb,
  createBookGainSync,
  mergeServerBookGains
} from "./bookVolume";
import {
  SHELF_VIEW_MODE_OPTIONS
} from "./shelfView";
import {
  SHELF_STATUS_OPTIONS,
  shelfDownloadScanKey,
  toggleShelfFacet
} from "./shelfFilters";
import { PlaybackGainChain, streamCanBeBoosted } from "./playbackGain";
import { isLibationAdding } from "./libationState";
import { displayBookDescription, enrichBooksFromLibation, tagsForBook } from "./bookMetadata";
import { buildChapterSegments, chapterAtBookPosition } from "./chapters";
import {
  bookDownloadUrl,
  clearServerUrl,
  getAuthStatus,
  getBooks,
  getLibationBooks,
  getMe,
  getFreshProgress,
  getProgress,
  getServerStorageKey,
  getServerType,
  getStoredMediaToken,
  getStoredToken,
  hasUserConfiguredServer,
  SERVER_SETUP_GUIDE_URL,
  isNetworkError,
  isServerNotReadyError,
  isLocalMode,
  enterLocalMode,
  exitLocalMode,
  logout as apiLogout,
  mediaUrl,
  reconnectUsingServerAliases,
  playbackReportingSession,
  rescanLibrary,
  refreshLibroAccount,
  saveProgress,
  setBookCompletion,
  setBookVolume,
  setStoredMediaToken,
  setStoredToken,
  setUnauthorizedHandler
} from "./api";
import {
  cacheLibrary,
  cacheOfflineUser,
  cacheProgress,
  cancelBookOfflineDownload,
  downloadBookForOffline,
  forgetOfflineUser,
  getBookBackgroundDownloadStatus,
  getCachedLibrary,
  getCachedProgress,
  getOfflineCoverUrl,
  getOfflineTrackUrl,
  getOfflineUser,
  isBookDownloaded,
  loadEpubSource,
  loadCompanionBytes,
  getCachedEpubBytes,
  releaseOfflineMediaUrl,
  removeBookDownload,
  warnCacheFailure
} from "./offline";
import { haptic } from "./native";
import { isLeftEdgeBackSwipe } from "./nativeNavigation";
import { nativeShellColor, nativeTabItems, nativeTabSelection, type NativeTab } from "./nativeTabs";
import { useNativeTabs } from "./useNativeTabs";
import {
  isIPadNavigator,
  isRotationLockAvailable
} from "./rotationLock";
import {
  attachNativeAudioPlayer,
  getNativeAudioRecovery,
  pauseNativeAudio,
  playNativeAudio,
  releaseNativeAudioSession,
  seekNativeAudio,
  setNativeAudioGain,
  updateNativeAudioNowPlaying,
  usesNativeAudioPlayer,
  type NativeAudioQueueTrack
} from "./nativeAudio";
import { NativeForegroundSyncGate } from "./nativeAudioState";
import { createForegroundProgressSync } from "./foregroundProgressSync";
import {
  clearCarLibrary,
  carPlaybackOwnsEngine,
  setCarPlaybackOwner
} from "./carPlay";
import { DEMO_USER, enterDemoMode, exitDemoMode, isDemoMode } from "./demo";
import {
  canResolveStartupNavigation,
  canRestoreCachedNativeSession,
  NATIVE_STARTUP_SETTLE_MS,
  shouldAcceptNativeTrackChange,
  shouldRefreshMediaCredential
} from "./startup";
import {
  canPublishNativeQueue,
  nativeQueueEntryUrl,
  nativeQueueIdentityAfterRestore,
  nativeQueueIsReady,
  nativeQueueRefreshShouldResume,
  playbackRestoreBookAfterAction,
  resolveLocalFirstSources
} from "./offlinePlayback";
import {
  backfillDeviceLibraryMetadata,
  DEVICE_USER,
  getDeviceBooks,
  getDeviceProgress,
  importAudiobookFromDevice,
  mergeDeviceAndServerBooks,
  migrateDeviceLibraryFileExtensions,
  removeDeviceBook,
  saveDeviceProgress,
  setDeviceBookCompletion
} from "./localLibrary";
import { AuthGate, ServerSetup } from "./Auth";
import { AdminPanel } from "./Admin";
import { LibroCatalog } from "./LibroCatalog";
import { refreshLibroDevice } from "./libroDevice";
import { ProfilePage } from "./Profile";
import { ProgressSharingCard } from "./ProgressSharing";
import {
  finishAnnouncement,
  finishedAgoLabel
} from "./finishFeed";
import { GamesPage, type GameName } from "./GameRoom";
import { readGamesEnabled, writeGamesEnabled } from "./gamePreferences";
import {
  FOLLOW_AGGRESSIVENESS_LABELS,
  FOLLOW_AGGRESSIVENESS_LEAD_SECONDS,
  type FollowAggressiveness
} from "./readalongPreferences";
import { readerStatusLabel } from "./sharedProgress";
import type {
  AuthUser,
  Book,
  Chapter,
  Progress,
  Track
} from "./types";
import {
  nativeAudioRecoveryScope,
  readStoredBookGains,
  readStoredBookId,
  readStoredSpeed,
  readStoredValue,
  unsyncedBookGainStore,
  withoutCachedBookGains,
  writeStoredBookGains,
  writeStoredBookId,
  writeStoredSpeed,
  writeStoredValue
} from "./appStorage";
import {
  isSortModeSupported,
  type LibrarySource,
  SORT_OPTIONS,
  type SortMode
} from "./shelfSort";
import {
  currentTrackIndex,
  durationFromTracks,
  errorMessage,
  formatDurationLabel,
  formatElapsed,
  formatMinutes,
  formatTime,
  trackOffsetSeconds
} from "./formatting";
import {
  isPendingJob,
  jobDetailLines,
  jobStateLabel,
  jobSummary,
  jobTitle
} from "./jobLabels";
import { PULL_REFRESH_THRESHOLD, usePullToRefresh } from "./usePullToRefresh";
import { EpubReadalong } from "./EpubReadalong";
import { ShelfBookList, ShelfFacetGroup } from "./ShelfBookList";
import { CoverArt, DownloadRing, LibationCoverArt } from "./CoverArt";
import { BookVolumeControl, PlaybackSpeedControl, ScrubSlider } from "./PlaybackControls";
import {
  BookDetailsSheet,
  ChapterSheet,
  SleepTimerSheet,
  SpeedSheet,
  type NativePlayerSheet
} from "./PlayerSheets";
import { AudiobookUploadDialog, EbookUploadDialog } from "./UploadDialogs";
import { MetadataEditorDialog } from "./MetadataEditorDialog";
import { SyncConfirmationDialog, UnplayedConfirmationDialog, type DeviceNotice } from "./ConfirmDialogs";
import {
  BookStoreSettings,
  ConnectionSettings,
  DeviceLibrarySettings,
  DisplaySettings,
  ExtrasSettings,
  ServerDownloadSettings,
  type DeviceDownloadActivity
} from "./SettingsCards";
import { useServerAliases } from "./useServerAliases";
import { useFinishFeed } from "./useFinishFeed";
import { useDisplaySettings } from "./useDisplaySettings";
import { useReaderPreferences } from "./useReaderPreferences";
import { useUploads } from "./useUploads";
import { useMetadataEditor } from "./useMetadataEditor";
import { useSleepTimer } from "./useSleepTimer";
import { useShelf } from "./useShelf";
import { usePurchases } from "./usePurchases";
import { useCarPlay } from "./useCarPlay";
import type { PendingSeek, QueuedProgressSave } from "./playbackTypes";
import { GALLERY_COMPANION_ID, useReadalong } from "./useReadalong";

const PROGRESS_SAVE_INTERVAL_MS = 2_000;


function audioSourceMatches(audio: HTMLAudioElement, source: string) {
  if (!source) return false;
  try {
    return audio.currentSrc === new URL(source, document.baseURI).href;
  } catch {
    return audio.currentSrc === source;
  }
}

// Beyond this the segments are too thin to read or tap, and their fixed
// borders/gaps overflow a phone screen; fall back to one continuous bar.
const MAX_CHAPTER_SEGMENTS = 32;

// The API client's own timeout is generous (30 s); a startup-critical read
// that is allowed to fall back to a local copy should not wait that long.
// Before "Begin this reading" trusts a stale listing summary, the server gets
// this long to say whether the book is actually well under way elsewhere.
const START_OVER_PROGRESS_CHECK_MS = 2_500;
// The restore effect's own /progress reads; local copies cover the wait.
const RESTORE_PROGRESS_TIMEOUT_MS = 8_000;
// How long a Play still waiting on the stream shows as loading.
const PLAY_PENDING_LIMIT_MS = 45_000;

/** Which pages of the iPad Shelf spread are showing. */

/** Formats the browser can show inline; anything else gets an "Open" link. */
function canPreviewCompanion(extension: string) {
  const lower = extension.toLowerCase();
  return lower === "epub" || lower === "pdf" || lower === "txt" || lower === "html" || lower === "htm";
}


type AuthState =
  | { phase: "loading" }
  | { phase: "server"; returnToLocal?: boolean }
  | { phase: "setup"; setupTokenRequired: boolean; setupLocalOnly: boolean }
  | { phase: "login" }
  | { phase: "ready"; user: AuthUser };

function initialAuthState(): AuthState {
  if (isDemoMode()) return { phase: "ready", user: DEMO_USER };
  if (isLocalMode()) return { phase: "ready", user: DEVICE_USER };
  if (!hasUserConfiguredServer()) {
    // A phone with no server configured opens straight into the on-device
    // library rather than gating on server setup: someone who installs the
    // app before their server exists can still listen, and connecting stays
    // one tap away on the shelf and in settings. The mode must be persisted
    // before MainApp renders because it reads isLocalMode() directly.
    if (Capacitor.isNativePlatform()) {
      enterLocalMode();
      return { phase: "ready", user: DEVICE_USER };
    }
    return { phase: "server" };
  }

  // A native launch should not sit behind a network timeout. This is the same
  // cached identity used for offline mode; checkAuth validates it in the
  // background and still returns to login if the server rejects the session.
  // Downloaded media needs neither remote artwork nor the query-safe media
  // credential. Older installs that have the full session token and cached
  // identity must therefore open immediately too; checkAuth fills the newer
  // media token in the background when the server is reachable.
  const offlineUser = Capacitor.isNativePlatform() ? getOfflineUser() : null;
  const cachedUser = canRestoreCachedNativeSession(
    Capacitor.isNativePlatform(),
    getStoredToken(),
    !!offlineUser
  ) ? offlineUser : null;
  return cachedUser
    ? { phase: "ready", user: cachedUser }
    : { phase: "loading" };
}

function NativeLaunchPlaceholder() {
  return (
    <div className="native-launch-placeholder" role="status" aria-label="Opening OperaLibre">
      <span>OperaLibre</span>
    </div>
  );
}

export default function App() {
  const [authState, setAuthState] = useState<AuthState>(initialAuthState);

  const checkAuth = useCallback(async () => {
    if (isDemoMode()) {
      setAuthState({ phase: "ready", user: DEMO_USER });
      return;
    }
    if (isLocalMode()) {
      setAuthState({ phase: "ready", user: DEVICE_USER });
      return;
    }
    if (!hasUserConfiguredServer()) {
      if (Capacitor.isNativePlatform()) {
        enterLocalMode();
        setAuthState({ phase: "ready", user: DEVICE_USER });
        return;
      }
      setAuthState({ phase: "server" });
      return;
    }
    try {
      const status = await getAuthStatus();
      if (status.setupRequired) {
        await clearCarLibrary();
        setStoredToken(null);
        setAuthState({
          phase: "setup",
          setupTokenRequired: status.setupTokenRequired ?? false,
          setupLocalOnly: status.setupLocalOnly ?? false
        });
        return;
      }
      if (status.user) {
        // Servers released before the narrower media credential return no
        // mediaToken and still expect the session token on media URLs.
        setStoredMediaToken(status.mediaToken ?? getStoredToken());
        cacheOfflineUser(status.user);
        setAuthState({ phase: "ready", user: status.user });
        return;
      }
      const token = getStoredToken();
      if (!token) {
        await clearCarLibrary();
        setAuthState({ phase: "login" });
        return;
      }
      try {
        const user = await getMe();
        cacheOfflineUser(user);
        setAuthState({ phase: "ready", user });
      } catch (error) {
        // Keep the token when the server is simply unreachable; only a real
        // rejection should end the session.
        if (isNetworkError(error)) {
          if (await reconnectUsingServerAliases()) {
            await checkAuth();
            return;
          }
          const offlineUser = getOfflineUser();
          setAuthState(offlineUser ? { phase: "ready", user: offlineUser } : { phase: "login" });
          return;
        }
        await clearCarLibrary();
        setStoredToken(null);
        setAuthState({ phase: "login" });
      }
    } catch (error) {
      if (isNetworkError(error) && await reconnectUsingServerAliases()) {
        await checkAuth();
        return;
      }
      const offlineUser = getOfflineUser();
      setAuthState(offlineUser ? { phase: "ready", user: offlineUser } : { phase: "login" });
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void clearCarLibrary().catch(console.error);
      setStoredToken(null);
      setAuthState({ phase: "login" });
    });
    void checkAuth();
    return () => setUnauthorizedHandler(null);
  }, [checkAuth]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const refreshMediaCredential = () => {
      if (!shouldRefreshMediaCredential(
        Capacitor.isNativePlatform(),
        getStoredToken(),
        getStoredMediaToken(),
        hasUserConfiguredServer(),
        isLocalMode(),
        isDemoMode()
      )) return;
      void checkAuth();
    };
    const refreshMediaCredentialOnForeground = () => {
      if (!document.hidden && navigator.onLine) refreshMediaCredential();
    };
    window.addEventListener("online", refreshMediaCredential);
    document.addEventListener("visibilitychange", refreshMediaCredentialOnForeground);
    return () => {
      window.removeEventListener("online", refreshMediaCredential);
      document.removeEventListener("visibilitychange", refreshMediaCredentialOnForeground);
    };
  }, [checkAuth]);

  const handleCurrentUserChanged = useCallback((user: AuthUser) => {
    cacheOfflineUser(user);
    setAuthState({ phase: "ready", user });
  }, []);

  if (authState.phase === "loading") {
    if (Capacitor.isNativePlatform()) return <NativeLaunchPlaceholder />;
    return (
      <main className="auth-shell startup-shell">
        <div className="startup-loader" role="status" aria-live="polite" aria-label="Opening OperaLibre">
          <div className="startup-mark" aria-hidden="true">
            <span className="startup-book startup-book-left"><i /></span>
            <span className="startup-book startup-book-center"><i /></span>
            <span className="startup-book startup-book-right"><i /></span>
            <span className="startup-sweep" />
          </div>
          <div className="startup-title" aria-hidden="true">
            <span>Opera</span><em>Libre</em>
          </div>
          <span className="startup-caption">Opening the library</span>
          <span className="startup-progress" aria-hidden="true"><i /></span>
        </div>
      </main>
    );
  }

  if (authState.phase === "server") {
    return (
      <ServerSetup
        onConnected={() => {
          setAuthState({ phase: "loading" });
          void checkAuth();
        }}
        onDemo={() => {
          enterDemoMode();
          setAuthState({ phase: "ready", user: DEMO_USER });
        }}
        onLocal={Capacitor.isNativePlatform() ? () => {
          enterLocalMode();
          setAuthState({ phase: "ready", user: DEVICE_USER });
        } : undefined}
        onCancel={authState.returnToLocal ? () => {
          enterLocalMode();
          setAuthState({ phase: "ready", user: DEVICE_USER });
        } : undefined}
      />
    );
  }

  if (authState.phase === "setup" || authState.phase === "login") {
    return (
      <AuthGate
        mode={authState.phase}
        setupTokenRequired={authState.phase === "setup" ? authState.setupTokenRequired : false}
        setupLocalOnly={authState.phase === "setup" ? authState.setupLocalOnly : false}
        onAuthenticated={(response) => {
          setStoredToken(response.token);
          setStoredMediaToken(response.mediaToken ?? response.token);
          cacheOfflineUser(response.user);
          setAuthState({ phase: "ready", user: response.user });
        }}
        onChangeServer={async () => {
          await clearCarLibrary();
          setStoredToken(null);
          clearServerUrl();
          setAuthState({ phase: "server" });
        }}
      />
    );
  }

  return (
    <MainApp
      currentUser={authState.user}
      onCurrentUserChanged={handleCurrentUserChanged}
      onConnectServer={async () => {
        await clearCarLibrary();
        exitLocalMode();
        setAuthState({ phase: "server", returnToLocal: true });
      }}
      onLogout={async () => {
        await clearCarLibrary();
        if (isLocalMode()) {
          exitLocalMode();
          setAuthState({ phase: "server" });
          return;
        }
        const leavingDemo = isDemoMode();
        try {
          await apiLogout();
        } catch {
          // ignore
        }
        setStoredToken(null);
        // Otherwise checkAuth's offline fallback signs the account straight
        // back in the next time the server cannot be reached.
        forgetOfflineUser();
        if (leavingDemo) {
          exitDemoMode();
          setAuthState({ phase: "server" });
        } else {
          setAuthState({ phase: "login" });
        }
      }}
    />
  );
}


/**
 * Remembers that the reader waved off the shelf's connect-a-server card. Kept
 * separate from the server keys in api.ts: it describes the pitch, not the
 * connection, and must survive entering and leaving local mode.
 */
const CONNECT_PROMPT_DISMISSED_KEY = "operalibre.connectPromptDismissed";

function MainApp({
  currentUser,
  onCurrentUserChanged,
  onLogout,
  onConnectServer
}: {
  currentUser: AuthUser;
  onCurrentUserChanged: (user: AuthUser) => void;
  onLogout: () => void | Promise<void>;
  onConnectServer: () => void;
}) {
  const isOperaLibre = getServerType() === "operalibre";
  const demoMode = isDemoMode();
  const localMode = isLocalMode();
  const capabilities = serverCapabilities(getServerType(), currentUser, { local: localMode, demo: demoMode });
  const native = Capacitor.isNativePlatform();
  const ios = native && document.documentElement.classList.contains("platform-ios");
  const ipad = ios && isIPadNavigator(window.navigator);
  // Shared reading is an OperaLibre-server feature: Jellyfin keeps its own user
  // data, and demo/local libraries have no other listeners to compare against.
  const sharedProgressAvailable = capabilities.sharedActivity;
  const rotationLockAvailable = isRotationLockAvailable();
  const [nativeTab, setNativeTab] = useState<NativeTab>("shelf");
  const playbackFold = useDeviceFold();
  const [gamesEnabled, setGamesEnabled] = useState(readGamesEnabled);
  const {
    followAggressiveness,
    followSyncEnabled,
    readalongEnabled,
    setReadalongEnabled,
    toggleFollowSyncEnabled,
    updateFollowAggressiveness
  } = useReaderPreferences();
  const {
    appearanceMode,
    rotationLockBusy,
    rotationLockEnabled,
    rotationLockError,
    toggleRotationLock,
    updateAppearanceMode
  } = useDisplaySettings({
    ios
  });
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
  } = useServerAliases();
  const [connectPromptDismissed, setConnectPromptDismissed] = useState(
    () => readStoredValue(CONNECT_PROMPT_DISMISSED_KEY) === "true"
  );

  useEffect(() => {
    if (!isOperaLibre || demoMode || localMode) {
      return;
    }
    let cancelled = false;
    const refreshCurrentUser = () => {
      void getMe()
        .then((user) => {
          if (!cancelled) onCurrentUserChanged(user);
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(refreshCurrentUser, 30_000);
    window.addEventListener("focus", refreshCurrentUser);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshCurrentUser);
    };
  }, [demoMode, isOperaLibre, localMode, onCurrentUserChanged]);
  const {
    finishFeed,
    finishFeedAvailable,
    finishFeedOpen,
    setFinishFeedOpen,
    toggleFinishFeed
  } = useFinishFeed({
    capabilities,
    currentUser
  });
  const [nativePlayerView, setNativePlayerView] = useState<"now" | "details" | "chapters">("now");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const miniPlayerRef = useRef<HTMLElement | null>(null);
  const playerPaneRef = useRef<HTMLElement | null>(null);
  const bookDetailsSwipeStartRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const saveStartedAt = useRef(0);
  const playWhenTrackLoads = useRef(false);
  const progressSaveDrainPromiseRef = useRef<Promise<void> | null>(null);
  const progressSaveAbortController = useRef<AbortController | null>(null);
  const queuedProgressSaves = useRef<Map<string, QueuedProgressSave>>(new Map());
  const progressMutationVersion = useRef(0);
  // Unlike playbackTouchedRef, this advances only for an actual listener
  // action. Shelf Resume starts playback optimistically while reconciliation
  // is still running, and that automatic start must not make a fresher server
  // reply look stale.
  const playbackActionVersionRef = useRef(0);
  const restoredProgressBookId = useRef<string | null>(null);
  // Tearing a session down (completion, reset) is not a progress mutation and
  // not a listener action, so neither version above moves. Foreground adoption
  // still has to notice: a continuation that lands after the session was
  // cleared would restore the position it just discarded.
  const playbackSessionVersion = useRef(0);
  // Whether the listener moved playback (play, seek, track change) since the
  // current book was restored. Until then no progress is persisted anywhere:
  // re-stamping the restored — or failed-to-restore — position with a fresh
  // timestamp is exactly how an idle device erases real progress recorded on
  // another one.
  const playbackTouchedRef = useRef(false);
  // Deliberate seeks are numbered per book and acknowledged only after the
  // corresponding server checkpoint succeeds. This keeps an offline seek
  // intentional without permanently disabling reset protection afterward.
  const intentionalSeekGenerationRef = useRef<Map<string, number>>(new Map());
  const acknowledgedSeekGenerationRef = useRef<Map<string, number>>(new Map());
  // The whole-book position each book's latest deliberate seek aimed at, and
  // the position the server last acknowledged for it. Together they decide
  // whether a seek needs the server's reset guard lifted — a forward tap must
  // not hand that authority to whatever stale clock gets persisted next.
  const intentionalSeekTargetRef = useRef<Map<string, number>>(new Map());
  const acknowledgedServerPositionRef = useRef<Map<string, number>>(new Map());
  // Set by startPlayback for an automatic Shelf-Resume start, consumed by the
  // element's `play` event. That event cannot tell an automatic start from a
  // listener's tap, and treating the automatic one as a listener action bumped
  // playbackActionVersionRef — after which the restore effect dropped the
  // /progress reply whenever it landed after loadedmetadata, and the stale
  // optimistic position kept playing.
  const autoResumePlayEventPendingRef = useRef(false);
  const explicitSessionStartBookIdRef = useRef<string | null>(null);
  // A shelf Resume is a request to play the *restored* position. Autoplay is
  // therefore armed by the restore effect rather than by the click, so it can
  // never start the placeholder first track while the real one resolves.
  const resumeAutoplayBookIdRef = useRef<string | null>(null);
  const resumeAutoplayPendingRef = useRef(false);
  const resumeReconciliationBookIdRef = useRef<string | null>(null);
  const foregroundAdoptInFlightRef = useRef(false);
  // Per book, a save the server overruled while the player still sits on it:
  // its healed checkpoint already matches the server, so adoption measures
  // against this instead. Any newer local checkpoint supersedes it.
  const overruledSaveRef = useRef(new Map<string, Progress>());
  const initialLibraryHydrated = useRef(false);
  const startupNavigationResolved = useRef(false);
  // Timer and native-event callbacks run after later renders may have landed;
  // they call the latest version of these functions rather than the one from
  // the render that registered them (a stale persistProgress would save an
  // outdated finished override, for one).
  const startPlaybackRef = useRef(startPlayback);
  startPlaybackRef.current = startPlayback;
  const persistProgressRef = useRef(persistProgress);
  persistProgressRef.current = persistProgress;
  const markPlaybackTouchedRef = useRef(markPlaybackTouched);
  markPlaybackTouchedRef.current = markPlaybackTouched;
  const pausePlaybackRef = useRef(pausePlayback);
  pausePlaybackRef.current = pausePlayback;

  // Authentication can be restored synchronously, but the native destination
  // and playback position depend on cached state. Keep the launch surface
  // visible until both are coherent so neither the default Shelf nor the
  // first track at 0:00 flashes on the way to a restored session.
  const [startupViewReady, setStartupViewReady] = useState(!native);
  const startupViewReadyRef = useRef(!native);
  const startupProgressAppliedRef = useRef(false);
  const startupRevealTimerRef = useRef<number | null>(null);
  const scheduleStartupReveal = useCallback(() => {
    if (!native || startupViewReadyRef.current) return;
    if (startupRevealTimerRef.current !== null) {
      window.clearTimeout(startupRevealTimerRef.current);
    }
    // Progress can arrive from the library summary, IndexedDB, AVPlayer, and
    // the server within a few frames. Reveal only after that burst goes quiet.
    startupRevealTimerRef.current = window.setTimeout(() => {
      startupRevealTimerRef.current = null;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        startupViewReadyRef.current = true;
        setStartupViewReady(true);
      }));
    }, NATIVE_STARTUP_SETTLE_MS);
  }, [native]);
  useEffect(() => () => {
    if (startupRevealTimerRef.current !== null) {
      window.clearTimeout(startupRevealTimerRef.current);
    }
  }, []);
  const [books, setBooks] = useState<Book[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(() =>
    readStoredBookId(currentUser.id, "selectedBookId")
  );
  const [playbackBookId, setPlaybackBookId] = useState<string | null>(() =>
    readStoredBookId(currentUser.id, "playbackBookId")
  );
  // Queue construction must wait for the async local/native recovery pass.
  // Otherwise a downloaded first track can reach AVPlayer before the saved
  // chapter does and become the apparent cold-start resume position.
  const [restoredPlaybackBookId, setRestoredPlaybackBookId] = useState<string | null>(null);
  const playbackBookIdRef = useRef(playbackBookId);
  playbackBookIdRef.current = playbackBookId;
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [pendingSeek, setPendingSeekState] = useState<PendingSeek | null>(null);
  // Mirrored in a ref so persistProgress (called from pagehide/visibility
  // listeners holding stale closures) always sees the live value.
  const pendingSeekRef = useRef<PendingSeek | null>(null);
  const setPendingSeek = (value: PendingSeek | null) => {
    pendingSeekRef.current = value;
    setPendingSeekState(value);
  };
  const [position, setPosition] = useState(0);
  const [scrubPreview, setScrubPreview] = useState<number | null>(null);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  // Play was asked for but no audio is coming out yet — a streamed book can
  // take seconds to buffer. The buttons show it so a tap never looks ignored,
  // and a second tap cancels instead of queueing another start.
  const [playPending, setPlayPendingState] = useState(false);
  const playPendingRef = useRef(false);
  const playPendingBookIdRef = useRef<string | null>(null);
  const playPendingTimerRef = useRef<number | null>(null);
  // Bumped when a waiting Play is taken back, so a restore still running for
  // a shelf Resume does not start the book the listener just cancelled.
  const playCancelGenerationRef = useRef(0);
  const setPlayPending = (pending: boolean, bookId = playbackBookIdRef.current) => {
    if (playPendingTimerRef.current !== null) {
      window.clearTimeout(playPendingTimerRef.current);
      playPendingTimerRef.current = null;
    }
    // A start that never arrives must not leave the ring spinning for good.
    if (pending) {
      playPendingTimerRef.current = window.setTimeout(
        () => cancelPendingPlayback(audioRef.current),
        PLAY_PENDING_LIMIT_MS
      );
    }
    playPendingRef.current = pending;
    playPendingBookIdRef.current = pending ? bookId : null;
    setPlayPendingState(pending);
  };
  const nativePlaybackPlayingRef = useRef(false);
  const [speed, setSpeed] = useState(readStoredSpeed);
  const [volume, setVolume] = useState(0.9);
  const playbackSettingsRef = useRef({ rate: speed, volume });
  playbackSettingsRef.current = { rate: speed, volume };
  // Per-book gain, keyed by book id. The server holds the copy that follows the
  // listener between devices; this is the local mirror that survives an offline
  // launch and covers backends that have no place to store it.
  const [bookGains, setBookGains] = useState<Record<string, number>>(() =>
    readStoredBookGains(currentUser.id)
  );
  // What this device last wrote for a book, until the server echoes it back.
  // A library payload can be older than the adjustment that raced it — a
  // getBooks() already in flight, or a cached shelf served during a network
  // blip — and the merge below would otherwise undo the listener's change.
  const localGainWritesRef = useRef<Map<string, number>>(new Map());
  // Serializes and coalesces the writes behind the gain slider, which reports
  // every step of a drag, and owns the release of the guard above.
  const gainSyncRef = useRef<ReturnType<typeof createBookGainSync> | null>(null);
  if (!gainSyncRef.current) {
    gainSyncRef.current = createBookGainSync(
      setBookVolume,
      localGainWritesRef.current,
      unsyncedBookGainStore(currentUser.id)
    );
  }
  // Read by the native player at load time, which happens before the effect
  // that pushes the gain across.
  const playbackGainRef = useRef(BOOK_GAIN_DEFAULT);
  const gainChainRef = useRef<PlaybackGainChain | null>(null);
  const [nativePlayerSheet, setNativePlayerSheet] = useState<NativePlayerSheet>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Serving the cached library because the server is unreachable; books
  // without a local download can't actually play in this state.
  const [isOffline, setIsOffline] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [librarySource, setLibrarySource] = useState<LibrarySource>("local");
  const lastPurchaseSource = useRef<"audible" | "libro" | "all">("all");
  useEffect(() => {
    if (librarySource !== "local") lastPurchaseSource.current = librarySource;
  }, [librarySource]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const {
    chooseEbookUpload,
    chooseUploadFiles,
    ebookUploadBook,
    ebookUploadBusy,
    ebookUploadError,
    ebookUploadFile,
    setEbookUploadBook,
    setEbookUploadError,
    setEbookUploadFile,
    setUploadBookName,
    setUploadError,
    setUploadModalOpen,
    submitAudiobookUpload,
    submitEbookUpload,
    uploadBookName,
    uploadBusy,
    uploadError,
    uploadFiles,
    uploadModalOpen
  } = useUploads({
    books,
    reconcileServerBookGains,
    setBooks,
    setError,
    setIsOffline,
    setLibrarySource,
    setSelectedBookId
  });
  const [profileOpen, setProfileOpen] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [showChapterJumpTop, setShowChapterJumpTop] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  // null while the disk lookup for the current track is in flight; url null
  // means the track is not downloaded and should stream.
  const [offlineSource, setOfflineSource] = useState<{ trackId: string; url: string | null } | null>(null);
  const [mediaArtworkUrl, setMediaArtworkUrl] = useState<string | null>(null);
  const chaptersListRef = useRef<HTMLDivElement | null>(null);
  const trackListSectionRef = useRef<HTMLElement | null>(null);
  const wantsAutoplayRef = useRef(false);
  const [nativeAudioFailed, setNativeAudioFailed] = useState(false);
  const nativeAudio = usesNativeAudioPlayer() && !nativeAudioFailed;
  const {
    configureSleepTimer,
    setSleepCustomDraft,
    setSleepCustomOpen,
    setSleepMinutes,
    setSleepRemaining,
    sleepChoices,
    sleepCustomDraft,
    sleepCustomMinutes,
    sleepCustomOpen,
    sleepDeadlineRef,
    sleepMinutes,
    sleepRemaining,
    sleepRemainingRef,
    startCustomSleepTimer
  } = useSleepTimer({
    audioRef,
    isPlaying,
    nativeAudio,
    pausePlaybackRef,
    setNativePlayerSheet,
    setPlaybackError
  });
  // For long-lived callbacks that must see a fallback to web audio without
  // being recreated by it (recreating loadBooks would reload the library).
  const nativeAudioRef = useRef(nativeAudio);
  nativeAudioRef.current = nativeAudio;
  const nativeAudioQueueRef = useRef<NativeAudioQueueTrack[]>([]);
  const [nativeAudioQueueReadyKey, setNativeAudioQueueReadyKey] = useState<string | null>(null);
  // Native AVPlayer sends its definitive clock only after foregrounding. Keep
  // the server-adoption path behind that handoff, otherwise an older server
  // revision can replace a lock-screen rewind before its native event reaches
  // the resumed WebView.
  const nativeForegroundSyncGateRef = useRef(new NativeForegroundSyncGate());
  const foregroundProgressSyncRef = useRef<ReturnType<typeof createForegroundProgressSync> | null>(null);
  const foregroundProgressActionsRef = useRef({
    nativeAudio, persistProgress, adoptNewerServerProgress, refreshClock: showMediaClock
  });
  foregroundProgressActionsRef.current = {
    nativeAudio, persistProgress, adoptNewerServerProgress, refreshClock: showMediaClock
  };
  const libraryRequestGenerationRef = useRef(0);
  // A listing refused while the server's startup scan runs is asked for
  // again after its Retry-After; the timer and the latest loader live in
  // refs so a scheduled retry always runs the current one and a fresh load
  // (mount, refresh, sign-in) cancels whatever was pending.
  const libraryRetryTimerRef = useRef<number | null>(null);
  const loadBooksRef = useRef<() => Promise<void>>(async () => undefined);
  // Set once native playback has attached, so the effect that sees the
  // player closed can tell that from the app's first render.
  const nativeAudioAttachedRef = useRef(false);
  const downloadAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const [downloadedBookIds, setDownloadedBookIds] = useState<Set<string>>(new Set());
  const {
    activeShelfFilterChips,
    activeShelfFilterCount,
    changeShelfLayout,
    clearShelfFilters,
    closeShelfFilters,
    filterToggleRef,
    filtersOpen,
    purchaseViewMode,
    reverseSort,
    searchQuery,
    selectPurchaseViewMode,
    selectSortMode,
    selectViewMode,
    setFiltersOpen,
    setSearchQuery,
    setShelfFilters,
    shelfFacets,
    shelfFilters,
    shelfFolded,
    shelfLandscape,
    shelfLayout,
    shelfSearchRef,
    showShelfFilters,
    sortMode,
    sortOrderLabel,
    sortReversed,
    viewMode,
    visibleBookColumns,
    visibleBooks
  } = useShelf({
    books,
    demoMode,
    downloadedBookIds,
    ipad,
    librarySource,
    localMode,
    native,
    playbackFold
  });
  const [downloadStatus, setDownloadStatus] = useState<DeviceNotice | null>(null);
  const [completionPendingBookId, setCompletionPendingBookId] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<DeviceNotice | null>(null);
  const [unplayedConfirmationBookId, setUnplayedConfirmationBookId] = useState<string | null>(null);
  const [syncConfirmationBook, setSyncConfirmationBook] = useState<Book | null>(null);
  // Native jobs are persisted and serialized by iOS; this map only mirrors
  // their current queue/progress for the UI.
  const [activeDownloads, setActiveDownloads] = useState<Record<string, DeviceDownloadActivity>>({});
  const activeDownloadIdsRef = useRef<Set<string>>(new Set());
  const [deviceImport, setDeviceImport] = useState<{ completed: number; total: number } | null>(null);
  const [activeGame, setActiveGame] = useState<GameName>("match");

  // The memoized shelf needs a select handler with one identity for the
  // component's lifetime that still reaches the latest selectBook.
  const selectFromShelfRef = useRef<(book: Book) => void>(() => undefined);
  selectFromShelfRef.current = (book) => {
    withWebViewTransition(() => {
      selectBook(book);
      setLibraryOpen(false);
    });
  };
  const selectFromShelf = useCallback((book: Book) => selectFromShelfRef.current(book), []);

  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedBookId) ?? books[0] ?? null,
    [books, selectedBookId]
  );
  const {
    metadataEditOpen,
    metadataError,
    metadataForm,
    metadataSaving,
    openMetadataEditor,
    saveMetadata,
    setMetadataEditOpen,
    setMetadataError,
    setMetadataForm
  } = useMetadataEditor({
    reconcileServerBookGains,
    selectedBook,
    setBooks
  });
  const selectedDescription = selectedBook ? displayBookDescription(selectedBook) : null;
  const selectedSharedReaders = (selectedBook?.sharedProgress ?? []).filter(
    (reader) => reader.status !== "notStarted"
  );
  const descriptionCanExpand = (selectedDescription?.length ?? 0) > 260;
  const selectedDownload = selectedBook ? activeDownloads[selectedBook.id] : undefined;
  const deviceDownloadQueue = useMemo(
    () => Object.values(activeDownloads).sort((a, b) => a.queuedAt - b.queuedAt),
    [activeDownloads]
  );

  const playbackBook = useMemo(
    () => books.find((book) => book.id === playbackBookId) ?? null,
    [books, playbackBookId]
  );
  const playbackDescription = playbackBook ? displayBookDescription(playbackBook) : null;
  const nowPlayingBook = playbackBook;
  const unplayedConfirmationBook = unplayedConfirmationBookId
    ? books.find((book) => book.id === unplayedConfirmationBookId) ?? null
    : null;

  // The best position this device knows for a book without asking the
  // server: the synchronous checkpoint, backstopped by the listing summary,
  // distrusting a near-zero checkpoint the same way the restore effect does.
  function lastKnownProgressFor(book: Book): Progress | null {
    const checkpoint = readProgressCheckpoint(
      window.localStorage,
      getServerStorageKey(),
      currentUser.id,
      book.id
    );
    const listed = progressFromBookSummary(book.id, book.progress);
    return isSuspectProgressReset(checkpoint, listed)
      ? listed
      : freshestProgress(checkpoint, listed);
  }

  const currentTrack = useMemo(() => {
    if (!playbackBook) {
      return null;
    }
    const saved = playbackBook.tracks.find((track) => track.id === currentTrackId);
    if (saved) return saved;
    if (currentTrackId) {
      // The track id vanished from the book (a rescan renumbered its files).
      // Falling back to the first track would remount the element at 0:00
      // with no pending seek and let the next tick persist that. Resolve the
      // whole-book offset instead; the effect below stages the matching seek.
      const location = resolveProgressLocation(
        playbackBook.tracks,
        lastKnownProgressFor(playbackBook)
      );
      const resolved = location
        ? playbackBook.tracks.find((track) => track.id === location.trackId)
        : null;
      if (resolved) return resolved;
    }
    return playbackBook.tracks[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackId, playbackBook]);

  const activeTrackIndex = currentTrackIndex(playbackBook, currentTrack);
  // Stable identity keys: every progress save rebuilds `books` (and with it
  // the playbackBook/currentTrack objects), so effects that manage the audio
  // source or restore progress must key on ids — re-running them on object
  // identity would tear down the <audio> src mid-playback every few seconds.
  const playbackBookKey = playbackBook?.id ?? null;
  const currentTrackKey = currentTrack?.id ?? null;
  const playbackReportRef = useRef<{ stop: () => Promise<unknown> } | null>(null);
  const playbackTransitions = useMemo(createPlaybackTransitions, []);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrackKey || playbackBook?.source === "device") return;
    const session = playbackReportingSession(currentTrackKey);
    if (!session) return;
    let lastPosition = audio.currentTime;
    let disposed = false;
    let startScheduled = false;
    const positionForReport = () => playbackReportPosition(currentTrackKey, pendingSeekRef.current, lastPosition);
    const rememberPosition = () => {
      if (Number.isFinite(audio.currentTime)) lastPosition = Math.max(0, audio.currentTime);
    };
    const startIfReady = () => {
      rememberPosition();
      if (startScheduled) return;
      startScheduled = true;
      void playbackTransitions.ready().then(async () => {
        // Recheck after the old track drains: this element may have been
        // replaced again, or the listener may have paused while waiting.
        if (disposed || !playbackTouchedRef.current
          || restoredProgressBookId.current !== playbackBookKey
          || resumeReconciliationBookIdRef.current === playbackBookKey
          || (pendingSeekRef.current && pendingSeekRef.current.trackId !== currentTrackKey)
          || (nativeAudio ? !nativePlaybackPlayingRef.current : audio.paused)) return;
        const reportPosition = positionForReport();
        if (reportPosition !== null) await session.start(reportPosition);
      }).finally(() => { startScheduled = false; });
    };
    const reporting = {
      stop: () => {
        const reportPosition = positionForReport();
        return reportPosition === null ? Promise.resolve() : session.stop(reportPosition);
      }
    };
    playbackReportRef.current = reporting;
    audio.addEventListener("play", startIfReady);
    audio.addEventListener("timeupdate", startIfReady);
    audio.addEventListener("seeked", rememberPosition);
    return () => {
      disposed = true;
      audio.removeEventListener("play", startIfReady);
      audio.removeEventListener("timeupdate", startIfReady);
      audio.removeEventListener("seeked", rememberPosition);
      // The application queue can hold a newer checkpoint behind an in-flight
      // request. Drain that queue before stop, and hold the next start behind it.
      void playbackTransitions.stopAfterProgress(() => progressSaveDrainPromiseRef.current, reporting.stop);
      if (playbackReportRef.current === reporting) playbackReportRef.current = null;
    };
    // Capture the element and credentials for this track. A timeupdate retries a
    // start deferred by restore/reconciliation without reporting optimistic progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackKey, playbackBookKey, currentUser.id, nativeAudio, playbackTransitions]);
  const bookIdsKey = useMemo(() => books.map((book) => book.id).join("|"), [books]);
  const downloadScanKey = useMemo(() => shelfDownloadScanKey(books), [books]);
  const booksRef = useRef<Book[]>(books);
  const {
    adoptCarPlaybackState,
    carEventHandlersRef,
    carPlaybackBook,
    carPlaybackBookId,
    setCarPlaybackBookId,
    takeOverFromCar
  } = useCarPlay({
    acknowledgedSeekGenerationRef,
    bookGains,
    bookIdsKey,
    books,
    booksRef,
    currentUser,
    downloadedBookIds,
    flushProgressSaveQueue,
    progressMutationVersion,
    queuedProgressSaves,
    speed,
    updateBookProgress
  });

  booksRef.current = books;
  const playbackTrackIdsKey = useMemo(
    () => playbackBook?.tracks.map((track) => track.id).join("|") ?? "",
    [playbackBook]
  );
  // Commit the currentTrack fallback resolution once per track-list change:
  // point the saved track id at the resolved track and queue its position as
  // a pending seek, so the remounted element restores it instead of starting
  // at 0:00. Only for a book already restored — while a restore is still
  // running it owns the track id and the pending seek.
  useEffect(() => {
    if (
      !playbackBook ||
      !currentTrackId ||
      restoredProgressBookId.current !== playbackBook.id ||
      playbackBook.tracks.some((track) => track.id === currentTrackId)
    ) {
      return;
    }
    const location = resolveProgressLocation(
      playbackBook.tracks,
      lastKnownProgressFor(playbackBook)
    );
    if (!location) return;
    const wasPlaying = nativeAudio ? nativePlaybackPlayingRef.current : isPlaying;
    setCurrentTrackId(location.trackId);
    setPendingSeek(location);
    setPosition(location.positionSeconds);
    setDuration(
      playbackBook.tracks.find((track) => track.id === location.trackId)?.durationSeconds ?? 0
    );
    playWhenTrackLoads.current = wasPlaying;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackBookKey, playbackTrackIdsKey, currentTrackId]);
  const administrableBooks = useMemo(
    () => books.filter((book) => book.source !== "device"),
    [books]
  );
  const playbackBookDownloaded = !!playbackBook && downloadedBookIds.has(playbackBook.id);
  const mediaCredentialReady = !!getStoredMediaToken();
  const requiredNativeAudioQueueKey = nativeQueueIdentityAfterRestore(
    nativeAudio,
    playbackBook?.id ?? null,
    currentTrack?.id ?? null,
    restoredPlaybackBookId,
    playbackBookDownloaded,
    mediaCredentialReady
  );
  const nativeAudioQueueReady = nativeQueueIsReady(
    nativeAudio,
    requiredNativeAudioQueueKey,
    nativeAudioQueueReadyKey
  );
  const offlineSourceUrl =
    offlineSource && offlineSource.trackId === currentTrack?.id ? offlineSource.url : null;
  // On native, keep the audio source empty until the disk lookup answers so a
  // downloaded track plays from its file instead of first hitting the network
  // (which fails offline and can consume the pending resume seek).
  const offlineSourcePending = native && !!currentTrack && offlineSource?.trackId !== currentTrack.id;
  const streamUrl =
    !currentTrack || offlineSourcePending ? "" : offlineSourceUrl ?? mediaUrl(currentTrack.streamUrl);
  const nativeAttachmentSource = nativeAudio && nativeAudioQueueReady
    ? nativeQueueEntryUrl(nativeAudioQueueRef.current, streamUrl)
    : streamUrl;
  const sliderMax = duration || currentTrack?.durationSeconds || 0;
  const bookDuration = playbackBook?.durationSeconds ?? (playbackBook ? durationFromTracks(playbackBook) : 0);
  const bookPosition =
    playbackBook && currentTrack
      ? trackOffsetSeconds(playbackBook, activeTrackIndex) + position
      : 0;
  const boundedBookPosition = bookDuration > 0
    ? Math.min(bookDuration, Math.max(0, bookPosition))
    : 0;
  // Keep every visible playback clock on the same whole-second boundary.
  // The media element reports fractional time at browser-dependent rates;
  // formatting each derived time independently made elapsed and remaining
  // labels appear to tick out of sync whenever offsets or durations had a
  // fractional second.
  const displayTrackPosition = Math.floor(Math.max(0, position));
  const displayBookPosition =
    playbackBook && currentTrack
      ? trackOffsetSeconds(playbackBook, activeTrackIndex) + displayTrackPosition
      : 0;
  const displayBookRemainingSeconds = bookDuration > 0
    ? Math.max(0, bookDuration - displayBookPosition)
    : null;
  const bookCompletionPercent = bookDuration > 0
    ? Math.min(100, Math.floor((boundedBookPosition / bookDuration) * 100))
    : null;
  const chapterSegments = useMemo(() => {
    if (!playbackBook || !bookDuration || playbackBook.chapters.length === 0) {
      return [];
    }
    return buildChapterSegments(playbackBook.chapters, bookDuration);
  }, [bookDuration, playbackBook]);
  const selectedChapterSegments = useMemo(
    () =>
      selectedBook
        ? buildChapterSegments(
            selectedBook.chapters,
            selectedBook.durationSeconds ?? durationFromTracks(selectedBook)
          )
        : [],
    [selectedBook]
  );
  const activeChapter = chapterAtBookPosition(chapterSegments, bookPosition);
  const chapterElapsed = activeChapter
    ? Math.max(0, bookPosition - activeChapter.startSeconds)
    : position;
  const displayChapterElapsed = activeChapter
    ? Math.max(0, displayBookPosition - activeChapter.startSeconds)
    : displayTrackPosition;
  const scrubbedElapsed = scrubPreview ?? displayChapterElapsed;
  const chapterDuration = activeChapter
    ? Math.max(1, activeChapter.endSeconds - activeChapter.startSeconds)
    : Math.max(1, sliderMax);
  const activeChapterIndex = activeChapter
    ? chapterSegments.findIndex((chapter) => chapter.id === activeChapter.id)
    : -1;
  const currentTrackChapterKey = currentTrack
    ? JSON.stringify(
        chapterSegments
          .filter((chapter) => chapter.trackId === currentTrack.id)
          .map((chapter) => [
            chapter.id,
            chapter.title,
            chapter.startSeconds,
            chapter.endSeconds
          ])
      )
    : "";
  const hasPreviousChapter = activeChapterIndex > 0 || chapterElapsed > 5;
  const hasNextChapter = activeChapterIndex >= 0 && activeChapterIndex < chapterSegments.length - 1;
  const upcomingChapters = activeChapterIndex >= 0
    ? chapterSegments.slice(activeChapterIndex + 1, activeChapterIndex + 4)
    : chapterSegments.slice(0, 3);
  const isViewingPlayingBook = !!selectedBook && !!playbackBook && selectedBook.id === playbackBook.id;
  const playbackGain = playbackBook ? bookGains[playbackBook.id] ?? BOOK_GAIN_DEFAULT : BOOK_GAIN_DEFAULT;
  const selectedGain = selectedBook ? bookGains[selectedBook.id] ?? BOOK_GAIN_DEFAULT : BOOK_GAIN_DEFAULT;
  // Above unity the boost needs an engine that can supply it: AVPlayer's mixer
  // on iOS, or a Web Audio chain everywhere else — and that chain can only tap
  // a stream this page is allowed to read. That is a property of the book's own
  // source rather than of the server: a downloaded or device-imported book
  // plays from the app's own origin and is boostable even when the remote
  // stream it came from would not be.
  function bookCanBoost(book: Book | null) {
    if (nativeAudio) return true;
    if (!book) return false;
    if (book.source === "device" || downloadedBookIds.has(book.id)) return true;
    const [firstTrack] = book.tracks;
    return !!firstTrack && streamCanBeBoosted(mediaUrl(firstTrack.streamUrl));
  }

  const selectedCanBoost = bookCanBoost(selectedBook);
  const playbackCanBoost = bookCanBoost(playbackBook);

  function closeReadalong() {
    // Removing the full-screen reader before the tab bar returns shows the
    // Reading page at full height, then again as the web view shrinks.
    if (immersiveEpub && nativeTabsReady) {
      setReaderClosing(true);
    } else {
      setReadalongOpen(false);
    }
    if (selectedBook) {
      writeReaderOpenFlag(selectedBook.id, false);
    }
  }

  const loadBooks = useCallback(async () => {
    const requestGeneration = ++libraryRequestGenerationRef.current;
    const isCurrentRequest = () => requestGeneration === libraryRequestGenerationRef.current;
    if (libraryRetryTimerRef.current !== null) {
      window.clearTimeout(libraryRetryTimerRef.current);
      libraryRetryTimerRef.current = null;
    }
    setIsLoading(true);
    setError(null);
    if (native) {
      await migrateDeviceLibraryFileExtensions();
      await backfillDeviceLibraryMetadata();
    }
    const deviceBooks = native ? getDeviceBooks() : [];
    const applyLoadedBooks = (nextBooks: Book[], definitive = false) => {
      if (!isCurrentRequest()) return;
      setBooks(nextBooks);
      setSelectedBookId((existing) =>
        resolveBookId(nextBooks, existing ?? readStoredBookId(currentUser.id, "selectedBookId"))
      );
      // A background refresh that lists the playing book as finished must not
      // pull the session out from under the listener; only its absence can.
      const isPlayingNow = nativeAudioRef.current
        ? nativePlaybackPlayingRef.current
        : !!audioRef.current && !audioRef.current.paused;
      setPlaybackBookId((existing) => {
        const preferred = existing ?? readStoredBookId(currentUser.id, "playbackBookId");
        const next = resolveActivePlaybackBookId(nextBooks, preferred, isPlayingNow);
        const preferredIsPresent = !!preferred && nextBooks.some((book) => book.id === preferred);
        // A device-only first paint may not contain the stored server book.
        // Wait for the cached/live shelf before deciding that session vanished.
        if (!next && preferred && !preferredIsPresent && !definitive) return existing;
        if (
          !startupNavigationResolved.current
          && canResolveStartupNavigation(next, preferred, preferredIsPresent, definitive)
        ) {
          startupNavigationResolved.current = true;
          if (native) {
            setNativeTab(next ? "reading" : "shelf");
            // The stored selection may be a book last browsed on the shelf.
            if (next) setSelectedBookId(next);
            // A restored Reading tab still needs its saved track and position.
            // Revealing it here paints the first track at 0:00 before the
            // progress effect below resolves the real checkpoint.
            if (!next) {
              startupViewReadyRef.current = true;
              setStartupViewReady(true);
            }
          }
        }
        return next;
      });
    };
    if (localMode) {
      applyLoadedBooks(deviceBooks, true);
      if (isCurrentRequest()) {
        setIsOffline(false);
        setIsLoading(false);
      }
      return;
    }

    const liveLibraryRequest = getBooks().then(
      (serverBooks) => ({ ok: true as const, serverBooks }),
      (requestError: unknown) => ({ ok: false as const, requestError })
    );
    let hydratedServerBooks: Book[] = [];
    if (!initialLibraryHydrated.current) {
      initialLibraryHydrated.current = true;

      // Device imports are synchronous, so they can paint on the first native
      // frame. The IndexedDB shelf follows immediately on every platform while
      // the live request runs.
      if (deviceBooks.length) {
        applyLoadedBooks(deviceBooks);
        setIsLoading(false);
      }
      hydratedServerBooks = withoutCachedBookGains(
        await getCachedLibrary(currentUser.id).catch(() => [])
      );
      if (!isCurrentRequest()) return;
      const hydratedBooks = mergeDeviceAndServerBooks(hydratedServerBooks, deviceBooks);
      if (hydratedBooks.length) {
        applyLoadedBooks(hydratedBooks);
        setIsOffline(false);
        setIsLoading(false);
      }
    }

    try {
      const liveLibrary = await liveLibraryRequest;
      if (!isCurrentRequest()) return;
      if (!liveLibrary.ok) throw liveLibrary.requestError;
      const serverBooks = liveLibrary.serverBooks;
      const nextBooks = mergeDeviceAndServerBooks(serverBooks, deviceBooks);
      // Reconcile every durable local copy, not only imported device media.
      // This brings progress recorded while offline back to the server even if
      // the user opens a different book after reconnecting.
      void Promise.all(nextBooks.map(async (book) => {
        if (book.source !== "server") return;
        const deviceProgress = book.deviceBookId ? getDeviceProgress(book.deviceBookId) : null;
        const deviceBook = book.deviceBookId
          ? deviceBooks.find((candidate) => candidate.id === book.deviceBookId)
          : null;
        const deviceTrackIndex = deviceBook?.tracks.findIndex(
          (track) => track.id === deviceProgress?.trackId
        ) ?? -1;
        const mappedDevice = deviceProgress && deviceTrackIndex >= 0 && book.tracks[deviceTrackIndex]
          ? {
              ...deviceProgress,
              bookId: book.id,
              trackId: book.tracks[deviceTrackIndex].id
            }
          : null;
        const checkpoint = readProgressCheckpoint(
          window.localStorage,
          getServerStorageKey(),
          currentUser.id,
          book.id
        );
        const cached = await getCachedProgress(currentUser.id, book.id).catch(() => null);
        if (!isCurrentRequest()) return;
        const local = freshestProgress(mappedDevice, checkpoint, cached);
        const serverBook = serverBooks.find((candidate) => candidate.id === book.id);
        if (
          !local ||
          (serverBook?.progress && progressTimestamp(local.updatedAt) <= progressTimestamp(serverBook.progress.updatedAt))
        ) {
          return;
        }
        const location = resolveProgressLocation(book.tracks, local);
        if (!location) return;
        if (!isCurrentRequest()) return;
        const attempted: Progress = {
          ...local,
          trackId: location.trackId,
          positionSeconds: location.positionSeconds
        };
        const saved = await saveProgress(
          book.id,
          attempted,
          { isPaused: true }
        ).catch(() => null);
        if (!saved || !isCurrentRequest()) return;
        const currentCheckpoint = readProgressCheckpoint(
          window.localStorage,
          getServerStorageKey(),
          currentUser.id,
          book.id
        );
        if (progressAfterSave(currentCheckpoint, attempted, saved) === saved) {
          storeCanonicalServerProgress(book, saved);
        }
      })).catch(() => undefined);
      if (!isCurrentRequest()) return;
      applyLoadedBooks(nextBooks, true);
      reconcileServerBookGains(serverBooks);
      setIsOffline(false);
      if (isCurrentRequest()) void cacheLibrary(currentUser.id, serverBooks);
      if (isOperaLibre) {
        // Audio tags commonly omit the publisher blurb. Libation already has
        // the correct Audible description and returns its matched local book
        // id, so enrich in the background without delaying the shelf.
        void getLibationBooks()
          .then((catalog) => {
            if (!isCurrentRequest()) return;
            setLibationBooks(catalog);
            setLibationBooksLoaded(true);
          })
          .catch(() => undefined);
      }
    } catch (loadError) {
      const cachedServer = hydratedServerBooks.length
        ? hydratedServerBooks
        : withoutCachedBookGains(await getCachedLibrary(currentUser.id));
      if (!isCurrentRequest()) return;
      const cached = mergeDeviceAndServerBooks(cachedServer, deviceBooks);
      applyLoadedBooks(cached, true);
      if (isServerNotReadyError(loadError)) {
        // The server answered: it is up, its startup scan just has not
        // published a catalogue yet. Keep the cached shelf without muting
        // anything, and ask again when it said to.
        setIsOffline(false);
        setError("The server is still loading its library. The shelf refreshes once it is ready.");
        const delayMs = Math.min(30_000, Math.max(2_000, (loadError.retryAfterSeconds ?? 5) * 1000));
        libraryRetryTimerRef.current = window.setTimeout(() => {
          libraryRetryTimerRef.current = null;
          void loadBooksRef.current();
        }, delayMs);
        return;
      }
      setIsOffline(true);
      if (cached.length) {
        setError("Offline mode — showing downloaded books and cached library.");
      } else {
        setError("The audiobook server is not reachable.");
      }
    } finally {
      if (isCurrentRequest()) setIsLoading(false);
    }
    // storeCanonicalServerProgress and reconcileServerBookGains read only
    // currentUser.id (listed), refs and state setters, so the render that
    // created this callback cannot hand them anything stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser.id, isOperaLibre, localMode, native]);
  const {
    activeCompanion,
    activeCompanionIsBook,
    activeCompanionUrl,
    canGenerateSync,
    companionPreviewUrl,
    galleryAvailable,
    narrationFollowActive,
    openReadalong,
    readalongAvailable,
    readalongOpen,
    readalongPanelRef,
    readerClosing,
    readerScope,
    requestSyncGeneration,
    selectedCompanionGroups,
    selectedCompanionList,
    selectedHasExtras,
    selectedReadAlongMode,
    selectedSyncFragments,
    selectedSyncPrecise,
    sentenceFollowAvailable,
    setActiveCompanionId,
    setReadalongOpen,
    setReaderClosing,
    showGallery,
    showReaderInNowView,
    startSyncGeneration,
    syncJob,
    syncJobError,
    syncNotice,
    toggleReadalongEnabled,
    updateAlignmentStatus,
    writeReaderOpenFlag
  } = useReadalong({
    capabilities,
    currentUser,
    demoMode,
    followSyncEnabled,
    isOperaLibre,
    isViewingPlayingBook,
    loadBooks,
    localMode,
    native,
    nativePlayerView,
    readalongEnabled,
    selectedBook,
    selectedBookId,
    setNativePlayerView,
    setNativeTab,
    setReadalongEnabled,
    setSelectedBookId,
    setSyncConfirmationBook
  });

  const {
    allAudibleAccounts,
    audibleAccountFilter,
    audibleAccountLabels,
    brokenLibationAccounts,
    canBrowseLibation,
    displayedLibationJobs,
    downloadAllLibationJob,
    isRefreshingAudible,
    libationAllPending,
    libationBooks,
    libationBooksLoaded,
    libationBooksRef,
    libationDownloadRequests,
    libationError,
    libationFinalizationFailures,
    libationFinalizingAsins,
    libationJobs,
    libationLoading,
    libationMessage,
    libationRefreshPending,
    libationRequests,
    libationStatus,
    libroAccounts,
    libroAvailable,
    libroOnDevice,
    libroRefreshKey,
    loadLibationBooks,
    pendingLibationJobs,
    purchaseAccountFilter,
    refreshLibationJob,
    setAudibleAccountFilter,
    setLibationBooks,
    setLibationBooksLoaded,
    setLibroAccounts,
    setLibroDestination,
    setLibroRefreshKey,
    setPurchaseAccountFilter,
    showAudiblePurchases,
    startAllLiberation,
    startLibationSync,
    startLiberation,
    visibleLibationBooks
  } = usePurchases({
    capabilities,
    currentUser,
    demoMode,
    isOperaLibre,
    librarySource,
    loadBooks,
    localMode,
    native,
    onCurrentUserChanged,
    searchQuery,
    sortMode,
    sortReversed
  });

  loadBooksRef.current = loadBooks;

  useEffect(
    () => () => {
      if (libraryRetryTimerRef.current !== null) {
        window.clearTimeout(libraryRetryTimerRef.current);
        libraryRetryTimerRef.current = null;
      }
      // Signing out unmounts the player with its session still held (the
      // attach cleanup keeps it for the next track); nothing follows now.
      if (nativeAudioAttachedRef.current) {
        nativeAudioAttachedRef.current = false;
        void releaseNativeAudioSession();
      }
    },
    []
  );

  useEffect(() => {
    if (!libationBooks.length) return;
    setBooks((current) => {
      const enriched = enrichBooksFromLibation(current, libationBooks);
      if (enriched !== current && Capacitor.isNativePlatform()) {
        void cacheLibrary(
          currentUser.id,
          enriched.filter((book) => book.source !== "device")
        );
      }
      return enriched;
    });
  }, [currentUser.id, libationBooks]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !books.length) return;
    // A newer scan supersedes this one; a slow stale scan must not land last.
    let cancelled = false;
    void Promise.all(books.map(async (book) => [
      book.id,
      await isBookDownloaded(book).catch(() => false)
    ] as const))
      .then((states) => {
        if (cancelled) return;
        setDownloadedBookIds(new Set(states.filter(([, ready]) => ready).map(([id]) => id)));
      });
    return () => {
      cancelled = true;
    };
    // Keyed on book ids and local-file identity: progress/metadata updates do
    // not re-stat every track, but removing a merged imported copy rechecks the
    // surviving server book even though its id stays the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadScanKey]);
  carEventHandlersRef.current = {
    playbackStarted: (bookId: string) => {
      // The driver started a book on the shared player. Claim it before any
      // state settles: the player teardown that follows checks this flag to
      // decide whether stopping the engine is this app's to do.
      setCarPlaybackOwner(bookId);
      void persistProgress();
      setCarPlaybackBookId(bookId);
      clearPlaybackSession();
    },
    sync: () => {
      void adoptCarPlaybackState();
    }
  };

  // Reattach the UI to persisted native jobs after a relaunch. Enqueueing is
  // idempotent, so this also supplies file metadata needed to recover jobs
  // created by older builds without duplicating their URLSession tasks.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !books.length) return;
    let cancelled = false;
    void Promise.all(books.map(async (book) => {
      const status = await getBookBackgroundDownloadStatus(book).catch(() => null);
      return { book, status };
    })).then((entries) => {
      if (cancelled) return;
      for (const { book, status } of entries) {
        if (status?.state === "queued" || status?.state === "running") {
          void downloadForOffline(book);
        }
      }
    });
    return () => { cancelled = true; };
    // Stable ids prevent progress saves from repeatedly reattaching the queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookIdsKey]);

  useEffect(() => {
    let active = true;
    let resolvedUrl: string | null = null;
    setOfflineSource((source) => source?.trackId === currentTrack?.id ? source : null);
    if (Capacitor.isNativePlatform() && playbackBook && currentTrack) {
      const trackId = currentTrack.id;
      void getOfflineTrackUrl(playbackBook, currentTrack)
        .catch(() => null)
        .then((url) => {
          resolvedUrl = url;
          if (active) setOfflineSource({ trackId, url });
          else releaseOfflineMediaUrl(url);
        });
    }
    return () => {
      active = false;
      releaseOfflineMediaUrl(resolvedUrl);
    };
    // Keyed on ids: resetting offlineSource on identity churn blanked the
    // <audio> src mid-playback (native), stopping the book seconds after play.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackKey, playbackBookKey, playbackBookDownloaded]);

  useEffect(() => {
    let active = true;
    if (nativeQueueRefreshShouldResume(
      nativeAudio,
      nativePlaybackPlayingRef.current,
      requiredNativeAudioQueueKey,
      nativeAudioQueueReadyKey
    ) && playbackBook) {
      playWhenTrackLoads.current = true;
      wantsAutoplayRef.current = true;
      setPlayPending(true, playbackBook.id);
    }
    nativeAudioQueueRef.current = [];
    setNativeAudioQueueReadyKey(null);
    if (!nativeAudio || !playbackBook || !currentTrack) {
      return;
    }
    const queueKey = requiredNativeAudioQueueKey;
    if (!queueKey) return;
    const tracks = playbackBook.tracks.slice(activeTrackIndex);
    const entry = (track: Track, queueIndex: number, sourceUrl: string): NativeAudioQueueTrack => {
      const trackOffset = trackOffsetSeconds(playbackBook, activeTrackIndex + queueIndex);
      return {
        url: sourceUrl,
        trackId: track.id,
        bookOffsetSeconds: trackOffset,
        title: track.title,
        artist: playbackBook.author ?? "Audiobook",
        album: playbackBook.title,
        chapters: chapterSegments
          .filter((chapter) => chapter.trackId === track.id)
          .map((chapter) => ({
            title: chapter.title,
            startSeconds: chapter.startSeconds - trackOffset,
            durationSeconds: chapter.durationSeconds
          }))
      };
    };
    const publish = (queue: NativeAudioQueueTrack[]) => {
      if (!active) return;
      nativeAudioQueueRef.current = queue;
      setNativeAudioQueueReadyKey(queueKey);
    };
    // Resolve each item from disk regardless of whether the separate complete
    // download scan has finished. Otherwise chapter one can be local while
    // later AVQueuePlayer items still point at a dead server on a cold launch.
    void resolveLocalFirstSources(
      tracks,
      (track) => getOfflineTrackUrl(playbackBook, track),
      (track) => mediaUrl(track.streamUrl)
    ).then((sources) => {
      // A fully local queue is usable before background authentication. Any
      // remote fallback must wait for its media credential, or AVPlayer can
      // fail permanently on the tokenless URL before the refreshed queue lands.
      if (!canPublishNativeQueue(sources, mediaCredentialReady)) return;
      publish(tracks.map((track, index) => entry(track, index, sources[index].url)));
    });
    return () => {
      active = false;
    };
    // Stable ids intentionally keep queue construction off progress-object
    // churn while still rebuilding it for a real track transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTrackIndex,
    currentTrackKey,
    nativeAudio,
    playbackBookKey,
    playbackBookDownloaded,
    requiredNativeAudioQueueKey
  ]);

  // Autoplay requested while the audio source was still resolving (native disk
  // lookup): start playback as soon as the source lands.
  useEffect(() => {
    if (!streamUrl || !nativeAudioQueueReady || !wantsAutoplayRef.current) {
      return;
    }
    wantsAutoplayRef.current = false;
    window.setTimeout(() => startPlaybackRef.current(audioRef.current), 0);
  }, [nativeAudioQueueReady, streamUrl]);

  useEffect(() => {
    void loadBooks();
  }, [loadBooks]);

  useEffect(() => {
    writeStoredBookId(currentUser.id, "selectedBookId", selectedBookId);
  }, [currentUser.id, selectedBookId]);

  useEffect(() => {
    setDescriptionExpanded(false);
  }, [selectedBookId]);

  useEffect(() => {
    writeStoredBookId(currentUser.id, "playbackBookId", playbackBookId);
  }, [currentUser.id, playbackBookId]);
  libationBooksRef.current = libationBooks;

  useEffect(() => {
    if (!playbackBook) {
      return;
    }

    let cancelled = false;
    restoredProgressBookId.current = null;
    setRestoredPlaybackBookId(null);
    if (!startupViewReadyRef.current) startupProgressAppliedRef.current = false;
    if (explicitSessionStartBookIdRef.current === playbackBook.id) {
      // A shelf play/restart chose this pending position deliberately. It is
      // the beginning of a new session, not a request to restore the previous
      // session (especially important for "Read it again" on a finished book).
      explicitSessionStartBookIdRef.current = null;
      restoredProgressBookId.current = playbackBook.id;
      setRestoredPlaybackBookId(playbackBook.id);
      return () => {
        cancelled = true;
      };
    }
    playbackTouchedRef.current = false;
    const armResumeAutoplay = resumeAutoplayBookIdRef.current === playbackBook.id;
    resumeAutoplayBookIdRef.current = null;
    const restoreVersion = progressMutationVersion.current;
    const restoreActionVersion = playbackActionVersionRef.current;
    const restoreCancelGeneration = playCancelGenerationRef.current;
    // Restoring places the player afresh; an earlier refused position is moot.
    overruledSaveRef.current.delete(playbackBook.id);
    if (armResumeAutoplay) resumeReconciliationBookIdRef.current = playbackBook.id;
    const applyProgress = (progress: Progress | null) => {
      if (
        cancelled ||
        progressMutationVersion.current !== restoreVersion ||
        playbackActionVersionRef.current !== restoreActionVersion
      ) {
        return;
      }
      const location = resolveProgressLocation(playbackBook.tracks, progress);
      setCurrentTrackId(location?.trackId ?? null);
      setPendingSeek(location);
      // Show the restored time immediately; the media element seeks to it
      // once metadata loads.
      setPosition(location?.positionSeconds ?? 0);
      const restoredTrack = location
        ? playbackBook.tracks.find((track) => track.id === location.trackId)
        : playbackBook.tracks[0];
      setDuration(restoredTrack?.durationSeconds ?? 0);
      restoredProgressBookId.current = playbackBook.id;
      setRestoredPlaybackBookId(playbackBook.id);
      startupProgressAppliedRef.current = true;
      // The restored track and position are now known, so a queued shelf
      // Resume can safely play: both places that consume this flag apply the
      // pending seek before starting.
      if (armResumeAutoplay && playCancelGenerationRef.current === restoreCancelGeneration) {
        playWhenTrackLoads.current = true;
        resumeAutoplayPendingRef.current = true;
      }
      // These updates are batched. The short quiet window also absorbs a
      // fresher server reply or native metadata before the overlay leaves.
      scheduleStartupReveal();
    };

    void (async () => {
      // Independent local stores can answer concurrently; preserve the same
      // freshest-copy reconciliation after both have completed.
      const [recoveredNative, cached] = await Promise.all([
        nativeAudio
          ? getNativeAudioRecovery(nativeAudioRecoveryScope(currentUser.id, playbackBook.id)).catch(() => null)
          : Promise.resolve(null),
        getCachedProgress(currentUser.id, playbackBook.id).catch(() => null)
      ]);
      const recoveryTrack = recoveredNative
        ? playbackBook.tracks.find((track) => track.id === recoveredNative.trackId)
        : null;
      const nativeProgress: Progress | null = recoveredNative && recoveryTrack
        ? {
            bookId: playbackBook.id,
            trackId: recoveryTrack.id,
            positionSeconds: recoveredNative.positionSeconds,
            bookPositionSeconds: recoveredNative.bookPositionSeconds,
            durationSeconds: recoveredNative.durationSeconds ?? recoveryTrack.durationSeconds,
            updatedAt: new Date(recoveredNative.updatedAt).toISOString()
          }
        : null;
      const deviceBookId = playbackBook.deviceBookId;
      const device = deviceBookId ? getDeviceProgress(deviceBookId) : null;
      const checkpoint = readProgressCheckpoint(
        window.localStorage,
        getServerStorageKey(),
        currentUser.id,
        playbackBook.id
      );
      if (playbackBook.source === "device") {
        const local = freshestProgress(device, checkpoint, cached, nativeProgress);
        if (local) updateBookProgress(playbackBook.id, local);
        applyProgress(local);
        return;
      }
      const deviceBook = deviceBookId ? getDeviceBooks().find((book) => book.id === deviceBookId) : null;
      const deviceTrackIndex = deviceBook?.tracks.findIndex((track) => track.id === device?.trackId) ?? -1;
      const mappedServerTrack = deviceTrackIndex >= 0 ? playbackBook.tracks[deviceTrackIndex] : null;
      const mappedDevice = device && mappedServerTrack
        ? { ...device, bookId: playbackBook.id, trackId: mappedServerTrack.id }
        : null;
      // Progress saved on the device or while disconnected can be newer than
      // the server. Resume from the freshest copy and converge the server.
      const freshestLocal = freshestProgress(mappedDevice, checkpoint, cached, nativeProgress);
      // The summary embedded in the library listing is also the server's
      // copy. It backstops a failed or empty progress fetch — without it, a
      // fresh install that hits one failed request opens the book at zero and
      // the next save wipes the real position on the server too.
      const listed = progressFromBookSummary(playbackBook.id, playbackBook.progress);
      // Resume from the best copy already on the device before asking the
      // server. Waiting on that request left the player at 0:00 for the whole
      // network timeout whenever the server was unreachable. A near-zero
      // local copy that outranks substantial listed progress by timestamp
      // alone is distrusted the same way the reconciliation below distrusts
      // it — showing 0:00 here is what tempts a listener to "fix" it.
      const optimistic = isSuspectProgressReset(freshestLocal, listed)
        ? listed
        : freshestProgress(freshestLocal, listed);
      applyProgress(optimistic);
      let server: Progress | null = null;
      let serverReachable = true;
      // One failed fetch must not strand this device on a stale or empty
      // copy — that is how a second device ends up at 0:00 and later pushes
      // it over real progress. Retry briefly before reconciling.
      // Each attempt is capped well below the client's 30 s default: local
      // copies cover the wait, and no server checkpoint is queued until the
      // window closes, so a long one is listening that goes unsynced.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          server = await getProgress(playbackBook.id, RESTORE_PROGRESS_TIMEOUT_MS);
          serverReachable = true;
          break;
        } catch {
          serverReachable = false;
        }
        if (cancelled || attempt === 2) {
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 4_000 * (attempt + 1)));
      }
      if (cancelled) {
        return;
      }
      if (playbackActionVersionRef.current !== restoreActionVersion) {
        // The listener already moved playback in this session; their live
        // position and its queued saves outrank whatever this late fetch
        // returned, and re-applying it would yank playback.
        return;
      }
      const lastKnownServer = server ?? listed;
      if (lastKnownServer) {
        acknowledgedServerPositionRef.current.set(
          playbackBook.id,
          lastKnownServer.bookPositionSeconds
        );
      }
      const suspectLocalReset = isSuspectProgressReset(freshestLocal, lastKnownServer);
      const localIsNewer =
        !!freshestLocal &&
        !suspectLocalReset &&
        (!lastKnownServer || progressTimestamp(freshestLocal.updatedAt) > progressTimestamp(lastKnownServer.updatedAt));
      let target = localIsNewer ? freshestLocal : lastKnownServer ?? freshestLocal;
      let serverCorrectedLocal = false;
      if (localIsNewer) {
        updateBookProgress(playbackBook.id, freshestLocal);
        if (serverReachable) {
          const saved = await saveProgress(
            playbackBook.id,
            freshestLocal,
            { isPaused: true }
          ).catch(() => null);
          if (cancelled || playbackActionVersionRef.current !== restoreActionVersion) return;
          if (saved) {
            const currentCheckpoint = readProgressCheckpoint(
              window.localStorage,
              getServerStorageKey(),
              currentUser.id,
              playbackBook.id
            );
            if (progressAfterSave(currentCheckpoint, freshestLocal, saved) === saved) {
              serverCorrectedLocal = saved.trackId !== freshestLocal.trackId
                || Math.abs(saved.bookPositionSeconds - freshestLocal.bookPositionSeconds) > 0.01;
              storeCanonicalServerProgress(playbackBook, saved);
              target = saved;
            }
          }
        }
      }
      // Re-seek only when the reconciled copy is genuinely fresher than what
      // was already applied (or the applied copy was a distrusted reset);
      // re-applying an equal copy would yank playback.
      if (
        !optimistic ||
        suspectLocalReset ||
        serverCorrectedLocal ||
        (target && progressTimestamp(target.updatedAt) > progressTimestamp(optimistic.updatedAt))
      ) {
        applyProgress(target);
      }
    })().finally(() => {
      // Let React commit a final reconciled seek before timeupdate is allowed
      // to persist again; otherwise the optimistic media clock can win the
      // narrow gap between setPendingSeek and its render.
      window.setTimeout(() => {
        if (resumeReconciliationBookIdRef.current === playbackBook.id) {
          resumeReconciliationBookIdRef.current = null;
        }
      }, 0);
    });

    return () => {
      cancelled = true;
      if (resumeReconciliationBookIdRef.current === playbackBook.id) {
        resumeReconciliationBookIdRef.current = null;
      }
    };
    // Keyed on the book id: this must run only when playback moves to a
    // different book. Re-running on object identity meant every successful
    // progress save re-applied the server's copy, yanking playback back to
    // the previous track/position around track boundaries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser.id, playbackBookKey]);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.playbackRate = speed;
  }, [speed, currentTrackKey, nativeAudio]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!nativeAudio) return;
    if (carPlaybackBookId) {
      // CarPlay is driving the shared player. Attaching would load this app's
      // book over the driver's, and the next detach would stop it outright.
      // The element stays muted so nothing here can be heard over the car.
      if (audio) audio.muted = true;
      nativeAudioAttachedRef.current = false;
      return;
    }
    if (!audio || !playbackBook || !currentTrack) {
      // The player closed. The attach cleanup keeps the audio session so a
      // track change does not hand audio to other apps between chapters;
      // nothing follows this time, so give the session up. Skipped on the
      // app's first render, where a WebView reload may have left native
      // audio playing that React is about to pick back up.
      if (nativeAudioAttachedRef.current) {
        nativeAudioAttachedRef.current = false;
        void releaseNativeAudioSession();
      }
      return;
    }
    // AVPlayer receives its complete local-first queue on the initial load.
    // Attaching earlier would start a one-item player and tear it down again
    // when slower filesystem checks for later chapters completed.
    if (!nativeAudioQueueReady) return;
    nativeAudioAttachedRef.current = true;
    return attachNativeAudioPlayer(
      audio,
      (message) => {
        setPlaybackError(message);
      },
      (position, resume) => {
        const ownsIntent = playbackEventOwnsPendingPlay(
          playPendingRef.current,
          playPendingBookIdRef.current,
          playbackBook.id
        );
        const resumeThisBook = resume && ownsIntent;
        setPendingSeek({ trackId: currentTrack.id, positionSeconds: position });
        playWhenTrackLoads.current = resumeThisBook;
        if (ownsIntent) setPlayPending(resumeThisBook, playbackBook.id);
        setNativeAudioFailed(true);
      },
      {
        // The queue is the atomic local-first resolution. Its first item must
        // also seed AVPlayer; using the separately resolved control source can
        // overwrite a just-downloaded local chapter with its old remote URL.
        source: nativeAttachmentSource,
        settings: () => playbackSettingsRef.current,
        scopeKey: nativeAudioRecoveryScope(currentUser.id, playbackBook.id),
        trackId: currentTrack.id,
        bookOffsetSeconds: trackOffsetSeconds(playbackBook, activeTrackIndex),
        queue: () => nativeAudioQueueRef.current,
        pendingPosition: () => pendingSeekRef.current?.trackId === currentTrack.id
          ? pendingSeekRef.current.positionSeconds : undefined,
        wantsPlayback: () => playbackIntentBelongsToBook(
          playPendingRef.current,
          playPendingBookIdRef.current,
          playbackBook.id,
          wantsAutoplayRef.current || playWhenTrackLoads.current
        ),
        gain: () => playbackGainRef.current,
        sleepTimerSeconds: () => {
          const deadline = sleepDeadlineRef.current;
          if (deadline !== null) return Math.max(0, (deadline - Date.now()) / 1000);
          return sleepRemainingRef.current;
        }
      },
      (trackId, positionSeconds, _bookPositionSeconds, nativeIsPlaying) => {
        if (!playbackBook.tracks.some((track) => track.id === trackId)) return false;
        // getNativeAudioRecovery already participated in startup
        // reconciliation. A paused trackChanged event emitted while AVPlayer
        // rebuilds its queue is not a listener action and must not overwrite
        // the restored checkpoint or make the player oscillate.
        if (!shouldAcceptNativeTrackChange(startupViewReadyRef.current, nativeIsPlaying)) return false;
        markPlaybackTouchedRef.current();
        nativePlaybackPlayingRef.current = nativeIsPlaying;
        playWhenTrackLoads.current = nativeIsPlaying;
        wantsAutoplayRef.current = nativeIsPlaying;
        setCurrentTrackId(trackId);
        setPendingSeek({ trackId, positionSeconds });
        setPosition(positionSeconds);
        setDuration(playbackBook.tracks.find((track) => track.id === trackId)?.durationSeconds ?? 0);
        scheduleStartupReveal();
        return true;
      },
      () => {
        // The native side has already moved the control clock to the seek.
        // While a pending seek is still queued for this track it would win
        // at loadedmetadata, so retarget it rather than let the lock-screen
        // seek be undone.
        const nativePosition = Math.max(0, audio.currentTime);
        markPlaybackTouchedRef.current(
          true,
          undefined,
          true,
          trackOffsetSeconds(playbackBook, activeTrackIndex) + nativePosition
        );
        if (pendingSeekRef.current?.trackId === currentTrack.id) {
          setPendingSeek({ trackId: currentTrack.id, positionSeconds: nativePosition });
          setPosition(nativePosition);
        }
        void persistProgressRef.current();
      },
      () => {
        sleepDeadlineRef.current = null;
        setSleepMinutes(0);
        setSleepRemaining(0);
      },
      () => {
        foregroundProgressSyncRef.current?.nativeStateSynchronized();
      }
    );
    // Attaching rebuilds the AVPlayer queue, so this is keyed on identity:
    // playbackBook, currentTrack and activeTrackIndex through their ids, and
    // functions with render state go through refs above. setPlayPending
    // touches only refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    carPlaybackBookId,
    currentTrackKey,
    currentUser.id,
    nativeAudio,
    nativeAudioQueueReady,
    playbackBookKey,
    requiredNativeAudioQueueKey,
    nativeAttachmentSource,
    scheduleStartupReveal
  ]);

  // Progress often arrives after preload has already emitted loadedmetadata.
  // Apply that late checkpoint as soon as the target media element is ready.
  useEffect(() => {
    const audio = audioRef.current;
    if (
      pendingSeek === null ||
      pendingSeek.trackId !== currentTrackKey ||
      !audio ||
      audio.readyState < HTMLMediaElement.HAVE_METADATA ||
      !audioSourceMatches(audio, streamUrl)
    ) {
      return;
    }
    const restoredPosition = Math.max(
      0,
      Math.min(pendingSeek.positionSeconds, audio.duration || pendingSeek.positionSeconds)
    );
    if (!nativeAudio || Math.abs(audio.currentTime - restoredPosition) > 0.75) {
      setPlaybackPosition(audio, restoredPosition);
    }
    setPosition(restoredPosition);
    setPendingSeek(null);
    // Mirrors onLoadedMetadata. A queued autoplay whose element had already
    // loaded this exact source gets no second metadata event, so without this
    // a shelf Resume onto the track that was already staged never starts.
    if (playWhenTrackLoads.current) {
      playWhenTrackLoads.current = false;
      startPlayback(audio, !resumeAutoplayPendingRef.current);
      resumeAutoplayPendingRef.current = false;
    }
    // setPlaybackPosition and startPlayback run synchronously here, from the
    // render being committed; listing them would re-run the seek every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackKey, pendingSeek, streamUrl, nativeAudio]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    applyPlaybackVolume(audio);
    if (gainChain().isAttachedTo(audio)) gainChain().setGain(playbackGain);
    if (nativeAudio) void setNativeAudioGain(playbackGain).catch(() => undefined);
    // applyPlaybackVolume reads only volume, playbackGain and nativeAudio,
    // all listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, playbackGain, nativeAudio, currentTrackKey]);

  playbackGainRef.current = playbackGain;

  // The server's copy is what follows the listener between devices, so a boost
  // set on the phone is already applied the first time the book opens here.
  // Backends with nowhere to store it omit the field entirely and leave the
  // local mirror alone. Only genuinely fresh server payloads take part: the
  // long-lived `books` state keeps whatever volumeGain it arrived with, and
  // re-merging it after a failed write released nothing would still be safe —
  // but merging it after every identity change (a progress tick, a pause) is
  // exactly what used to snap an offline adjustment back mid-chapter.
  function reconcileServerBookGains(payload: readonly Book[]) {
    setBookGains((existing) => {
      const merged = mergeServerBookGains(existing, payload, localGainWritesRef.current);
      if (!merged) return existing;
      writeStoredBookGains(currentUser.id, merged);
      return merged;
    });
    // The server just answered, so anything it missed while unreachable can
    // land now; a no-op whenever nothing is owed.
    gainSyncRef.current?.retry();
  }

  useEffect(() => {
    let active = true;
    const book = playbackBook;
    if (!book || (!book.coverArtUrl && !book.localCoverPath)) {
      setMediaArtworkUrl(null);
      return;
    }
    const networkArtwork = book.coverArtUrl ? mediaUrl(book.coverArtUrl) : null;
    if (!native) {
      setMediaArtworkUrl(networkArtwork);
      return;
    }
    void getOfflineCoverUrl(book).then((localArtwork) => {
      if (active) setMediaArtworkUrl(localArtwork ?? networkArtwork);
    });
    return () => {
      active = false;
    };
    // Keyed on the fields the artwork comes from; a progress save replaces
    // playbackBook without changing its cover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, playbackBookKey, playbackBook?.coverArtUrl, playbackBook?.localCoverPath]);

  useEffect(() => {
    if (!playbackBook || !currentTrack) {
      return;
    }

    const trackOffset = trackOffsetSeconds(playbackBook, activeTrackIndex);
    const nowPlaying = {
      title: activeChapter?.title ?? currentTrack.title,
      artist: playbackBook.author ?? "Audiobook",
      album: playbackBook.title,
      artworkUrl: mediaArtworkUrl ?? undefined,
      chapterStartSeconds: activeChapter
        ? activeChapter.startSeconds - trackOffset
        : undefined,
      chapterDurationSeconds: activeChapter?.durationSeconds,
      chapters: chapterSegments
        .filter((chapter) => chapter.trackId === currentTrack.id)
        .map((chapter) => ({
          title: chapter.title,
          // AVPlayer's clock is relative to the current audio file, while
          // chapter markers are relative to the whole book.
          startSeconds: chapter.startSeconds - trackOffset,
          durationSeconds: chapter.durationSeconds
        }))
    };
    if (nativeAudio) {
      void updateNativeAudioNowPlaying(nowPlaying).catch((error) => {
        setPlaybackError(error instanceof Error ? error.message : "Could not update iOS Now Playing.");
      });
      return;
    }
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: nowPlaying.title,
      artist: nowPlaying.artist,
      album: nowPlaying.album,
      artwork: mediaArtworkUrl
        ? [
            { src: mediaArtworkUrl, sizes: "512x512", type: playbackBook.coverArtContentType ?? "image/jpeg" }
          ]
        : undefined
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeChapter?.id,
    currentTrackChapterKey,
    currentTrackKey,
    mediaArtworkUrl,
    nativeAudio,
    playbackBookKey
  ]);

  // Lock-screen and hardware-key handlers are registered once and delegate
  // through this ref, which every render refreshes. Registering the handlers
  // themselves was keyed on the chapter and track, so between re-registrations
  // they held closures from an earlier render: "previous" saw a chapter
  // elapsed of 0 and never restarted the chapter, and "play" engaged the
  // gain chain with a stale gain.
  const mediaSessionHandlersRef = useRef({
    startPlayback,
    pausePlayback,
    seekBy,
    seekTo,
    seekBookPosition,
    restartOrPreviousChapter,
    nextChapter,
    activeChapter
  });
  mediaSessionHandlersRef.current = {
    startPlayback,
    pausePlayback,
    seekBy,
    seekTo,
    seekBookPosition,
    restartOrPreviousChapter,
    nextChapter,
    activeChapter
  };

  useEffect(() => {
    if (nativeAudio || !("mediaSession" in navigator)) return;
    const handlers = mediaSessionHandlersRef;
    const session = navigator.mediaSession;
    session.setActionHandler("play", () => handlers.current.startPlayback(audioRef.current));
    session.setActionHandler("pause", () => handlers.current.pausePlayback(audioRef.current));
    session.setActionHandler("seekbackward", () => handlers.current.seekBy(-15));
    session.setActionHandler("seekforward", () => handlers.current.seekBy(30));
    session.setActionHandler("previoustrack", () => handlers.current.restartOrPreviousChapter());
    session.setActionHandler("nexttrack", () => handlers.current.nextChapter());
    session.setActionHandler("seekto", (details) => {
      if (details.seekTime === undefined) return;
      const { activeChapter: chapter, seekBookPosition: seekBook, seekTo: seek } = handlers.current;
      if (chapter) {
        seekBook(chapter.startSeconds + details.seekTime);
      } else {
        seek(details.seekTime);
      }
    });
    return () => {
      for (const action of [
        "play", "pause", "seekbackward", "seekforward", "previoustrack", "nexttrack", "seekto"
      ] as MediaSessionAction[]) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // An action the browser does not know cannot have been registered.
        }
      }
    };
  }, [nativeAudio]);

  const activeChapterId = activeChapter?.id ?? null;
  useEffect(() => {
    if (nativeAudio || !("mediaSession" in navigator) || !currentTrackKey) return;
    const duration = activeChapterId !== null ? chapterDuration : Math.max(1, sliderMax);
    const lockPosition = activeChapterId !== null ? chapterElapsed : position;
    if (!Number.isFinite(duration) || !Number.isFinite(lockPosition) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.max(0, Math.min(lockPosition, duration)),
        playbackRate: speed
      });
    } catch {
      // Some WebViews expose Media Session metadata without position state.
    }
  }, [activeChapterId, chapterDuration, chapterElapsed, currentTrackKey, nativeAudio, position, sliderMax, speed]);

  useEffect(() => {
    if (!chaptersOpen || !isViewingPlayingBook || activeChapterId === null) return;
    const frame = window.requestAnimationFrame(() => {
      chaptersListRef.current
        ?.querySelector<HTMLElement>(`[data-chapter-id="${activeChapterId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeChapterId, chaptersOpen, isViewingPlayingBook]);

  useEffect(() => {
    const sync = createForegroundProgressSync(
      nativeForegroundSyncGateRef.current,
      () => foregroundProgressActionsRef.current
    );
    foregroundProgressSyncRef.current = sync;
    return () => {
      sync.dispose();
      foregroundProgressSyncRef.current = null;
    };
  }, []);

  function persistProgress(): Promise<void> {
    if (
      !playbackBook ||
      restoredProgressBookId.current !== playbackBook.id ||
      !currentTrack ||
      !audioRef.current
    ) {
      return Promise.resolve();
    }
    // A shelf Resume plays the optimistic local copy while the server's is
    // still being fetched. Until that reconciliation settles, nothing goes
    // to the server: the position being played may be about to be replaced
    // by a fresher copy, and a push would make it look like the newest. The
    // local checkpoint is still kept — the window can span several retries
    // when the server is slow, and listening during it must survive a kill.
    // It does not advance progressMutationVersion, so the reconciled copy
    // still applies when it lands.
    const reconciling = resumeReconciliationBookIdRef.current === playbackBook.id;
    // Nothing moved playback since this book was restored: there is nothing
    // new to save, and writing the restored position back with a fresh
    // timestamp would let a device whose restore silently failed outrank —
    // and then erase — real progress recorded elsewhere. Opening a book and
    // closing it again must write nothing.
    if (!playbackTouchedRef.current) {
      return Promise.resolve();
    }

    // While a seek is queued the media element does not reflect the real
    // position yet — a restore or track jump reads currentTime 0 until
    // metadata loads. Persist the seek target instead; persisting element
    // time here would overwrite the real position everywhere, including the
    // server's only copy.
    const pending = pendingSeekRef.current;
    if (pending && pending.trackId !== currentTrack.id) {
      return Promise.resolve();
    }
    const trackPosition = pending
      ? Math.max(0, pending.positionSeconds)
      : Number.isFinite(audioRef.current.currentTime)
        ? Math.max(0, audioRef.current.currentTime)
        : Math.max(0, position);
    const localProgress: Progress = {
      bookId: playbackBook.id,
      trackId: currentTrack.id,
      positionSeconds: trackPosition,
      bookPositionSeconds: trackOffsetSeconds(playbackBook, activeTrackIndex) + trackPosition,
      durationSeconds: pending
        ? currentTrack.durationSeconds
        : Number.isFinite(audioRef.current.duration) ? audioRef.current.duration : currentTrack.durationSeconds,
      updatedAt: new Date().toISOString(),
      finishedOverride: playbackBook.progress?.finishedOverride ?? null
    };
    if (!reconciling) progressMutationVersion.current += 1;
    overruledSaveRef.current.delete(playbackBook.id);
    writeProgressCheckpoint(window.localStorage, getServerStorageKey(), currentUser.id, localProgress);
    void cacheProgress(currentUser.id, localProgress).catch(warnCacheFailure("cache listening progress"));
    if (playbackBook.deviceBookId) {
      const deviceBook = getDeviceBooks().find((book) => book.id === playbackBook.deviceBookId);
      const deviceTrack = deviceBook?.tracks[activeTrackIndex];
      if (deviceTrack) saveDeviceProgress(playbackBook.deviceBookId, { ...localProgress, bookId: playbackBook.deviceBookId, trackId: deviceTrack.id });
    }
    updateBookProgress(playbackBook.id, localProgress);
    if (playbackBook.source === "device" || reconciling) {
      return Promise.resolve();
    }

    const existingQueued = queuedProgressSaves.current.get(playbackBook.id);
    const intentionalSeekGeneration = Math.max(
      existingQueued?.intentionalSeekGeneration ?? 0,
      intentionalSeekGenerationRef.current.get(playbackBook.id) ?? 0
    );
    // Lifting the server's reset guard is decided by where the seek went,
    // not by the position being saved now: a +30 s tap must not turn a stale
    // near-zero clock persisted after it into the authoritative copy.
    const intentionalRegression =
      (existingQueued?.intentionalRegression ?? false) ||
      shouldFlagIntentionalRegression(
        intentionalSeekTargetRef.current.get(playbackBook.id),
        acknowledgedServerPositionRef.current.get(playbackBook.id)
      );
    queuedProgressSaves.current.set(playbackBook.id, {
      bookId: playbackBook.id,
      progress: localProgress,
      isPaused: nativeAudio ? !nativePlaybackPlayingRef.current : audioRef.current.paused,
      intentionalSeekGeneration,
      intentionalRegression
    });
    return flushProgressSaveQueue();
  }

  function flushProgressSaveQueue(): Promise<void> {
    const existingDrain = progressSaveDrainPromiseRef.current;
    if (existingDrain) {
      return existingDrain;
    }
    const drain = (async () => {
      // A slow request must not cause a newer position to be discarded. Each
      // in-flight save is followed by the most recent checkpoint queued while
      // it was running.
      while (queuedProgressSaves.current.size > 0) {
        const entry = queuedProgressSaves.current.values().next().value as QueuedProgressSave;
        queuedProgressSaves.current.delete(entry.bookId);
        const abortController = new AbortController();
        progressSaveAbortController.current = abortController;
        try {
          const saved = await saveProgress(
            entry.bookId,
            {
              trackId: entry.progress.trackId,
              positionSeconds: entry.progress.positionSeconds,
              bookPositionSeconds: entry.progress.bookPositionSeconds,
              durationSeconds: entry.progress.durationSeconds,
              updatedAt: entry.progress.updatedAt
            },
            {
              isPaused: entry.isPaused,
              intentionalRegression:
                entry.intentionalRegression
                && entry.intentionalSeekGeneration
                  > (acknowledgedSeekGenerationRef.current.get(entry.bookId) ?? 0),
              intentionalSeek:
                entry.intentionalSeekGeneration
                > (acknowledgedSeekGenerationRef.current.get(entry.bookId) ?? 0),
              signal: abortController.signal
            }
          );
          // Whatever the server answered is now its position — the copy a
          // later rewind is measured against.
          acknowledgedServerPositionRef.current.set(entry.bookId, saved.bookPositionSeconds);
          acknowledgedSeekGenerationRef.current.set(
            entry.bookId,
            Math.max(
              acknowledgedSeekGenerationRef.current.get(entry.bookId) ?? 0,
              entry.intentionalSeekGeneration
            )
          );
          const local = readProgressCheckpoint(
            window.localStorage,
            getServerStorageKey(),
            currentUser.id,
            entry.bookId
          );
          const reconciled = progressAfterSave(local, entry.progress, saved);
          if (reconciled === saved) {
            // Heal future-skewed and rejected local checkpoints with the
            // server's canonical response. Without this, the same stale copy
            // wins every restart and is retried indefinitely.
            const book = books.find((candidate) => candidate.id === entry.bookId);
            if (book) storeCanonicalServerProgress(book, saved);
            if (saveWasOverruled(entry.progress, saved)) {
              overruledSaveRef.current.set(entry.bookId, entry.progress);
              // Move an idle player off the refused position now, not at the
              // next resume. Adoption waits for the rest of this drain.
              void foregroundProgressActionsRef.current.adoptNewerServerProgress();
            }
          }
        } catch {
          // The synchronous checkpoint and IndexedDB copy already contain the
          // position. A later playback tick or reconnect will retry the server.
        } finally {
          if (progressSaveAbortController.current === abortController) {
            progressSaveAbortController.current = null;
          }
        }
      }
    })().finally(() => {
      if (progressSaveDrainPromiseRef.current === drain) {
        progressSaveDrainPromiseRef.current = null;
        if (queuedProgressSaves.current.size > 0) {
          void flushProgressSaveQueue();
        }
      }
    });
    progressSaveDrainPromiseRef.current = drain;
    return drain;
  }

  function updateBookProgress(bookId: string, saved: Progress) {
    setBooks((existing) =>
      existing.map((book) => {
        if (book.id !== bookId) {
          return book;
        }
        return {
          ...book,
          progress: summarizeBookProgress(book, saved)
        };
      })
    );
  }

  function storeCanonicalServerProgress(book: Book, saved: Progress) {
    acknowledgedServerPositionRef.current.set(book.id, saved.bookPositionSeconds);
    writeProgressCheckpoint(
      window.localStorage,
      getServerStorageKey(),
      currentUser.id,
      saved
    );
    void cacheProgress(currentUser.id, saved).catch(warnCacheFailure("cache listening progress"));
    if (book.deviceBookId) {
      const deviceBook = getDeviceBooks().find((candidate) => candidate.id === book.deviceBookId);
      const serverTrackIndex = book.tracks.findIndex((track) => track.id === saved.trackId);
      const deviceTrack = serverTrackIndex >= 0 ? deviceBook?.tracks[serverTrackIndex] : null;
      if (deviceBook && deviceTrack) {
        saveDeviceProgress(deviceBook.id, {
          ...saved,
          bookId: deviceBook.id,
          trackId: deviceTrack.id
        });
      }
    }
    updateBookProgress(book.id, saved);
  }

  /**
   * Returning to the foreground is the one moment another device's position
   * can be newer without any local signal — the restore effect runs once per
   * book and deliberately never re-fires. Adopt the server's copy only while
   * this session is provably idle: restore finished, playback paused, and no
   * local save queued or in flight. A moving or unsynced session is always
   * authoritative and is left completely alone.
   */
  async function adoptNewerServerProgress() {
    const book = playbackBook;
    const audio = audioRef.current;
    if (
      !book ||
      book.source === "device" ||
      !currentTrack ||
      !audio ||
      restoredProgressBookId.current !== book.id ||
      resumeReconciliationBookIdRef.current === book.id ||
      foregroundAdoptInFlightRef.current ||
      document.visibilityState !== "visible" ||
      (nativeAudio && nativeForegroundSyncGateRef.current.shouldDeferServerAdoption())
    ) {
      return;
    }
    const isPaused = nativeAudio ? !nativePlaybackPlayingRef.current : audio.paused;
    if (!isPaused) {
      return;
    }
    if (queuedProgressSaves.current.size > 0 || progressSaveDrainPromiseRef.current) {
      // The save a pause makes on its way to the background is suspended with
      // the WebView and often lands only after resume. Giving up here lost the
      // handoff for the whole session, and the next Play resumed the stale
      // position. Ask again once the queue settles.
      const pendingGeneration = nativeForegroundSyncGateRef.current.generation;
      void flushProgressSaveQueue().then(() => {
        if (nativeForegroundSyncGateRef.current.generation === pendingGeneration) {
          void foregroundProgressActionsRef.current.adoptNewerServerProgress();
        }
      });
      return;
    }
    const foregroundGeneration = nativeForegroundSyncGateRef.current.generation;
    const actionVersion = playbackActionVersionRef.current;
    const mutationVersion = progressMutationVersion.current;
    const sessionVersion = playbackSessionVersion.current;
    foregroundAdoptInFlightRef.current = true;
    try {
      const server = await getFreshProgress(book).catch(() => null);
      const cached = await getCachedProgress(currentUser.id, book.id).catch(() => null);
      if (
        !server ||
        document.visibilityState !== "visible" ||
        nativeForegroundSyncGateRef.current.generation !== foregroundGeneration ||
        (nativeAudio && nativeForegroundSyncGateRef.current.shouldDeferServerAdoption()) ||
        restoredProgressBookId.current !== book.id ||
        playbackActionVersionRef.current !== actionVersion ||
        progressMutationVersion.current !== mutationVersion ||
        playbackSessionVersion.current !== sessionVersion
      ) {
        return;
      }
      const checkpoint = readProgressCheckpoint(
        window.localStorage,
        getServerStorageKey(),
        currentUser.id,
        book.id
      );
      // A refused save can carry the fresher timestamp — resuming re-stamps an
      // unchanged position — so it is measured by distance alone: the server
      // already vetted its own copy when it refused ours.
      const overruled = overruledSaveRef.current.get(book.id);
      overruledSaveRef.current.delete(book.id);
      const adopted = overruled
        ? saveWasOverruled(overruled, server) ? server : null
        : adoptableServerProgress(freshestProgress(checkpoint, cached), server);
      if (!adopted) return;
      const location = resolveProgressLocation(book.tracks, adopted);
      if (!location) return;
      storeCanonicalServerProgress(book, adopted);
      setCurrentTrackId(location.trackId);
      setPendingSeek(location);
      setPosition(location.positionSeconds);
      setDuration(
        book.tracks.find((track) => track.id === location.trackId)?.durationSeconds ?? 0
      );
    } finally {
      foregroundAdoptInFlightRef.current = false;
      // A later resume may have tried while this obsolete request still held
      // the in-flight guard. Give that handoff a fresh read of the server.
      if (nativeForegroundSyncGateRef.current.generation !== foregroundGeneration) {
        void foregroundProgressActionsRef.current.adoptNewerServerProgress();
      }
    }
  }

  function clearPlaybackSession() {
    // Completion owns the durable final position. Prevent pause/teardown
    // events from following it with a stale media-element clock.
    playbackSessionVersion.current += 1;
    playbackTouchedRef.current = false;
    nativePlaybackPlayingRef.current = false;
    playWhenTrackLoads.current = false;
    wantsAutoplayRef.current = false;
    resumeAutoplayBookIdRef.current = null;
    resumeAutoplayPendingRef.current = false;
    resumeReconciliationBookIdRef.current = null;
    pausePlayback(audioRef.current);
    setPlaybackBookId(null);
    setCurrentTrackId(null);
    setPendingSeek(null);
    setPosition(0);
    setDuration(0);
    setIsPlaying(false);
    setNativePlayerSheet(null);
    setNativePlayerView("now");
    if (native) setNativeTab("shelf");
  }

  async function changeBookCompletion(
    book: Book,
    finished: boolean,
    finalProgress?: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">,
    resetToUnplayed = false
  ) {
    if (completionPendingBookId === book.id) return false;
    setCompletionPendingBookId(book.id);
    setCompletionError(null);
    try {
      const closingActiveBook = playbackBookId === book.id && (finished || resetToUnplayed);
      const reporting = closingActiveBook ? playbackReportRef.current : null;
      if (closingActiveBook || resetToUnplayed) {
        // Freeze playback before any asynchronous reports. Otherwise a slow stop
        // could let a new progress write land after the deliberate completion/reset.
        if (closingActiveBook) {
          playbackTouchedRef.current = false;
          nativePlaybackPlayingRef.current = false;
          pausePlayback(audioRef.current);
          setIsPlaying(false);
        }
        queuedProgressSaves.current.delete(book.id);
        progressSaveAbortController.current?.abort();
        await progressSaveDrainPromiseRef.current;
        queuedProgressSaves.current.delete(book.id);
        // Drain the stop before changing completion. Teardown then has nothing
        // left to report and cannot restore an old media clock after a reset.
        await reporting?.stop();
      }
      const completedProgress: Progress | null = finalProgress
        ? {
            bookId: book.id,
            ...finalProgress,
            updatedAt: new Date().toISOString(),
            finishedOverride: finished
          }
        : null;
      let summary: NonNullable<Book["progress"]>;
      if (book.source === "device") {
        const result = setDeviceBookCompletion(book, finished, finalProgress);
        summary = result.summary;
        writeProgressCheckpoint(
          window.localStorage,
          getServerStorageKey(),
          currentUser.id,
          result.progress
        );
        void cacheProgress(currentUser.id, result.progress).catch(warnCacheFailure("cache listening progress"));
      } else {
        summary = await setBookCompletion(book, finished, finalProgress);
        if (book.deviceBookId) {
          const deviceBook = getDeviceBooks().find(
            (candidate) => candidate.id === book.deviceBookId
          );
          if (deviceBook) {
            const trackIndex = finalProgress
              ? book.tracks.findIndex((track) => track.id === finalProgress.trackId)
              : -1;
            const deviceTrack = trackIndex >= 0 ? deviceBook.tracks[trackIndex] : null;
            setDeviceBookCompletion(
              deviceBook,
              finished,
              finalProgress && deviceTrack
                ? { ...finalProgress, trackId: deviceTrack.id }
                : undefined
            );
          }
        }
      }
      if (completedProgress) {
        progressMutationVersion.current += 1;
        writeProgressCheckpoint(
          window.localStorage,
          getServerStorageKey(),
          currentUser.id,
          completedProgress
        );
        void cacheProgress(currentUser.id, completedProgress).catch(warnCacheFailure("cache listening progress"));
      }

      setBooks((existing) => {
        const next = existing.map((candidate) =>
          candidate.id === book.id ? { ...candidate, progress: summary } : candidate
        );
        if (Capacitor.isNativePlatform()) {
          void cacheLibrary(
            currentUser.id,
            next.filter((candidate) => candidate.source !== "device")
          ).catch(warnCacheFailure("cache the library"));
        }
        return next;
      });
      if (playbackBookIdRef.current === book.id && (finished || resetToUnplayed)) {
        clearPlaybackSession();
      }
      return true;
    } catch (completionFailure) {
      setCompletionError({
        bookId: book.id,
        message: completionFailure instanceof Error
          ? completionFailure.message
          : resetToUnplayed
            ? `Could not mark ${book.title} unplayed.`
            : `Could not mark ${book.title} ${finished ? "finished" : "unfinished"}.`
      });
      return false;
    } finally {
      setCompletionPendingBookId(null);
    }
  }

  function markBookUnplayed(book: Book) {
    const firstTrack = book.tracks[0];
    if (!firstTrack || completionPendingBookId === book.id) return;
    haptic("light");
    setCompletionError(null);
    setUnplayedConfirmationBookId(book.id);
  }

  async function confirmBookUnplayed(book: Book) {
    const firstTrack = book.tracks[0];
    if (!firstTrack || completionPendingBookId === book.id) return;
    haptic("light");
    const changed = await changeBookCompletion(
      book,
      false,
      {
        trackId: firstTrack.id,
        positionSeconds: 0,
        bookPositionSeconds: 0,
        durationSeconds: firstTrack.durationSeconds
      },
      true
    );
    if (changed) setUnplayedConfirmationBookId(null);
  }

  async function downloadForOffline(book: Book) {
    if (!capabilities.downloads) return;
    if (activeDownloadIdsRef.current.has(book.id)) return;
    activeDownloadIdsRef.current.add(book.id);
    const abortController = new AbortController();
    downloadAbortControllersRef.current.set(book.id, abortController);
    if (playbackBook?.id === book.id) {
      persistProgress();
    }
    setDownloadStatus(null);
    setActiveDownloads((existing) => ({
      ...existing,
      [book.id]: { bookId: book.id, title: book.title, fraction: null, state: "queued", queuedAt: Date.now() }
    }));
    try {
      await downloadBookForOffline(book, mediaUrl, (done, total, percent, state) => {
        const fraction = total > 0 ? Math.min(1, (done + (percent ?? 0) / 100) / total) : null;
        setActiveDownloads((existing) => ({
          ...existing,
          [book.id]: {
            bookId: book.id,
            title: book.title,
            fraction,
            state: state === "queued" ? "queued" : "running",
            queuedAt: existing[book.id]?.queuedAt ?? Date.now()
          }
        }));
      }, abortController.signal);
      // The files and the catalogue are one offline feature. Re-persist the
      // current authorized shelf after the transfer so a quick app kill cannot
      // leave durable audio with no metadata from which to render or play it.
      await cacheLibrary(
        currentUser.id,
        booksRef.current.filter((candidate) => candidate.source !== "device")
      );
      setDownloadedBookIds((existing) => new Set(existing).add(book.id));
      setDownloadStatus({ bookId: book.id, message: `${book.title} is available offline` });
    } catch (downloadError) {
      if (abortController.signal.aborted) return;
      setDownloadStatus({
        bookId: book.id,
        message: `${book.title}: ${errorMessage(downloadError, "Download failed.")}`
      });
    } finally {
      if (downloadAbortControllersRef.current.get(book.id) === abortController) {
        downloadAbortControllersRef.current.delete(book.id);
      }
      activeDownloadIdsRef.current.delete(book.id);
      setActiveDownloads((existing) => {
        const next = { ...existing };
        delete next[book.id];
        return next;
      });
    }
  }

  async function cancelOfflineDownload(book: Pick<Book, "id" | "title">) {
    const abortController = downloadAbortControllersRef.current.get(book.id);
    if (!abortController) return;
    abortController.abort();
    setDownloadStatus({ bookId: book.id, message: `${book.title} download cancelled` });
    try {
      await cancelBookOfflineDownload(book);
    } catch (error) {
      setDownloadStatus({
        bookId: book.id,
        message: `${book.title}: ${errorMessage(error, "Could not cancel the download.")}`
      });
    }
  }

  useEffect(() => () => {
    for (const controller of downloadAbortControllersRef.current.values()) controller.abort();
    downloadAbortControllersRef.current.clear();
  }, []);

  async function importFromDevice() {
    setDownloadStatus(null);
    try {
      setDeviceImport({ completed: 0, total: 0 });
      const book = await importAudiobookFromDevice((completed, total) => setDeviceImport({ completed, total }));
      setBooks((existing) => [...existing, book]);
      setDownloadedBookIds((existing) => new Set(existing).add(book.id));
      setSelectedBookId(book.id);
      setPlaybackBookId(book.id);
      setLibrarySource("local");
      setDownloadStatus({ bookId: book.id, message: `${book.title} added from this device` });
      setNativeTab("shelf");
    } catch (error) {
      const message = errorMessage(error, "The audiobook could not be imported.");
      if (!/cancel/i.test(message)) setDownloadStatus({ message });
    } finally {
      setDeviceImport(null);
    }
  }

  async function deleteDeviceBook(book: Book) {
    const deviceBookId = book.deviceBookId ?? book.id;
    if (!window.confirm(`Remove ${book.title} from this device? Your listening progress will be kept.`)) return;
    const removingActiveBook =
      playbackBook?.deviceBookId === deviceBookId || playbackBook?.id === deviceBookId;
    if (removingActiveBook) {
      persistProgress();
    }
    if (removingActiveBook) pausePlayback(audioRef.current);
    await removeDeviceBook(deviceBookId);
    if (removingActiveBook && book.source === "device") clearPlaybackSession();
    await loadBooks();
    setDownloadStatus({ message: "Device copy removed" });
  }

  async function removeOfflineDownload(book: Book) {
    if (!window.confirm(`Remove the downloaded copy of ${book.title} from this device? Your listening progress will be kept.`)) return;
    const removingActiveSource = playbackBook?.id === book.id && !!currentTrack && !!audioRef.current;
    const resumeTrack = removingActiveSource ? currentTrack : null;
    // A seek still queued for this track is the real position; the element
    // reads 0 until its metadata loads, and staging that would replace it.
    const resumePosition = removingActiveSource
      ? Math.max(
          0,
          pendingSeekRef.current?.trackId === currentTrack!.id
            ? pendingSeekRef.current.positionSeconds
            : audioRef.current!.currentTime
        )
      : 0;
    const resumePlayback = removingActiveSource
      ? nativeAudio ? nativePlaybackPlayingRef.current : !audioRef.current!.paused
      : false;
    if (removingActiveSource && resumeTrack) {
      persistProgress();
      pausePlayback(audioRef.current);
      setPendingSeek({ trackId: resumeTrack.id, positionSeconds: resumePosition });
      playWhenTrackLoads.current = resumePlayback;
    }
    await removeBookDownload(book);
    setDownloadedBookIds((existing) => {
      const next = new Set(existing);
      next.delete(book.id);
      return next;
    });
    if (removingActiveSource && resumeTrack) {
      setOfflineSource({ trackId: resumeTrack.id, url: null });
    }
    setDownloadStatus({ bookId: book.id, message: "Download removed" });
  }

  /**
   * Draw the media element's clock without saving it. Returns false while a
   * restored checkpoint is still waiting to be applied, when there is nothing
   * newer than that checkpoint to save.
   */
  function showMediaClock() {
    const audio = audioRef.current;
    if (!audio) {
      return false;
    }
    // AVPlayer can emit its initial 0:00 clock before the pending restored
    // seek reaches the media element. Keep the coherent checkpoint visible.
    const restoring = pendingSeekRef.current;
    if (restoring && restoring.trackId === currentTrackKey) {
      setPosition(restoring.positionSeconds);
      setDuration(Number.isFinite(audio.duration) ? audio.duration : duration);
      return false;
    }
    setPosition(audio.currentTime);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    return true;
  }

  function onTimeUpdate() {
    if (!showMediaClock()) {
      return;
    }
    const now = Date.now();
    if (now - saveStartedAt.current >= PROGRESS_SAVE_INTERVAL_MS) {
      saveStartedAt.current = now;
      void persistProgress();
    }
  }

  // Marks that the listener moved playback in this session (and optionally
  // that the move was a deliberate seek). persistProgress writes nothing
  // until one of these has happened.
  //
  // A seek into a book that is not the one currently playing has to name that
  // book: playbackBook still points at the previous book (or nothing) until
  // the state update lands, and marking the wrong book leaves the jump
  // unflagged — the server would then bill the skipped hours as listening.
  //
  // A deliberate seek also records the whole-book position it aimed at, which
  // is what decides whether its saves may lift the server's reset guard.
  function markPlaybackTouched(
    deliberateSeek = false,
    seekBookId?: string,
    interruptRestore = true,
    seekTargetBookPosition?: number
  ) {
    playbackTouchedRef.current = true;
    const bookId = seekBookId ?? playbackBook?.id ?? null;
    if (interruptRestore) {
      playbackActionVersionRef.current += 1;
      resumeAutoplayPendingRef.current = false;
      if (resumeReconciliationBookIdRef.current === playbackBook?.id) {
        resumeReconciliationBookIdRef.current = null;
      }
      // The listener's action now owns the track and position. Let the stale
      // recovery finish harmlessly, but release persistence and native queue
      // attachment instead of leaving this book behind the recovery gate.
      const resolvedBookId = playbackRestoreBookAfterAction(
        restoredProgressBookId.current,
        bookId,
        true
      );
      restoredProgressBookId.current = resolvedBookId;
      setRestoredPlaybackBookId(resolvedBookId);
    }
    if (deliberateSeek && bookId) {
      intentionalSeekGenerationRef.current.set(
        bookId,
        (intentionalSeekGenerationRef.current.get(bookId) ?? 0) + 1
      );
      if (seekTargetBookPosition !== undefined && Number.isFinite(seekTargetBookPosition)) {
        intentionalSeekTargetRef.current.set(bookId, Math.max(0, seekTargetBookPosition));
      } else {
        intentionalSeekTargetRef.current.delete(bookId);
      }
    }
  }

  /** The whole-book position a track-relative seek on the playing book lands at. */
  function seekTargetInPlaybackBook(trackPosition: number) {
    if (!playbackBook) return undefined;
    return trackOffsetSeconds(playbackBook, activeTrackIndex) + Math.max(0, trackPosition);
  }

  function gainChain() {
    return (gainChainRef.current ??= new PlaybackGainChain());
  }

  /**
   * Route the element through the boost chain, once, when this book actually
   * asks for more than its own level. Unboosted books never touch Web Audio at
   * all, which keeps the ordinary playback path exactly as it was.
   *
   * Called from user gestures wherever possible: an AudioContext first created
   * outside one starts suspended, and a suspended context makes a routed
   * element silent rather than loud.
   */
  function engageGainChain(
    audio: HTMLAudioElement | null | undefined,
    // Read from the ref, not the render: this runs from lock-screen handlers
    // and media events whose closures can predate the current gain.
    gain = playbackGainRef.current
  ) {
    if (!audio || nativeAudio) return;
    if (!gainChain().isAttachedTo(audio)) {
      if (gain <= BOOK_GAIN_DEFAULT) return;
      if (!streamCanBeBoosted(audio.currentSrc || streamUrl)) return;
      if (!gainChain().attach(audio)) return;
    }
    gainChain().resume();
    gainChain().setGain(gain);
    audio.volume = volume;
  }

  /**
   * The device volume, and the book's gain when nothing else can carry it. The
   * element's own volume cannot exceed unity, so this path can only ever cut a
   * loud book down, never lift a quiet one.
   */
  function applyPlaybackVolume(audio: HTMLAudioElement) {
    audio.volume = nativeAudio || gainChain().isAttachedTo(audio)
      ? volume
      : Math.min(1, volume * playbackGain);
  }

  function startPlayback(
    audio: HTMLAudioElement | null | undefined,
    interruptRestore = true
  ) {
    if (!audio) return;
    if (carPlaybackOwnsEngine()) {
      // Play, while the car holds the player, means take it back. The attach
      // effect is parked on that flag, so it has to be cleared first — and the
      // attach it then performs resumes from the checkpoint the car has been
      // keeping current. Starting playback waits for that attach.
      takeOverFromCar();
      window.setTimeout(() => startPlayback(audioRef.current, interruptRestore), 0);
      return;
    }
    markPlaybackTouched(false, undefined, interruptRestore);
    const pendingRequest = {
      bookId: playbackBookIdRef.current,
      cancelGeneration: playCancelGenerationRef.current
    };
    if (nativeAudio ? !nativePlaybackPlayingRef.current : audio.paused) setPlayPending(true);
    // Let the element's `play` event tell an automatic Shelf-Resume start
    // apart from a listener's tap. A rejected start clears it again so the
    // next play event — a real tap — counts as one.
    autoResumePlayEventPendingRef.current = !interruptRestore;
    engageGainChain(audio);
    if (!nativeAudio) {
      audio.play().catch(() => {
        if (!ownsPendingPlay(
          pendingRequest,
          playCancelGenerationRef.current,
          playPendingBookIdRef.current
        )) return;
        autoResumePlayEventPendingRef.current = false;
        setPlayPending(false);
      });
      return;
    }
    void playNativeAudio().catch((error) => {
      if (!ownsPendingPlay(
        pendingRequest,
        playCancelGenerationRef.current,
        playPendingBookIdRef.current
      )) return;
      autoResumePlayEventPendingRef.current = false;
      nativePlaybackPlayingRef.current = false;
      audio.muted = false;
      // This same request is about to continue on web audio. Keep its pending
      // owner, timer, and second-tap cancellation until playback or an error.
      stageWebAudioFallback(audio, true);
      setPlaybackError(errorMessage(error, "Native audio playback failed."));
    });
  }

  function pausePlayback(audio: HTMLAudioElement | null | undefined) {
    setPlayPending(false);
    if (!audio) return;
    // While the car owns the player, the element is all this app controls.
    // Pausing the native player here would stop the driver's book, and this
    // runs on teardown paths that are not a listener asking for a pause.
    if (!nativeAudio || carPlaybackOwnsEngine()) {
      audio.pause();
      return;
    }
    nativePlaybackPlayingRef.current = false;
    setIsPlaying(false);
    void pauseNativeAudio().catch((error) => {
      audio.muted = false;
      stageWebAudioFallback(audio, false);
      setPlaybackError(errorMessage(error, "Native audio playback could not be paused."));
    });
  }

  function stageWebAudioFallback(audio: HTMLAudioElement, resume: boolean, target?: number) {
    if (currentTrackKey) {
      const pending = pendingSeekRef.current;
      setPendingSeek({
        trackId: currentTrackKey,
        positionSeconds: target ?? (pending?.trackId === currentTrackKey
          ? pending.positionSeconds : audio.currentTime)
      });
    }
    // React restores the real media source; its metadata event applies this
    // checkpoint before playing. The native clock itself never fetched audio.
    playWhenTrackLoads.current = resume;
    setNativeAudioFailed(true);
  }

  function setPlaybackPosition(audio: HTMLAudioElement, value: number) {
    const nextPosition = Math.max(0, Math.min(value, audio.duration || value));
    audio.currentTime = nextPosition;
    if (nativeAudio) {
      const shouldResume = nativePlaybackPlayingRef.current;
      void seekNativeAudio(nextPosition).catch((error) => {
        nativePlaybackPlayingRef.current = false;
        audio.muted = false;
        stageWebAudioFallback(audio, shouldResume, nextPosition);
        setPlaybackError(errorMessage(error, "Native audio could not seek."));
      });
    }
    return nextPosition;
  }

  function onLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    setPlaybackError(null);
    audio.playbackRate = speed;
    // A boosted book is routed before it plays, so the lift is there from the
    // first word rather than arriving a beat after playback starts.
    engageGainChain(audio);
    applyPlaybackVolume(audio);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);

    if (
      pendingSeek !== null &&
      pendingSeek.trackId === currentTrackKey &&
      audioSourceMatches(audio, streamUrl)
    ) {
      const restoredPosition = Math.min(
        pendingSeek.positionSeconds,
        audio.duration || pendingSeek.positionSeconds
      );
      if (!nativeAudio || Math.abs(audio.currentTime - restoredPosition) > 0.75) {
        setPlaybackPosition(audio, restoredPosition);
      }
      setPosition(restoredPosition);
      setPendingSeek(null);
    } else if (pendingSeek !== null) {
      // Ignore a late metadata event from the source being replaced. The
      // target track still owns this pending resume position.
      return;
    } else {
      setPosition(audio.currentTime);
    }
    if (playWhenTrackLoads.current) {
      playWhenTrackLoads.current = false;
      startPlayback(audio, !resumeAutoplayPendingRef.current);
      resumeAutoplayPendingRef.current = false;
    }
    if (startupProgressAppliedRef.current) scheduleStartupReveal();
  }

  function seekBy(delta: number) {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    haptic("light");
    // While a seek is still queued the element reads 0 (metadata pending);
    // the queued target is the real position, so move that instead.
    const pending = pendingSeekRef.current;
    const base = pending && pending.trackId === currentTrack?.id
      ? pending.positionSeconds
      : audio.currentTime;
    seekTo(base + delta);
  }

  function seekTo(value: number) {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const pending = pendingSeekRef.current;
    if (pending && currentTrack && pending.trackId === currentTrack.id) {
      const nextPosition = Math.max(
        0,
        Math.min(value, currentTrack.durationSeconds ?? value)
      );
      markPlaybackTouched(true, undefined, true, seekTargetInPlaybackBook(nextPosition));
      setPendingSeek({ trackId: currentTrack.id, positionSeconds: nextPosition });
      setPosition(nextPosition);
      void persistProgress();
      return;
    }
    const clamped = Math.max(0, Math.min(value, audio.duration || value));
    markPlaybackTouched(true, undefined, true, seekTargetInPlaybackBook(clamped));
    const nextPosition = setPlaybackPosition(audio, value);
    setPosition(nextPosition);
    void persistProgress();
  }

  function seekBookPositionInBook(book: Book, value: number, autoPlay = false) {
    const targetBookDuration = book.durationSeconds ?? durationFromTracks(book);
    const clampedValue = Math.max(0, Math.min(value, targetBookDuration || value));
    markPlaybackTouched(true, book.id, true, clampedValue);
    if (playbackBook?.id !== book.id) explicitSessionStartBookIdRef.current = book.id;
    let offset = 0;
    let targetTrack: Track | undefined = book.tracks[0];

    for (const track of book.tracks) {
      const trackDuration = track.durationSeconds ?? 0;
      const nextOffset = offset + Math.max(1, trackDuration);
      targetTrack = track;
      if (clampedValue < nextOffset) {
        break;
      }
      offset += trackDuration;
    }

    if (!targetTrack) {
      return;
    }

    const trackPosition = Math.max(0, clampedValue - offset);
    setPlaybackBookId(book.id);

    if (playbackBook?.id === book.id && targetTrack.id === currentTrack?.id && audioRef.current) {
      const nextPosition = setPlaybackPosition(audioRef.current, trackPosition);
      setPosition(nextPosition);
      void persistProgress();
      if (autoPlay) {
        startPlayback(audioRef.current);
      }
      return;
    }

    setCurrentTrackId(targetTrack.id);
    setPendingSeek({ trackId: targetTrack.id, positionSeconds: trackPosition });
    setPosition(trackPosition);
    playWhenTrackLoads.current = autoPlay;
    wantsAutoplayRef.current = autoPlay;
  }

  function seekBookPosition(value: number, autoPlay = false) {
    if (!playbackBook) {
      return;
    }

    seekBookPositionInBook(playbackBook, value, autoPlay);
  }

  // Start when the active engine has a source. The native control element
  // deliberately has no src; only AVPlayer fetches its stream URL.
  function playWhenReady() {
    const audio = audioRef.current;
    if (nativeAudioQueueReady && hasPlaybackSource(audio, nativeAudio, streamUrl)) {
      startPlayback(audio);
      return;
    }
    wantsAutoplayRef.current = true;
    setPlayPending(true);
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    haptic("medium");
    if (playPendingRef.current) {
      cancelPendingPlayback(audio);
      return;
    }
    // A disk lookup may still be resolving. Native readiness uses the
    // stream URL, never the intentionally absent web element src.
    if (!nativeAudioQueueReady || !hasPlaybackSource(audio, nativeAudio, streamUrl)) {
      wantsAutoplayRef.current = true;
      setPlayPending(true);
      return;
    }
    if (nativeAudio ? !nativePlaybackPlayingRef.current : audio.paused) {
      startPlayback(audio);
    } else {
      pausePlayback(audio);
    }
  }

  function clearPlayPendingForBook(bookId: string | null) {
    if (playbackEventOwnsPendingPlay(
      playPendingRef.current,
      playPendingBookIdRef.current,
      bookId
    )) setPlayPending(false);
  }

  function cancelPendingPlayback(audio: HTMLAudioElement | null | undefined) {
    // Still waiting on the stream: this tap takes the start back. The
    // generation also prevents an async shelf progress check from re-arming it.
    const pendingOwnsActiveBook = playPendingBookIdRef.current === playbackBookIdRef.current;
    playCancelGenerationRef.current += 1;
    wantsAutoplayRef.current = false;
    playWhenTrackLoads.current = false;
    resumeAutoplayPendingRef.current = false;
    if (pendingOwnsActiveBook) pausePlayback(audio);
    else setPlayPending(false);
  }

  // On the web, changing books or returning to Now Playing reshapes the page
  // as one surface, the way the Duo's posture changes do, with the cover
  // carried across. The native shells keep their own navigation motion.
  function withWebViewTransition(update: () => void) {
    const transitionDocument = document as Document & {
      startViewTransition?: (callback: () => void) => unknown;
    };
    if (
      native
      || !transitionDocument.startViewTransition
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      update();
      return;
    }
    transitionDocument.startViewTransition(() => flushSync(update));
  }

  function selectBook(book: Book) {
    if (shelfLayout === "library") changeShelfLayout("split");
    setSelectedBookId(book.id);
    setNativePlayerView(book.id === playbackBook?.id ? "now" : "details");
    if (native) {
      setChaptersOpen(book.id === playbackBook?.id && book.chapters.length > 0);
      setShowChapterJumpTop(false);
      setNativeTab("shelf");
      setNativePlayerView("details");
      playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function openBookDetails(bookId: string) {
    if (shelfLayout === "library") changeShelfLayout("split");
    setSelectedBookId(bookId);
    setNativePlayerView("details");
    if (native) {
      const book = books.find((candidate) => candidate.id === bookId);
      setChaptersOpen(bookId === playbackBook?.id && !!book?.chapters.length);
      setShowChapterJumpTop(false);
      haptic("light");
      setNativeTab("shelf");
      setNativePlayerView("details");
      playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function returnToLibrary() {
    haptic("light");
    setNativePlayerView("now");
  }

  function openNativePlayerSheet(sheet: Exclude<NativePlayerSheet, null>) {
    haptic("light");
    setNativePlayerSheet(sheet);
  }

  function closeNativePlayerSheet() {
    haptic("light");
    setNativePlayerSheet(null);
  }

  function beginBookDetailsBackSwipe(event: React.TouchEvent<HTMLElement>) {
    if (!native || nativeTab !== "shelf" || nativePlayerView !== "details") {
      return;
    }
    const touch = event.touches[0];
    bookDetailsSwipeStartRef.current = touch
      ? { clientX: touch.clientX, clientY: touch.clientY }
      : null;
  }

  function finishBookDetailsBackSwipe(event: React.TouchEvent<HTMLElement>) {
    const start = bookDetailsSwipeStartRef.current;
    bookDetailsSwipeStartRef.current = null;
    const touch = event.changedTouches[0];
    if (
      native
      && nativeTab === "shelf"
      && nativePlayerView === "details"
      && start
      && touch
      && isLeftEdgeBackSwipe(start, touch)
    ) {
      returnToLibrary();
    }
  }

  function openPlaybackView(view: "now" | "details" | "chapters") {
    if (shelfLayout === "library") changeShelfLayout("split");
    if (playbackBook) {
      setSelectedBookId(playbackBook.id);
    }
    setNativeTab("reading");
    setNativePlayerView(view);
    if (view === "chapters") {
      setChaptersOpen(true);
    }
    playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }

  function selectTrack(track: Track, autoPlay = true) {
    void persistProgress();
    const targetBook = selectedBook ?? playbackBook;
    markPlaybackTouched(
      true,
      targetBook?.id,
      true,
      targetBook
        ? trackOffsetSeconds(targetBook, targetBook.tracks.findIndex((candidate) => candidate.id === track.id))
        : undefined
    );
    if (selectedBook && playbackBook?.id !== selectedBook.id) {
      explicitSessionStartBookIdRef.current = selectedBook.id;
    }
    setNativePlayerView("now");
    if (native) {
      setNativeTab("reading");
    }
    if (
      selectedBook?.id === playbackBook?.id &&
      track.id === currentTrack?.id &&
      audioRef.current
    ) {
      setPlaybackPosition(audioRef.current, 0);
      setPosition(0);
      if (autoPlay) {
        startPlayback(audioRef.current);
      }
      return;
    }
    if (selectedBook) {
      setPlaybackBookId(selectedBook.id);
    }
    setCurrentTrackId(track.id);
    setPendingSeek({ trackId: track.id, positionSeconds: 0 });
    setPosition(0);
    playWhenTrackLoads.current = autoPlay;
    wantsAutoplayRef.current = autoPlay;
  }

  /**
   * The shelf's primary action. Its label already promises the right thing —
   * "Resume · 6h 32m left" — and the handler has to agree. Starting the first
   * track marks a deliberate session start, which suppresses the restore
   * effect, so every in-progress book reopened at the opening credits. A
   * resume instead hands the book to that effect, which reconciles the native,
   * checkpoint, cached, listed and server copies before seeking.
   */
  async function playSelectedBook(book: Book) {
    haptic("medium");
    if (playPendingRef.current) {
      const pendingBookId = playPendingBookIdRef.current;
      cancelPendingPlayback(audioRef.current);
      // A second activation of the same shelf action is cancellation. A tap
      // on another book replaces the old pending request in one action.
      if (pendingBookId === book.id) return;
    }
    const cancelGeneration = playCancelGenerationRef.current;
    setPlayPending(true, book.id);
    if (!shouldResumeSavedPosition(book.progress)) {
      // The listing summary can lag the server (a cached shelf, a session on
      // another device since the last refresh). Before "Begin this reading"
      // writes a near-zero position with a deliberate seek attached — which
      // the server would honour — ask for the live copy, briefly. Offline or
      // unanswered, the summary stands as before.
      const inProgressElsewhere = await freshProgressBeforeStartingOver(book);
      if (playCancelGenerationRef.current !== cancelGeneration) return;
      if (inProgressElsewhere) {
        updateBookProgress(book.id, inProgressElsewhere);
        resumeSelectedBook(book);
        return;
      }
      // "Read it again" on a finished book, or one never opened: track one.
      if (book.tracks[0]) selectTrack(book.tracks[0]);
      else setPlayPending(false);
      return;
    }
    resumeSelectedBook(book);
  }

  async function freshProgressBeforeStartingOver(book: Book): Promise<Progress | null> {
    if (
      book.source === "device" ||
      localMode ||
      isOffline ||
      book.progress?.status === "finished"
    ) {
      return null;
    }
    try {
      const server = await getFreshProgress(book, START_OVER_PROGRESS_CHECK_MS);
      if (!server) return null;
      const summary = summarizeBookProgress(book, server);
      return summary?.status === "inProgress"
        && server.bookPositionSeconds > PROGRESS_RESET_GUARD_SECONDS
        ? server
        : null;
    } catch {
      return null;
    }
  }

  function resumeSelectedBook(book: Book) {
    setNativePlayerView("now");
    if (native) {
      setNativeTab("reading");
    }
    if (playbackBook?.id === book.id) {
      // Already restored in this session — its live position is authoritative.
      playWhenReady();
      return;
    }
    void persistProgress();
    // Deliberately no explicit session start, no pending seek, and no autoplay
    // flag yet: the restore effect owns all three. Arming autoplay here would
    // start the first track — `currentTrack` falls back to track one while the
    // restored id is still resolving — which is the very thing being fixed.
    resumeAutoplayBookIdRef.current = book.id;
    setPlayPending(true, book.id);
    setPlaybackBookId(book.id);
  }

  function jumpToChapter(chapter: Chapter) {
    if (!selectedBook) {
      return;
    }

    haptic("light");
    void persistProgress();
    seekBookPositionInBook(selectedBook, chapter.startSeconds, true);
    if (native) {
      setNativeTab("reading");
      setNativePlayerView("now");
      playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function jumpToChapterFromSheet(chapter: Chapter) {
    if (!playbackBook) {
      return;
    }
    haptic("light");
    void persistProgress();
    setSelectedBookId(playbackBook.id);
    seekBookPositionInBook(playbackBook, chapter.startSeconds, true);
    setNativePlayerSheet(null);
  }

  function restartOrPreviousChapter() {
    if (!playbackBook || !activeChapter) {
      seekBy(-15);
      return;
    }
    const index = chapterSegments.findIndex((chapter) => chapter.id === activeChapter.id);
    const target = chapterElapsed > 5 || index <= 0
      ? activeChapter
      : chapterSegments[index - 1];
    haptic("light");
    seekBookPositionInBook(playbackBook, target.startSeconds, true);
  }

  function nextChapter() {
    if (!playbackBook || !activeChapter) {
      seekBy(30);
      return;
    }
    const index = chapterSegments.findIndex((chapter) => chapter.id === activeChapter.id);
    const target = chapterSegments[index + 1];
    if (target) {
      haptic("light");
      seekBookPositionInBook(playbackBook, target.startSeconds, true);
    }
  }

  function playNextTrack() {
    // `ended` also fires when a stream is cut short (a truncated response, a
    // proxy giving up). Advancing on that — or finishing the book on its last
    // track — would file unheard time as listened. Stop where the clock is.
    // Only the element's own duration is trusted here: the catalogue's tag
    // estimate can run minutes long and would stop every track "early".
    const endedAudio = audioRef.current;
    if (
      endedAudio &&
      currentTrack &&
      endedShortOfTrack(endedAudio.currentTime, endedAudio.duration)
    ) {
      playWhenTrackLoads.current = false;
      wantsAutoplayRef.current = false;
      pausePlayback(endedAudio);
      setIsPlaying(false);
      void persistProgress();
      setPlaybackError("Playback stopped early; the file may be incomplete.");
      return;
    }
    if (!playbackBook || activeTrackIndex >= playbackBook.tracks.length - 1) {
      playWhenTrackLoads.current = false;
      setPlayPending(false);
      setIsPlaying(false);
      if (playbackBook && currentTrack) {
        const mediaDuration = audioRef.current?.duration;
        const finalTrackPosition = Math.max(
          0,
          currentTrack.durationSeconds
            ?? (Number.isFinite(mediaDuration) ? mediaDuration! : position)
        );
        void changeBookCompletion(playbackBook, true, {
          trackId: currentTrack.id,
          positionSeconds: finalTrackPosition,
          bookPositionSeconds:
            trackOffsetSeconds(playbackBook, activeTrackIndex) + finalTrackPosition,
          durationSeconds: currentTrack.durationSeconds ?? (Number.isFinite(mediaDuration) ? mediaDuration! : null)
        });
      }
      return;
    }
    void persistProgress();
    playWhenTrackLoads.current = true;
    wantsAutoplayRef.current = true;
    setCurrentTrackId(playbackBook.tracks[activeTrackIndex + 1].id);
    const nextTrack = playbackBook.tracks[activeTrackIndex + 1];
    setPendingSeek({ trackId: nextTrack.id, positionSeconds: 0 });
    setPosition(0);
  }

  function scrollToPlayer() {
    if (native) {
      haptic("light");
      openPlaybackView("now");
      return;
    }
    withWebViewTransition(() => {
      if (playbackBook) {
        setSelectedBookId(playbackBook.id);
      }
      setNativePlayerView("now");
    });
    playerPaneRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handlePlayerPaneScroll(event: React.UIEvent<HTMLElement>) {
    if (!native || nativeTab !== "shelf" || nativePlayerView !== "details" || !chaptersOpen || !isViewingPlayingBook) {
      if (showChapterJumpTop) setShowChapterJumpTop(false);
      return;
    }
    const sectionTop = trackListSectionRef.current?.offsetTop ?? Number.POSITIVE_INFINITY;
    const threshold = sectionTop + 140;
    const shouldShow = event.currentTarget.scrollTop > threshold;
    if (shouldShow !== showChapterJumpTop) setShowChapterJumpTop(shouldShow);
  }

  function jumpToPlayerTop() {
    haptic("light");
    playerPaneRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setShowChapterJumpTop(false);
  }

  function updateSpeed(value: number) {
    const normalized = normalizePlaybackSpeed(value);
    setSpeed(normalized);
    writeStoredSpeed(normalized);
  }

  function updateBookGain(book: Book, db: number) {
    const gain = bookGainFromDb(db);
    setBookGains((existing) => {
      const next = { ...existing };
      if (gain === BOOK_GAIN_DEFAULT) delete next[book.id];
      else next[book.id] = gain;
      writeStoredBookGains(currentUser.id, next);
      return next;
    });
    if (book.id === playbackBookId) {
      // This runs inside the slider's own gesture, which is the moment an
      // AudioContext is allowed to start. The new gain has to be passed in:
      // the state update behind it has not been applied to this closure yet,
      // so the very first boost would otherwise decline to build the chain.
      engageGainChain(audioRef.current, gain);
    }
    // Device books exist only on this phone, so there is no server row to sync.
    if (book.source !== "device") {
      // Guards the book against a library payload older than this adjustment,
      // and holds it until the server echoes the value back. Clearing the guard
      // when the PUT settles would be too early: a getBooks() issued before the
      // write can still answer after it, carrying the old gain. A write that
      // never landed keeps the guard and is re-sent once the server answers
      // again — see createBookGainSync.
      gainSyncRef.current?.write(book.id, gain);
    }
  }

  function showYourLibrary() {
    setLibrarySource("local");
  }

  function openNativeTab(tab: NativeTab) {
    if (tab === "games" && !gamesEnabled) return;
    haptic("light");
    // Re-tapping the active Shelf tab is an escape hatch from the Audible
    // catalogue back to the listener's own library.
    if (tab === "shelf" && nativeTab === "shelf" && librarySource !== "local") {
      showYourLibrary();
    }
    // Reading belongs to the playing book. A book browsed from the shelf stays
    // selected after its details page closes and must not follow into the tab.
    if (tab === "reading") {
      if (shelfLayout === "library") changeShelfLayout("split");
      if (playbackBook) setSelectedBookId(playbackBook.id);
    }
    setNativeTab(tab);
    if (tab === "reading" || tab === "shelf") setNativePlayerView("now");
  }

  function toggleGamesEnabled() {
    const enabled = !gamesEnabled;
    writeGamesEnabled(enabled);
    setGamesEnabled(enabled);
    if (!enabled && nativeTab === "games") setNativeTab("shelf");
  }

  async function refreshLibrary() {
    setIsLoading(true);
    if (localMode) {
      await loadBooks();
      return;
    }
    try {
      const nextBooks = isOperaLibre && !currentUser.isAdmin
        ? await getBooks()
        : await rescanLibrary();
      const visibleBooks = native
        ? mergeDeviceAndServerBooks(nextBooks, getDeviceBooks())
        : nextBooks;
      setBooks(visibleBooks);
      reconcileServerBookGains(nextBooks);
      setIsOffline(false);
      setSelectedBookId((existing) =>
        resolveBookId(visibleBooks, existing ?? readStoredBookId(currentUser.id, "selectedBookId"))
      );
      // As in loadBooks: a listing that calls the playing book finished must
      // not pull the session out from under the listener.
      const isPlayingNow = nativeAudio
        ? nativePlaybackPlayingRef.current
        : !!audioRef.current && !audioRef.current.paused;
      setPlaybackBookId((existing) =>
        resolveActivePlaybackBookId(
          visibleBooks,
          existing ?? readStoredBookId(currentUser.id, "playbackBookId"),
          isPlayingNow
        )
      );
      setError(null);
    } catch (refreshError) {
      if (isServerNotReadyError(refreshError)) {
        // Up but still scanning: loadBooks keeps asking until it publishes.
        setIsOffline(false);
        setError("The server is still loading its library. The shelf refreshes once it is ready.");
        void loadBooks();
        return;
      }
      // A rescan rejected by a reachable server is not "offline" — only
      // mute non-downloaded books when the server can't be reached at all.
      setIsOffline(isNetworkError(refreshError));
      setError("Library rescan failed.");
    } finally {
      setIsLoading(false);
    }
  }

  function applyAdminLibraryChange(nextBooks: Book[]) {
    const visibleBooks = native
      ? mergeDeviceAndServerBooks(nextBooks, getDeviceBooks())
      : nextBooks;
    setBooks(visibleBooks);
    reconcileServerBookGains(nextBooks);
    setSelectedBookId((existing) => resolveBookId(visibleBooks, existing));
    // Decided outside the state updater: updaters can run more than once and
    // must stay pure, and the teardown below has to save first.
    const isPlayingNow = nativeAudio
      ? nativePlaybackPlayingRef.current
      : !!audioRef.current && !audioRef.current.paused;
    const currentPlaybackBookId = playbackBookIdRef.current;
    const nextPlaybackBookId = resolveActivePlaybackBookId(visibleBooks, currentPlaybackBookId, isPlayingNow);
    if (currentPlaybackBookId && !nextPlaybackBookId) {
      pausePlayback(audioRef.current);
      setCurrentTrackId(null);
      setPosition(0);
      if (native) setNativeTab("shelf");
    }
    playbackBookIdRef.current = nextPlaybackBookId;
    setPlaybackBookId(nextPlaybackBookId);
    if (libationBooksLoaded) void loadLibationBooks();
  }

  async function prepareForAdminLibraryMutation() {
    pausePlayback(audioRef.current);
    await persistProgress();
    await flushProgressSaveQueue();
  }

  const showLedgerTab = native && capabilities.statistics;
  const iosTabs = nativeTabItems(gamesEnabled, showLedgerTab,
    currentUser.isAdmin ? brokenLibationAccounts.length : 0);
  const [chrome, setChrome] = useState<string | undefined>(undefined);
  const [barTint, setBarTint] = useState<string | undefined>(undefined);
  // The tab class carries the screen's colors, and the appearance switch flips
  // the palette on the document, so watch both for the tones UIKit should hold.
  useEffect(() => {
    if (!native) return;
    const read = () => {
      setChrome(nativeShellColor(shellRef.current, "--native-chrome"));
      setBarTint(nativeShellColor(shellRef.current, "--native-bar"));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [native, nativeTab, shelfLayout]);
  const { ready: nativeTabsReady, shown: nativeTabsShown } = useNativeTabs({
    tabs: iosTabs,
    selected: nativeTabSelection(nativeTab, iosTabs),
    visible: !readalongOpen || readerClosing,
    appearance: appearanceMode,
    chrome,
    bar: barTint
  }, openNativeTab);
  useEffect(() => {
    if (!readerClosing || (nativeTabsReady && !nativeTabsShown)) return;
    setReaderClosing(false);
    setReadalongOpen(false);
  }, [nativeTabsReady, nativeTabsShown, readerClosing, setReadalongOpen, setReaderClosing]);

  const refreshShelf = useCallback(async () => {
    if (librarySource === "all") {
      await refreshPurchaseSources([
        ...(libroAccounts?.length ? [async () => {
          try { await (libroOnDevice ? refreshLibroDevice() : refreshLibroAccount()); }
          finally { setLibroRefreshKey(key => key + 1); }
        }] : []),
        ...(canBrowseLibation ? [loadLibationBooks] : [])
      ]);
    } else if (librarySource === "audible") {
      await loadLibationBooks();
    } else if (librarySource === "libro") {
      await (libroOnDevice ? refreshLibroDevice() : refreshLibroAccount());
      setLibroRefreshKey(key => key + 1);
    } else {
      await loadBooks();
    }
  }, [librarySource, libroOnDevice, libroAccounts, canBrowseLibation, loadBooks, loadLibationBooks, setLibroRefreshKey]);
  const shelfPull = usePullToRefresh(native, refreshShelf);
  const hasMiniPlayer = Boolean(playbackBook && currentTrack);

  useEffect(() => {
    const shell = shellRef.current;
    const player = miniPlayerRef.current;
    if (!native || !shell || !player) {
      shell?.style.removeProperty("--mini-player-height");
      return;
    }

    const updatePlayerHeight = () => {
      const height = Math.ceil(player.getBoundingClientRect().height);
      // Reading hides the mini-player. Retain the last non-zero measurement so
      // Shelf has the right clearance on the first frame after switching back.
      if (height > 0) shell.style.setProperty("--mini-player-height", `${height}px`);
    };
    updatePlayerHeight();
    const observer = new ResizeObserver(updatePlayerHeight);
    observer.observe(player);
    return () => {
      observer.disconnect();
      shell.style.removeProperty("--mini-player-height");
    };
  }, [hasMiniPlayer, native]);

  const userMenu = (
    <div className="user-menu" role="menu">
      <div className="user-menu-head">
        <strong>{currentUser.username}</strong>
        <span>
          {isOperaLibre
            ? localMode ? "On-device library" : demoMode ? "On-device demo" : currentUser.isOwner ? "Owner" : currentUser.isAdmin ? "Administrator" : "Reader"
            : currentUser.isAdmin ? "Jellyfin administrator" : "Jellyfin account"}
        </span>
      </div>
      {capabilities.statistics ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setUserMenuOpen(false);
            if (native) {
              openNativeTab("ledger");
            } else {
              setProfileOpen(true);
            }
          }}
        >
          <ScrollText size={14} /> Reader's ledger
        </button>
      ) : null}
      {capabilities.administration ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setUserMenuOpen(false);
            if (native) {
              openNativeTab("admin");
            } else {
              setUsersModalOpen(true);
            }
          }}
        >
          <UserCog size={14} /> Administration
        </button>
      ) : null}
      {capabilities.administration && brokenLibationAccounts.length > 0 ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setUserMenuOpen(false);
            setLibrarySource("audible");
            setLibraryOpen(true);
            if (native) openNativeTab("shelf");
          }}
        >
          <AlertCircle size={14} /> Audible accounts ({brokenLibationAccounts.length})
        </button>
      ) : null}
      {capabilities.readingFiles ? (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={readalongEnabled}
          onClick={toggleReadalongEnabled}
        >
          <BookOpen size={14} /> Ebook reader: {readalongEnabled ? "On" : "Off"} (beta)
        </button>
      ) : null}
      {readalongEnabled && sentenceFollowAvailable ? (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={followSyncEnabled}
          onClick={toggleFollowSyncEnabled}
          title="Experimental: the highlight can drift and may move the page to match the audio."
        >
          <LocateFixed size={14} /> Follow narration: {followSyncEnabled ? "On" : "Off"} (experimental)
        </button>
      ) : null}
      {!native && readalongEnabled && sentenceFollowAvailable && followSyncEnabled ? (
        <div className="user-menu-follow-aggressiveness" role="group" aria-labelledby="menu-follow-aggressiveness-label">
          <div>
            <label id="menu-follow-aggressiveness-label" htmlFor="menu-follow-aggressiveness">
              Aggressiveness
            </label>
            <output htmlFor="menu-follow-aggressiveness">
              {FOLLOW_AGGRESSIVENESS_LABELS[followAggressiveness]}
            </output>
          </div>
          <input
            id="menu-follow-aggressiveness"
            type="range"
            min="0"
            max="2"
            step="1"
            value={followAggressiveness}
            style={{ "--scrub-progress": `${followAggressiveness * 50}%` } as CSSProperties}
            aria-valuetext={FOLLOW_AGGRESSIVENESS_LABELS[followAggressiveness]}
            onChange={(event) => updateFollowAggressiveness(Number(event.currentTarget.value) as FollowAggressiveness)}
          />
          <small>Current timing <span>A little ahead</span></small>
        </div>
      ) : null}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          setUserMenuOpen(false);
          if (localMode) pausePlayback(audioRef.current);
          void onLogout();
        }}
      >
        <LogOut size={14} /> {localMode ? "Leave local mode" : "Sign out"}
      </button>
    </div>
  );

  // Sync actions and notices, shared by the inline panel header and the
  // full-screen reader's appearance sheet.
  //
  // A job belongs to one book, so only that book's reader shows its progress;
  // the poll above keeps following it either way.
  const syncJobForBook =
    syncJob && selectedBook && syncJob.targetId === selectedBook.id ? syncJob : null;
  const syncJobRunning = !!syncJobForBook && ["queued", "running"].includes(syncJobForBook.status);
  const syncProgressPercent = (() => {
    const fraction = syncJobForBook?.progress?.fraction;
    return typeof fraction === "number" && Number.isFinite(fraction)
      ? Math.min(100, Math.max(0, Math.round(fraction * 100)))
      : null;
  })();
  const syncElapsedSeconds = (() => {
    if (syncJobForBook?.status !== "running") return null;
    const startedAt = Number(syncJobForBook.runningAt ?? syncJobForBook.startedAt);
    return Number.isFinite(startedAt) && startedAt > 0
      ? Math.max(0, (Date.now() - startedAt) / 1000)
      : null;
  })();
  // Alignment runs at a fairly steady pace, so what it has done so far
  // predicts the rest well enough to be worth saying — once there is enough of
  // both to divide by.
  const syncRemainingLabel = (() => {
    const fraction = syncJobForBook?.progress?.fraction ?? null;
    if (
      syncJobForBook?.status !== "running"
      || fraction === null
      || fraction < 0.05
      || syncElapsedSeconds === null
      || syncElapsedSeconds < 60
    ) {
      return null;
    }
    return formatDurationLabel((syncElapsedSeconds * (1 - fraction)) / fraction);
  })();
  const syncProgressNote = [
    syncElapsedSeconds !== null && syncElapsedSeconds >= 60
      ? `${formatDurationLabel(syncElapsedSeconds)} so far`
      : null,
    syncRemainingLabel ? `about ${syncRemainingLabel} left` : null,
    "keeps running if you close the reader"
  ]
    .filter(Boolean)
    .join(" · ");
  const readerSyncActions = selectedBook ? (
    <>
      {canGenerateSync && activeCompanionIsBook ? (
        <button
          type="button"
          className="download-btn"
          disabled={syncJobRunning}
          onClick={() => void requestSyncGeneration(selectedBook)}
          title={
            selectedSyncPrecise
              ? "Regenerate the narration sync map"
              : "Align the narration to the text for sentence-exact highlighting"
          }
        >
          {syncJobRunning ? (
            <LoaderCircle size={13} className="spin-icon" />
          ) : (
            <Sparkles size={13} />
          )}
          <span>{selectedSyncPrecise ? "Re-sync" : "Improve sync"}</span>
        </button>
      ) : null}
    </>
  ) : null;
  const readerSyncMessages = (
    <>
      {canGenerateSync && activeCompanionIsBook && !syncJobRunning ? (
        <p className="readalong-synchint">
          {selectedSyncPrecise
            ? "This book is aligned sentence by sentence against its narration. Re-sync rebuilds that map from the audio and the text — worth doing when either file has been replaced."
            : "This book has no alignment yet, so the reader only opens to the chapter being played. Improve sync listens to the narration on the server and matches it to the text sentence by sentence, so the highlight lands on the sentence being read. It runs in the background for everyone on this server and can take a long while on a full-length book."}
        </p>
      ) : null}
      {syncJobForBook && syncJobRunning ? (
        <div className="sync-progress" role="status" aria-live="polite">
          <div className="sync-progress-head">
            <span className="sync-progress-step">
              {syncJobForBook.status === "queued"
                ? "Waiting for another sync to finish"
                : syncJobForBook.progress?.step ?? "Aligning the narration to the text"}
            </span>
            {syncProgressPercent !== null ? (
              <span className="sync-progress-percent">{syncProgressPercent}%</span>
            ) : null}
          </div>
          <div
            className="sync-progress-track"
            role="progressbar"
            aria-label="Sync generation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={syncProgressPercent ?? undefined}
            aria-valuetext={
              syncProgressPercent === null
                ? "Starting"
                : `${syncProgressPercent}% aligned`
            }
          >
            {/* Nothing to measure yet: a sliding bar says "working" without
                claiming a position the job has not reported. */}
            <div
              className={syncProgressPercent === null ? "sync-progress-fill waiting" : "sync-progress-fill"}
              style={syncProgressPercent === null ? undefined : { width: `${syncProgressPercent}%` }}
            />
          </div>
          <div className="sync-progress-note">{syncProgressNote}</div>
        </div>
      ) : syncJobForBook && syncJobForBook.status === "failed" ? (
        <div className="readalong-genstatus error">
          {syncJobForBook.error ?? "Readalong sync generation failed."}
        </div>
      ) : null}
      {syncJobError ? <div className="readalong-genstatus error">{syncJobError}</div> : null}
      {syncNotice ? <div className="readalong-genstatus notice">{syncNotice}</div> : null}

    </>
  );
  const companionTabs =
    selectedCompanionList.length + (galleryAvailable ? 1 : 0) > 1 ? (
      <div className="readalong-tabs" role="tablist" aria-label="Companion files">
        {selectedCompanionList.map((companion) => {
          const selected = !showGallery && activeCompanion?.id === companion.id;
          return (
            <button
              type="button"
              role="tab"
              key={companion.id}
              aria-selected={selected}
              className={selected ? "selected" : ""}
              onClick={() => setActiveCompanionId(companion.id)}
              title={describeCompanion(companion)}
            >
              {companion.kind === "book" ? <BookOpen size={12} /> : <FileText size={12} />}
              <span>{companionKindLabel(companion)}</span>
              <small>{companion.fileName}</small>
            </button>
          );
        })}
        {galleryAvailable ? (
          <button
            type="button"
            role="tab"
            aria-selected={showGallery}
            className={showGallery ? "selected" : ""}
            onClick={() => setActiveCompanionId(GALLERY_COMPANION_ID)}
          >
            <Images size={12} />
            <span>Pictures</span>
            <small>{selectedCompanionGroups.images.length}</small>
          </button>
        ) : null}
      </div>
    ) : null;
  const epubReaderElement =
    selectedBook && activeCompanion && activeCompanionUrl && activeCompanion.extension === "epub" && !showGallery ? (
      <EpubReadalong
        key={`${readerScope}:${selectedBook.id}:${activeCompanion.id}`}
        bookId={selectedBook.id}
        storageScope={readerScope}
        title={selectedBook.title}
        url={activeCompanionUrl}
        listeningChapter={activeCompanionIsBook
          ? (isViewingPlayingBook ? activeChapter?.title : chapterAtBookPosition(selectedChapterSegments, selectedBook.progress?.bookPositionSeconds ?? 0)?.title) ?? null
          : null}
        loadSource={(companionUrl, signal) =>
          loadEpubSource(selectedBook, activeCompanion, companionUrl, signal)
        }
        loadCachedSource={(signal) => getCachedEpubBytes(selectedBook, activeCompanion, signal)}
        loadWholeFile={(companionUrl, signal) =>
          loadCompanionBytes(selectedBook, activeCompanion, companionUrl, signal)
        }
        syncTarget={
          readalongEnabled && activeCompanionIsBook && !(narrationFollowActive && selectedSyncFragments) && isViewingPlayingBook && activeChapter
            ? activeChapter
            : null
        }
        syncFragments={narrationFollowActive && activeCompanionIsBook ? selectedSyncFragments : null}
        positionSeconds={narrationFollowActive && isViewingPlayingBook ? bookPosition : 0}
        followLeadSeconds={FOLLOW_AGGRESSIVENESS_LEAD_SECONDS[followAggressiveness]}
        onSeekTo={
          narrationFollowActive
            ? (seconds) => seekBookPositionInBook(selectedBook, seconds, true)
            : undefined
        }
        immersive={native}
        onClose={closeReadalong}
        chapterTitle={isViewingPlayingBook ? activeChapter?.title ?? null : null}
        positionLabel={
          isViewingPlayingBook
            ? formatTime(activeChapter ? Math.max(0, displayBookPosition - activeChapter.startSeconds) : displayBookPosition)
            : null
        }
        playback={
          isViewingPlayingBook
            ? {
                playing: isPlaying,
                speed,
                sleepRemaining,
                onToggle: togglePlayback,
                onSkip: seekBy,
                onOpen: openNativePlayerSheet
              }
            : null
        }
        onListen={isViewingPlayingBook ? undefined : () => playSelectedBook(selectedBook)}
        syncTools={
          narrationFollowActive && (readerSyncActions || readerSyncMessages) ? (
            <>
              <div className="epub-sheet-row">{readerSyncActions}</div>
              {readerSyncMessages}
            </>
          ) : null
        }
        companionSwitcher={companionTabs}
      />
    ) : null;
  // The native ebook reader is a full-screen layer of its own; everything
  // else (extras, pictures, the web reader) lives in the inline panel.
  const immersiveEpub = native && !!epubReaderElement;

  const readalongPanelElement =
    readalongOpen && selectedBook && (activeCompanion || showGallery) ? immersiveEpub ? (
      // Mount once UIKit has removed the tab bar, so the book lays out a
      // single time at full screen instead of again as the web view grows.
      nativeTabsReady && nativeTabsShown ? null : epubReaderElement
    ) : (
      <section
        className="readalong-panel"
        aria-label={`${selectedBook.title} read along`}
        ref={readalongPanelRef}
      >
        <div className="readalong-header">
          <div>
            <span className="section-label">
              {showGallery ? <Images size={13} /> : <BookOpen size={13} />}{" "}
              {showGallery ? "Pictures" : activeCompanion?.kind === "supplement" ? "Extras" : "Read along"}
            </span>
            <strong>
              {showGallery
                ? `${selectedCompanionGroups.images.length} ${selectedCompanionGroups.images.length === 1 ? "picture" : "pictures"}`
                : activeCompanion?.fileName}
            </strong>
            <span className="readalong-mode">
              {showGallery
                ? "Loose pictures found beside the audio"
                : activeCompanion
                  ? `${activeCompanionIsBook && selectedReadAlongMode ? `${READ_ALONG_MODE_LABELS[selectedReadAlongMode].title} · ` : ""}${describeCompanion(activeCompanion)}`
                  : null}
            </span>
          </div>
          <div className="readalong-actions">
            {narrationFollowActive ? readerSyncActions : null}
            {activeCompanionUrl && !showGallery ? (
              <a className="download-btn" href={activeCompanion ? companionPreviewUrl(activeCompanion) : undefined} target="_blank" rel="noreferrer">
                <ExternalLink size={13} />
                <span>Open</span>
              </a>
            ) : null}
            <button type="button" className="download-btn" onClick={closeReadalong} aria-label="Close the reader">
              <X size={13} />
              <span>Close</span>
            </button>
          </div>
        </div>
        {companionTabs}
        {narrationFollowActive ? readerSyncMessages : null}
        {showGallery ? (
          <div className="readalong-gallery">
            {selectedCompanionGroups.images.map((image) => (
              <a key={image.id} href={companionPreviewUrl(image)} target="_blank" rel="noreferrer">
                <img src={companionPreviewUrl(image)} alt={image.fileName} loading="lazy" />
                <span>{image.fileName}</span>
              </a>
            ))}
          </div>
        ) : epubReaderElement ? (
          epubReaderElement
        ) : activeCompanion && activeCompanionUrl && canPreviewCompanion(activeCompanion.extension) ? (
          <iframe
            className="readalong-frame"
            src={companionPreviewUrl(activeCompanion)}
            title={`${selectedBook.title} ${activeCompanion.kind === "supplement" ? "extras" : "readalong"}`}
            sandbox=""
            referrerPolicy="no-referrer"
          />
        ) : activeCompanion ? (
          <div className="readalong-fallback">
            <ScrollText size={36} strokeWidth={1.4} />
            <p>
              {activeCompanion.extension.toUpperCase()} files are available to open, but this browser
              cannot preview them inline yet.
            </p>
          </div>
        ) : null}
        {activeChapter && !showGallery ? (
          <div className="readalong-sync">
            <span>{activeChapter.title}</span>
            <span>{formatTime(displayBookPosition)}</span>
          </div>
        ) : null}
      </section>
    ) : null;

  const audibleManagement = (
    <div className={native ? "store-settings-body audible-settings-body" : "purchase-console-body"}>
      <p className="settings-hint">Add or reconnect Audible accounts in Libation. OperaLibre uses those connections to refresh purchases.</p>
      {libationStatus?.accounts.length ? <div className="account-list">
        {libationStatus.accounts.map((account) => <article key={account.id} className={account.authenticated ? "ok" : "warn"}>
          <span className="account-health-icon">{account.authenticated ? <KeyRound size={13} /> : <AlertCircle size={13} />}</span>
          <span className="account-list-copy">
            <strong>{account.name || account.accountId}</strong>
            <small>{account.locale.toUpperCase()}{account.authenticated ? " · Connected" : account.connectionState === "error" ? " · Connection error" : " · Sign-in required"}</small>
            {!account.authenticated && account.lastError ? <em>{account.lastError}</em> : null}
          </span>
        </article>)}
      </div> : null}
      {native && libationError ? <p className="settings-hint settings-error" role="alert">{libationError}</p> : null}
      <div className="store-settings-actions">
        <button type="button" className="download-btn" onClick={() => void startLibationSync()} aria-busy={isRefreshingAudible} disabled={!libationStatus?.enabled || libationLoading || libationRefreshPending || !!refreshLibationJob}>
          {isRefreshingAudible ? <LoaderCircle size={13} className="spin-icon" /> : <RefreshCcw size={13} />}
          <span>{isRefreshingAudible ? "Refreshing purchases" : "Refresh purchases"}</span>
        </button>
        {currentUser.isAdmin && currentUser.libationAccess === "direct" ? <button type="button" className="download-btn" onClick={() => void startAllLiberation()} aria-busy={libationAllPending || !!downloadAllLibationJob} disabled={!libationStatus?.enabled || libationLoading || libationAllPending || !!downloadAllLibationJob}>
          {libationAllPending || downloadAllLibationJob ? <LoaderCircle size={13} className="spin-icon" /> : <Download size={13} />}
          <span>{libationAllPending || downloadAllLibationJob ? "Downloading purchases" : "Download all purchases"}</span>
        </button> : null}
      </div>
      <p className="settings-hint">{libationStatus?.autoRefreshHours ? `Checks automatically every ${libationStatus.autoRefreshHours} hours.` : "Refresh manually to check for new purchases."}</p>
    </div>
  );

  return (
    <main
      ref={shellRef}
      className={
        native
          ? `shell native-shell tab-${nativeTab} shelf-${shelfLayout}${ipad ? " device-ipad" : ""}${shelfLandscape ? " shelf-landscape" : ""}${shelfFolded ? " shelf-folded" : ""}${nativeTab === "games" ? ` games-${activeGame}` : ""}${nativeTab === "shelf" && nativePlayerView === "details" ? " library-book-open" : ""}${hasMiniPlayer ? " has-mini-player" : ""}`
          : `shell web-shell player-view-${nativePlayerView}`
      }
    >
      {!startupViewReady ? <NativeLaunchPlaceholder /> : null}
      {native ? <div className="ios-status-veil" aria-hidden="true" /> : null}
      {native && ipad && (nativeTab === "shelf" || nativeTab === "reading") && shelfLayout === "player" ? (
        <button
          type="button"
          className="shelf-reveal-button"
          aria-label="Show the shelf"
          onClick={() => {
            haptic("light");
            changeShelfLayout("split");
          }}
        >
          <PanelLeftOpen size={17} />
          <span>Shelf</span>
        </button>
      ) : null}
      <audio
        key={currentTrackKey ?? "no-track"}
        ref={audioRef}
        src={nativeAudio ? undefined : streamUrl || undefined}
        muted={nativeAudio}
        preload={nativeAudio ? "none" : "metadata"}
        onLoadedMetadata={onLoadedMetadata}
        onError={() => {
          const code = audioRef.current?.error?.code;
          const message = code === MediaError.MEDIA_ERR_DECODE
            ? "This audio file could not be decoded."
            : code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
              ? isOperaLibre ? "This audio format is not supported on this device." : "This device cannot play the original Jellyfin audio file. Try an MP3 or AAC version; automatic conversion is not available."
              : code === MediaError.MEDIA_ERR_NETWORK
                ? "Playback lost its connection to the audiobook server."
                : "This audio track could not be loaded.";
          setIsPlaying(false);
          clearPlayPendingForBook(playbackBookId);
          setPlaybackError(message);
          // The element keeps paused=false after a media error, so the
          // toggle read "playing" and needed two taps. On iOS the element is
          // only the control clock and its own errors say nothing about
          // AVPlayer, so it is left alone there.
          const failed = audioRef.current;
          if (!nativeAudio && failed && !failed.paused) {
            // If metadata never arrived the clock reads 0; stage the shown
            // position so the pause save carries something coherent.
            if (
              failed.readyState < HTMLMediaElement.HAVE_METADATA &&
              !pendingSeekRef.current &&
              currentTrackKey
            ) {
              setPendingSeek({ trackId: currentTrackKey, positionSeconds: position });
            }
            failed.pause();
          }
        }}
        onTimeUpdate={onTimeUpdate}
        onPlay={() => {
          // Playback can also start natively (lock screen, CarPlay) without
          // going through startPlayback; real listening must always count as
          // touched or its progress would never be persisted. Only the
          // automatic Shelf-Resume start (flagged by startPlayback) is kept
          // from counting as a listener action, so a /progress reply that
          // lands after loadedmetadata can still correct the position.
          const automaticResume = autoResumePlayEventPendingRef.current;
          autoResumePlayEventPendingRef.current = false;
          markPlaybackTouched(false, undefined, !automaticResume);
          engageGainChain(audioRef.current);
          if (nativeAudio) {
            nativePlaybackPlayingRef.current = true;
            // Native's synthetic play event reflects AVPlayer already playing.
            clearPlayPendingForBook(playbackBookId);
          }
          setPlaybackError(null);
          setIsPlaying(true);
        }}
        // Web media emits `play` as soon as paused becomes false; `playing`
        // is the point buffering has ended and audible playback actually began.
        onPlaying={() => clearPlayPendingForBook(playbackBookId)}
        onPause={() => {
          // Anything that plays after a pause is a fresh action, never the
          // automatic resume that flag was armed for.
          autoResumePlayEventPendingRef.current = false;
          if (nativeAudio) nativePlaybackPlayingRef.current = false;
          setIsPlaying(false);
          void persistProgress();
        }}
        onEnded={playNextTrack}
      />

      <button
        type="button"
        className={`library-scrim ${libraryOpen ? "show" : ""}`}
        aria-label="Close library"
        aria-hidden={!libraryOpen}
        tabIndex={-1}
        onClick={() => setLibraryOpen(false)}
      />

      <aside className={`library-pane ${libraryOpen ? "open" : ""} ${librarySource !== "local" ? "purchase-browsing" : ""}`} {...shelfPull.handlers}>
        {native ? (
          <div
            className={`pull-indicator ${shelfPull.refreshing ? "refreshing" : ""}`}
            style={
              shelfPull.refreshing
                ? undefined
                : {
                    opacity: Math.min(1, shelfPull.pull / PULL_REFRESH_THRESHOLD),
                    transform: `translateX(-50%) rotate(${Math.round(shelfPull.pull * 2.8)}deg)`
                  }
            }
            aria-hidden="true"
          >
            <RefreshCcw size={17} strokeWidth={2} />
          </div>
        ) : null}
        <div className="pane-title">
          <div>
            <span className="eyebrow"><Library size={13} /> The Collection</span>
            <h1>OperaLibre</h1>
          </div>
          {native && ipad ? (
            <div className="shelf-layout-controls" role="group" aria-label="Shelf layout">
              {shelfLayout === "library" ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Show the player beside the shelf"
                  title="Show the player"
                  onClick={() => {
                    haptic("light");
                    changeShelfLayout("split");
                  }}
                >
                  <Minimize2 size={16} />
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Hide the shelf"
                    title="Hide the shelf"
                    onClick={() => {
                      haptic("light");
                      changeShelfLayout("player");
                    }}
                  >
                    <PanelLeftClose size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Expand the shelf to full screen"
                    title="Expand the shelf"
                    onClick={() => {
                      haptic("light");
                      changeShelfLayout("library");
                    }}
                  >
                    <Maximize2 size={16} />
                  </button>
                </>
              )}
            </div>
          ) : null}
          <div className="pane-actions">
            {native ? (
              <button
                className="icon-button"
                aria-label="Add audiobook from device"
                disabled={deviceImport !== null}
                onClick={() => void importFromDevice()}
              >
                {deviceImport ? <LoaderCircle size={16} className="spin-icon" /> : <FolderOpen size={16} />}
              </button>
            ) : null}
            {capabilities.uploads ? (
              <button
                className="icon-button"
                aria-label="Upload audiobook"
                onClick={() => {
                  setUploadError(null);
                  setUploadModalOpen(true);
                }}
              >
                <Upload size={16} />
              </button>
            ) : null}
            {finishFeedAvailable ? (
              <div className="finish-feed-wrap">
                <button
                  className="icon-button finish-feed-button"
                  aria-label={
                    finishFeed.unseenCount > 0
                      ? `Shared reading, ${finishFeed.unseenCount} new`
                      : "Shared reading"
                  }
                  aria-expanded={finishFeedOpen}
                  onClick={toggleFinishFeed}
                >
                  <Bell size={16} />
                  {finishFeed.unseenCount > 0 ? (
                    <span className="finish-feed-badge" aria-hidden="true">
                      {finishFeed.unseenCount > 9 ? "9+" : finishFeed.unseenCount}
                    </span>
                  ) : null}
                </button>
                {finishFeedOpen ? (
                  <div className="finish-feed-panel" role="dialog" aria-label="Shared reading">
                    <header>
                      <strong>Shared reading</strong>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Close shared reading"
                        onClick={() => setFinishFeedOpen(false)}
                      >
                        <X size={14} />
                      </button>
                    </header>
                    {finishFeed.entries.length === 0 ? (
                      <p className="finish-feed-empty">
                        Nobody has finished a book yet. When someone does, it shows up here.
                      </p>
                    ) : (
                      <ul>
                        {finishFeed.entries.map((entry) => (
                          <li key={entry.id} className={entry.unseen ? "unseen" : ""}>
                            <button
                              type="button"
                              onClick={() => {
                                const book = books.find((candidate) => candidate.id === entry.bookId);
                                if (book) {
                                  selectBook(book);
                                  setLibraryOpen(false);
                                }
                                setFinishFeedOpen(false);
                              }}
                            >
                              <span className="finish-feed-text">{finishAnnouncement(entry)}</span>
                              <span className="finish-feed-when">
                                {finishedAgoLabel(entry.finishedAt)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
            <button
              className="icon-button"
              aria-label={capabilities.administration ? "Rescan library" : "Refresh library"}
              onClick={() => void refreshLibrary()}
            >
              <RefreshCcw size={16} />
            </button>
            <div className="user-menu-wrap">
              <button
                className="icon-button"
                aria-label="Account menu"
                aria-expanded={userMenuOpen}
                onClick={() => setUserMenuOpen((open) => !open)}
              >
                <span className="user-avatar">{currentUser.username.slice(0, 1).toUpperCase()}</span>
              </button>
              {userMenuOpen
                ? native
                  ? createPortal(
                      <div className="user-menu-layer">
                        <button
                          type="button"
                          className="user-menu-scrim"
                          aria-label="Close menu"
                          onClick={() => setUserMenuOpen(false)}
                        />
                        {userMenu}
                      </div>,
                      document.body
                    )
                  : userMenu
                : null}
            </div>
            <button
              className="icon-button library-close"
              aria-label="Close library"
              onClick={() => setLibraryOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="library-toolbar">
          {!demoMode && libroAvailable ? (
            <>
              <div className="source-toggle shelf-navigation" role="group" aria-label="Library navigation">
                <button type="button" className={librarySource === "local" ? "selected" : ""} onClick={showYourLibrary} aria-pressed={librarySource === "local"}>
                  <Library size={16} /> Library
                </button>
                <button type="button" className={librarySource !== "local" ? "selected" : ""} onClick={() => setLibrarySource(lastPurchaseSource.current === "audible" && !canBrowseLibation ? "libro" : lastPurchaseSource.current)} aria-pressed={librarySource !== "local"}>
                  <Cloud size={16} /> Get books
                  {currentUser.isAdmin && brokenLibationAccounts.length > 0 ? <span className="source-health-badge" aria-label={`${brokenLibationAccounts.length} Audible accounts need attention`}>{brokenLibationAccounts.length}</span> : null}
                </button>
              </div>
              {librarySource !== "local" ? (
                <>
                <div className="purchase-source">
                  <div className="purchase-tabs" role="tablist" aria-label="Book stores">
                    {(["all", "libro", ...(canBrowseLibation ? ["audible"] : [])] as LibrarySource[]).map(source => (
                      <button key={source} id={`purchase-tab-${source}`} type="button" role="tab"
                        aria-selected={librarySource === source} aria-controls="purchase-results"
                        tabIndex={librarySource === source ? 0 : -1}
                        onClick={() => { setAudibleAccountFilter("all"); setPurchaseAccountFilter("all"); setLibrarySource(source); }}
                        onKeyDown={event => {
                          const tabs = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
                          const index = tabs.indexOf(event.currentTarget);
                          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
                            : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                            : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
                          if (next < 0) return;
                          event.preventDefault();
                          tabs[next].focus();
                          tabs[next].click();
                        }}>
                        {source === "all" ? "All accounts" : source === "libro" ? "Libro.fm" : "Audible"}
                        {source === "audible" && brokenLibationAccounts.length > 0 ? <span className="source-health-badge" aria-label={`${brokenLibationAccounts.length} accounts need attention`}>{brokenLibationAccounts.length}</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
              </>
              ) : null}
            </>
          ) : null}
          <div className="library-search-row">
            <div className="library-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                ref={shelfSearchRef}
                placeholder={librarySource === "local" ? "Search books, authors, tags…" : librarySource === "libro" ? "Search Libro.fm purchases…" : librarySource === "all" ? "Search all purchases…" : "Search Audible titles…"}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
                aria-label="Search library"
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="library-search-clear"
                  aria-label="Clear search"
                  onClick={() => { setSearchQuery(""); shelfSearchRef.current?.focus(); }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {showShelfFilters ? (
              <button
                type="button"
                ref={filterToggleRef}
                className={`library-filter-toggle ${filtersOpen ? "open" : ""} ${activeShelfFilterCount > 0 ? "engaged" : ""}`}
                onClick={() => setFiltersOpen(!filtersOpen)}
                aria-expanded={filtersOpen}
                aria-controls="library-filter-panel"
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
                <span>Filters</span>
                {activeShelfFilterCount > 0 ? <em>{activeShelfFilterCount}</em> : null}
              </button>
            ) : null}
          </div>

          <div className="library-controls">
            <label className="library-sort">
              <span>Sort by</span>
              <select
                value={sortMode}
                onChange={(event) => selectSortMode(event.currentTarget.value as SortMode)}
                aria-label="Sort library by"
              >
                {SORT_OPTIONS.filter((option) => isSortModeSupported(librarySource, option.value)).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="library-sort-direction"
              onClick={reverseSort}
              aria-label={`Reverse sort order (currently ${sortOrderLabel})`}
              title={`Reverse sort order · ${sortOrderLabel}`}
              aria-pressed={sortReversed}
            >
              {sortReversed ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
            </button>
            <div className="view-toggle" role="group" aria-label={librarySource === "local" ? "View mode" : "Purchase view mode"}>
              {SHELF_VIEW_MODE_OPTIONS.map((option) => {
                const Icon = option.value === "list" ? List : option.value === "compact" ? Rows3 : LayoutGrid;
                const activeViewMode = librarySource === "local" ? viewMode : purchaseViewMode;
                return (
                  <button
                    type="button"
                    key={option.value}
                    className={activeViewMode === option.value ? "selected" : ""}
                    onClick={() => librarySource === "local" ? selectViewMode(option.value) : selectPurchaseViewMode(option.value)}
                    aria-label={option.label}
                    title={option.value === "compact" ? "Compact view · more books per screen" : option.label}
                    aria-pressed={activeViewMode === option.value}
                  >
                    <Icon size={14} />
                  </button>
                );
              })}
            </div>
          </div>

          {showShelfFilters && filtersOpen ? (
            <section
              className="library-filters"
              id="library-filter-panel"
              aria-label="Library filters"
              onKeyDown={(event) => {
                if (event.key === "Escape") { event.stopPropagation(); closeShelfFilters(); }
              }}
            >
              <div className="library-filters-heading">
                <strong>Find your next listen</strong>
                <button type="button" className="library-clear-filters" onClick={closeShelfFilters}>Done</button>
              </div>
              <div className="library-filters-body">
                <div className="shelf-facet shelf-facet-status">
                  <div className="shelf-facet-heading">
                    <span className="shelf-facet-title">Progress</span>
                  </div>
                  <div className="shelf-status-row" role="group" aria-label="Filter by reading progress">
                    {SHELF_STATUS_OPTIONS.map((option) => {
                      const isSelected = shelfFilters.status === option.value;
                      const count = shelfFacets.statusCounts[option.value];
                      return (
                        <button
                          type="button"
                          key={option.value}
                          className={isSelected ? "selected" : ""}
                          aria-pressed={isSelected}
                          disabled={count === 0 && !isSelected}
                          onClick={() => setShelfFilters({ ...shelfFilters, status: option.value })}
                        >
                          <span>{option.label}</span>
                          <em>{count}</em>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="shelf-facet shelf-facet-availability">
                  <div className="shelf-facet-heading">
                    <span className="shelf-facet-title">Availability</span>
                  </div>
                  <div className="shelf-facet-chips" role="group" aria-label="Filter by availability">
                    <button
                      type="button"
                      className={`facet-chip ${shelfFilters.downloadedOnly ? "selected" : ""}`}
                      aria-pressed={shelfFilters.downloadedOnly}
                      disabled={shelfFacets.downloadedCount === 0 && !shelfFilters.downloadedOnly}
                      onClick={() => setShelfFilters({
                        ...shelfFilters,
                        downloadedOnly: !shelfFilters.downloadedOnly
                      })}
                    >
                      <span className="facet-chip-label">Downloaded on Device</span>
                      <em>{shelfFacets.downloadedCount}</em>
                    </button>
                  </div>
                </div>

                <div className="shelf-facet-groups">
                  <ShelfFacetGroup
                    title="Genres"
                    hint="No genres on this shelf yet. Add them when you edit a book’s details."
                    options={shelfFacets.genres}
                    selected={shelfFilters.genres}
                    onToggle={(key) => setShelfFilters(toggleShelfFacet(shelfFilters, "genres", key))}
                  />
                  <ShelfFacetGroup
                    title="Tags"
                    hint="No tags on this shelf yet. Tag books to gather a wider world or reading order."
                    options={shelfFacets.tags}
                    selected={shelfFilters.tags}
                    onToggle={(key) => setShelfFilters(toggleShelfFacet(shelfFilters, "tags", key))}
                  />
                </div>
                <p className="shelf-facet-hint">Choose any in each group. Combine groups to narrow your shelf.</p>
              </div>
            </section>
          ) : null}

          {showShelfFilters && activeShelfFilterCount > 0 ? (
            <div className="library-active-filters">
              <span className="library-active-filters-caption">Filtering</span>
              {activeShelfFilterChips.map((chip) => (
                <button
                  type="button"
                  key={chip.id}
                  className="active-filter-chip"
                  onClick={chip.clear}
                  aria-label={`Remove ${chip.caption.toLowerCase()} filter ${chip.label}`}
                >
                  <span className="active-filter-caption">{chip.caption}</span>
                  <span className="active-filter-label">{chip.label}</span>
                  <X size={11} strokeWidth={2.5} aria-hidden="true" />
                </button>
              ))}
              <button type="button" className="library-clear-filters" onClick={clearShelfFilters}>
                Clear all
              </button>
            </div>
          ) : null}

          {librarySource !== "libro" && librarySource !== "all" ? <div className="library-results-summary" role="status" aria-live="polite" aria-atomic="true">
            <span>
              {librarySource === "local"
                ? isLoading ? "Loading books…" : `${visibleBooks.length} of ${books.length} books`
                : libationLoading ? "Loading books…" : `${visibleLibationBooks.length} of ${libationBooks.length} books`}
            </span>
            <span>{sortOrderLabel}</span>
          </div> : null}

        </div>

        {carPlaybackBook ? (
          <section className="carplay-banner">
            <div className="carplay-banner-copy">
              <strong>Audiobook playing</strong>
              <span>{carPlaybackBook.title}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                takeOverFromCar();
                resumeSelectedBook(carPlaybackBook);
              }}
            >
              Open player
            </button>
          </section>
        ) : null}

        <div id="purchase-results" className="purchase-results" role={librarySource !== "local" ? "tabpanel" : undefined} aria-labelledby={librarySource !== "local" ? `purchase-tab-${librarySource}` : undefined}>
        <div className="purchase-settings-pane">
        {!native && showAudiblePurchases && canBrowseLibation ? (
          <details className="purchase-console">
            <summary><span>Audible accounts &amp; downloads</span><ChevronDown size={15} /></summary>
            {audibleManagement}
          </details>
        ) : null}
        {librarySource === "all" ? <label className="purchase-account-filter">
          <span className="purchase-control-label">Account</span>
          <select aria-label="Purchase account" value={purchaseAccountFilter} onChange={event => setPurchaseAccountFilter(event.target.value)}>
            <option value="all">All accounts</option>
            {canBrowseLibation && allAudibleAccounts.length > 0 ? <optgroup label="Audible">{allAudibleAccounts.map(account => <option key={account.id} value={`audible:${account.id}`}>Audible · {account.name}</option>)}</optgroup> : null}
            {(libroAccounts?.length ?? 0) > 0 ? <optgroup label="Libro.fm">{libroAccounts!.map(account => <option key={account.email} value={`libro:${account.email}`}>Libro.fm · {account.nickname || account.email}</option>)}</optgroup> : null}
          </select>
        </label> : null}
        {librarySource === "audible" && allAudibleAccounts.length > 1 ? <label className="purchase-account-filter">
          <span className="purchase-control-label">Account</span>
          <select aria-label="Audible account" value={audibleAccountFilter} onChange={event => setAudibleAccountFilter(event.currentTarget.value)}>
            <option value="all">All Audible accounts</option>
            {allAudibleAccounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label> : null}
        {showAudiblePurchases && (displayedLibationJobs.length > 0 || libationMessage || brokenLibationAccounts.length > 0) ? (
          <details className="purchase-console">
            <summary>
              <span><CloudDownload size={14} /> Activity</span>
              <strong>{displayedLibationJobs.some(isPendingJob) ? "Working" : brokenLibationAccounts.length > 0 ? "Needs attention" : "Up to date"}</strong>
              <ChevronDown size={15} />
            </summary>
            <div className="purchase-console-body">
              {libationMessage ? <p role="status">{libationMessage}</p> : null}
              {native && brokenLibationAccounts.length > 0 ? <button type="button" className="purchase-settings-link" onClick={() => openNativeTab("settings")}>
                <AlertCircle size={14} /> {brokenLibationAccounts.length} Audible account{brokenLibationAccounts.length === 1 ? " needs" : "s need"} attention <ChevronRight size={14} />
              </button> : null}
              {displayedLibationJobs.map((job) => {
              const targetTitle = job.targetId
                ? libationBooks.find((book) => book.catalogId === job.targetId)?.title
                : null;
              return (
              <details key={job.id} className={`job-card audible-job ${job.status}`}>
                <summary className="job-card-head">
                  <span className="job-state">
                    {job.status === "queued" ? (
                      <List size={13} />
                    ) : job.status === "running" ? (
                      <LoaderCircle size={13} className="spin-icon" />
                    ) : job.status === "failed" ? (
                      <AlertCircle size={13} />
                    ) : (
                      <CloudDownload size={13} />
                    )}
                    {jobStateLabel(job)}
                  </span>
                  <strong>{targetTitle ?? (job.kind === "libation-sync" && job.status === "completed" ? "Library refreshed" : jobTitle(job))}</strong>
                  <ChevronDown size={15} />
                </summary>
                <p>{jobSummary(job)}</p>
                <dl className="job-meta">
                  <div>
                    <dt>Elapsed</dt>
                    <dd>{formatElapsed(job.startedAt, job.finishedAt) ?? "Starting"}</dd>
                  </div>
                  {job.exitCode !== null ? (
                    <div>
                      <dt>Exit</dt>
                      <dd>{job.exitCode}</dd>
                    </div>
                  ) : null}
                </dl>
                {!isPendingJob(job) || job.error ? (
                  <pre className="job-output">{jobDetailLines(job).join("\n")}</pre>
                ) : null}
              </details>
              );
              })}
            </div>
          </details>
        ) : null}

        </div>
        <div className="purchase-books-pane">

        {librarySource === "libro" || librarySource === "all" ? (
          <LibroCatalog key={`${currentUser.id}:${libroOnDevice ? "device" : "server"}`} mode={native ? "catalog" : "full"} polling={!native || nativeTab === "shelf"} onOpenSettings={native ? () => openNativeTab("settings") : undefined} onAccountsChanged={setLibroAccounts} filterEmail={librarySource === "all" ? (purchaseAccountFilter.startsWith("libro:") ? purchaseAccountFilter.slice(6) : null) : undefined} hidden={librarySource === "all" && purchaseAccountFilter.startsWith("audible:")} device={libroOnDevice} refreshKey={libroRefreshKey} searchQuery={searchQuery} sortMode={sortMode} reversed={sortReversed} viewMode={purchaseViewMode} onBooksChanged={libroOnDevice ? () => setBooks(current => mergeDeviceAndServerBooks(current.filter(book => book.source !== "device"), getDeviceBooks())) : applyAdminLibraryChange} onOpenBook={(id) => { showYourLibrary(); openBookDetails(id); }} />
        ) : null}

        {librarySource === "local" ? (
          <>
            {localMode && !connectPromptDismissed && !hasUserConfiguredServer() ? (
              <section className="connect-server-card" aria-label="Connect a server">
                <span className="section-label"><Network size={13} /> Listening from this device</span>
                <p>
                  Everything here stays on this device — no server or account needed.
                  When your OperaLibre or Jellyfin server is ready, connect it to
                  stream a shared library and sync your progress.
                </p>
                <a
                  className="connect-server-guide"
                  href={SERVER_SETUP_GUIDE_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={12} aria-hidden="true" />
                  <span>New to OperaLibre? Read the server setup guide</span>
                </a>
                <div className="connect-server-actions">
                  <button
                    type="button"
                    className="download-btn"
                    onClick={() => {
                      pausePlayback(audioRef.current);
                      onConnectServer();
                    }}
                  >
                    <Network size={13} />
                    <span>Connect a server</span>
                  </button>
                  <button
                    type="button"
                    className="connect-server-dismiss"
                    onClick={() => {
                      writeStoredValue(CONNECT_PROMPT_DISMISSED_KEY, "true");
                      setConnectPromptDismissed(true);
                    }}
                  >
                    Maybe later
                  </button>
                </div>
              </section>
            ) : null}
            {isLoading ? <div className="empty-state">Loading library…</div> : null}
            {error ? <div className="empty-state error">{error}</div> : null}
            {!isLoading && !error && books.length === 0 ? (
              <div className="empty-state device-empty-state">
                <span>{localMode ? "Your shelf is ready. Pick audiobook files from this device to start listening." : !isOperaLibre ? "No audiobooks are available to this account. Add audiobooks to a Books library in Jellyfin and check this account’s library access. Music libraries are not included." : "No audiobooks found in the configured library folder."}</span>
                {native ? (
                  <button type="button" className="download-btn" onClick={() => void importFromDevice()}>
                    <FolderOpen size={14} /> Choose audiobook files
                  </button>
                ) : null}
              </div>
            ) : null}
            {!isLoading && !error && books.length > 0 && visibleBooks.length === 0 ? (
              <div className="empty-state shelf-empty-state">
                <span>
                  {searchQuery.trim()
                    ? `Nothing matches “${searchQuery.trim()}”${activeShelfFilterCount > 0 ? " under these filters" : ""}.`
                    : "No books match these filters."}
                </span>
                {activeShelfFilterCount > 0 ? (
                  <button type="button" className="library-clear-filters" onClick={clearShelfFilters}>
                    Clear filters
                  </button>
                ) : null}
                {searchQuery ? (
                  <button type="button" className="library-clear-filters" onClick={() => setSearchQuery("")}>
                    Clear search
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* Compact keeps the list layout and only tightens it, so it carries
                both classes rather than forking every row rule. */}
            <ShelfBookList
              columns={visibleBookColumns}
              viewMode={viewMode}
              sortMode={sortMode}
              shelfTags={shelfFilters.tags}
              selectedBookId={selectedBook?.id ?? null}
              playbackBookId={playbackBook?.id ?? null}
              downloadedBookIds={downloadedBookIds}
              isOffline={isOffline}
              demoMode={demoMode}
              localMode={localMode}
              native={native}
              readalongEnabled={readalongEnabled}
              onSelectBook={selectFromShelf}
            />
          </>
        ) : showAudiblePurchases ? (
          <>
            {librarySource === "all" ? <h2 className="purchase-provider-heading">Audible</h2> : null}
            {libationLoading || (libationStatus?.enabled && !libationBooksLoaded) ? (
              <div className="empty-state">Loading Audible library…</div>
            ) : null}
            {libationError ? <div className="empty-state error">{libationError}</div> : null}
            {!libationLoading && !libationError && libationBooksLoaded && libationStatus?.enabled && visibleLibationBooks.length === 0 ? (
              <div className="empty-state">No Libation books loaded yet.</div>
            ) : null}

            <div className={`audible-list purchase-book-list purchase-book-list--${purchaseViewMode} audible-list--${purchaseViewMode}`}>
              {visibleLibationBooks.map((book) => {
                const isLocal = !!book.localBookId;
                const downloadRequest = libationDownloadRequests.find(
                  (request) => (request.catalogId ? request.catalogId === book.catalogId : request.profileId ? `${request.profileId}:${request.asin}` === book.catalogId : request.asin === book.asin) && request.status !== "rejected"
                );
                const isAwaitingApproval = downloadRequest?.status === "pending";
                const isApprovedRequest = downloadRequest?.status === "approved" && !!downloadRequest.jobId;
                const pendingDownloadJob =
                  pendingLibationJobs.find(
                    (job) => job.kind === "libation-liberate" && job.targetId === book.catalogId
                  ) ?? downloadAllLibationJob;
                const latestBookJob = libationJobs.find(
                  (job) => job.kind === "libation-liberate" && job.targetId === book.catalogId
                );
                const isStarting = libationAllPending || libationRequests.has(book.catalogId);
                const isQueued = pendingDownloadJob?.status === "queued";
                const isDownloading = pendingDownloadJob?.status === "running";
                const finalizationFailed = libationFinalizationFailures.has(book.catalogId);
                const isFinalizing = isLibationAdding({
                  isLocal,
                  confirmationPending: libationFinalizingAsins.has(book.catalogId),
                  confirmationFailed: finalizationFailed
                });
                const didFail = latestBookJob?.status === "failed" || finalizationFailed;
                const metaParts = [
                  book.authors,
                  formatMinutes(book.lengthMinutes),
                  isLocal ? "In library" : book.bookStatus
                ].filter(Boolean);
                return (
                  <div key={book.catalogId} className={`audible-row purchase-book-row ${isLocal ? "is-local" : ""}`}>
                    <LibationCoverArt book={book} />
                    <div className="audible-copy">
                      <strong>{book.title}</strong>
                      <span>{metaParts.join(" · ")}</span>
                      <small className="audible-account-badge"><span className="purchase-provider-tag">Audible</span><KeyRound size={10} /> {audibleAccountLabels.get(book.profileId) ?? book.profileName}</small>
                    </div>
                    {isLocal ? (
                      <button
                        type="button"
                        className="local-marker"
                        aria-label={`Open ${book.title} from your library`}
                        onClick={() => {
                          if (!book.localBookId) {
                            return;
                          }
                          openBookDetails(book.localBookId);
                          setLibrarySource("local");
                          setLibraryOpen(false);
                        }}
                      >
                        <CircleCheck size={14} />
                        <span>In library</span>
                      </button>
                    ) : isAwaitingApproval ? (
                      <span className="audible-download-status queued" role="status" aria-label={`Requested ${book.title}`}>
                        <List size={14} />
                        <span>Requested</span>
                      </span>
                    ) : isStarting || isQueued || isDownloading || isFinalizing || (isApprovedRequest && !finalizationFailed) ? (
                      <span
                        className={`audible-download-status ${
                          isQueued ? "queued" : isDownloading ? "downloading" : isFinalizing || isApprovedRequest ? "finalizing" : "starting"
                        }`}
                        role="status"
                        aria-label={`${
                          isQueued ? "Queued" : isDownloading ? "Downloading" : isFinalizing || isApprovedRequest ? "Adding to library" : "Starting download"
                        } ${book.title}`}
                      >
                        {isQueued ? <List size={14} /> : <LoaderCircle size={14} className="spin-icon" />}
                        <span>{isQueued ? "Queued" : isDownloading ? "Downloading" : isFinalizing || isApprovedRequest ? "Adding" : "Starting"}</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={`audible-download-action ${didFail ? "retry" : ""}`}
                        aria-label={`${didFail ? "Retry" : currentUser.libationAccess === "approval" ? "Request" : "Download"} ${book.title}`}
                        onClick={() => void startLiberation(book)}
                      >
                        <CloudDownload size={14} />
                        <span>{didFail ? "Retry" : currentUser.libationAccess === "approval" ? "Request" : "Download"}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
        </div>
        </div>
      </aside>

      <section
        className={`player-pane native-player-view-${nativePlayerView} ${
          isViewingPlayingBook && currentTrack ? "has-native-player" : ""
        } ${showReaderInNowView ? "has-reader" : ""} ${
          nativeTab === "reading" && usesFoldLayout(playbackFold) && playbackFold.fold?.axis === "horizontal"
            ? "" : "fit-playback"
        }`}
        ref={playerPaneRef}
        onScroll={handlePlayerPaneScroll}
        onTouchStart={beginBookDetailsBackSwipe}
        onTouchEnd={finishBookDetailsBackSwipe}
        onTouchCancel={() => { bookDetailsSwipeStartRef.current = null; }}
      >
        <button
          type="button"
          className="library-open-btn"
          aria-label="Open library"
          onClick={() => setLibraryOpen(true)}
        >
          <Library size={16} />
          <span>Library</span>
        </button>
        {/* The details view stands on its own: every block that needs a live
            track is already gated on `isViewingPlayingBook`, so a book opened
            from the shelf with nothing playing renders its preview + "Begin
            this reading" instead of falling through to the empty player. The
            empty player stays for the "now" view, which has nothing to show
            until playback starts. */}
        {selectedBook && (currentTrack || nativePlayerView !== "now") ? (
          <>
            {isViewingPlayingBook && nativePlayerView === "now" && nowPlayingBook && currentTrack ? (
              <section className={`native-now-playing ${showReaderInNowView ? "has-reader" : ""}`} aria-label="Now playing">
                {/* The halves group the stack for a foldable phone, which sets
                    them either side of its fold. Everywhere else they take no
                    box and their children lay out in the card's grid. */}
                <div className="native-now-half native-now-lead">
                  <div className="native-now-artwork">
                    <CoverArt book={nowPlayingBook} size="large" />
                  </div>

                  <div className="native-now-copy">
                    <span className="native-now-kicker">
                      {activeChapter ? `Chapter ${activeChapter.chapterNumber}` : "Now playing"}
                    </span>
                    <h2>{activeChapter?.title ?? currentTrack.title}</h2>
                    <p>{nowPlayingBook.title}</p>
                    <span>{nowPlayingBook.author ?? currentTrack.metadata.album ?? "Audiobook"}</span>
                  </div>
                </div>

                <div className="native-now-half native-now-controls">
                  <div className="native-now-timeline">
                    <ScrubSlider
                      ariaLabel={activeChapter ? `Playback position in ${activeChapter.title}` : "Playback position"}
                      max={activeChapter ? chapterDuration : Math.max(1, sliderMax)}
                      value={activeChapter ? Math.min(chapterElapsed, chapterDuration) : Math.min(position, Math.max(1, sliderMax))}
                      onPreview={setScrubPreview}
                      onCommit={(value) => {
                        if (activeChapter) {
                          seekBookPosition(activeChapter.startSeconds + value);
                        } else {
                          seekTo(value);
                        }
                      }}
                    />
                    <div className="native-now-time-row">
                      <span>{formatTime(scrubbedElapsed)}</span>
                      <span>
                        {activeChapter
                          ? `−${formatTime(Math.max(0, chapterDuration - scrubbedElapsed))}`
                          : `−${formatTime(Math.max(0, sliderMax - scrubbedElapsed))}`}
                      </span>
                    </div>
                    {displayBookRemainingSeconds !== null && bookCompletionPercent !== null ? (
                      <div
                        className="book-time-row"
                        aria-label={`${formatTime(displayBookRemainingSeconds)} remaining in the book, ${bookCompletionPercent}% complete`}
                      >
                        <span>{formatTime(displayBookRemainingSeconds)} left in book</span>
                        <span>{bookCompletionPercent}% complete</span>
                      </div>
                    ) : null}
                  </div>

                  <div className="native-now-transport">
                    {activeChapter ? (
                      <button
                        type="button"
                        className="native-now-chapter"
                        aria-label={chapterElapsed > 5 ? "Restart chapter" : "Previous chapter"}
                        onClick={restartOrPreviousChapter}
                        disabled={chapterElapsed <= 5 && !hasPreviousChapter}
                      >
                        <SkipBack size={27} strokeWidth={1.65} />
                        <span>{chapterElapsed > 5 ? "Restart" : "Previous"}</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="native-now-seek"
                      aria-label="Rewind 15 seconds"
                      onClick={() => seekBy(-15)}
                    >
                      <RotateCcw size={24} strokeWidth={1.7} />
                      <span>15s</span>
                    </button>
                    <button
                      type="button"
                      className={`native-now-play${playPending ? " play-pending" : ""}`}
                      aria-label={playPending ? "Cancel play" : isPlaying ? "Pause" : "Play"}
                      aria-busy={playPending}
                      onClick={togglePlayback}
                    >
                      {isPlaying || playPending ? <Pause size={39} fill="currentColor" /> : <Play size={39} fill="currentColor" />}
                      {playPending ? <span className="play-pending-ring" aria-hidden="true" /> : null}
                    </button>
                    <button
                      type="button"
                      className="native-now-seek"
                      aria-label="Forward 30 seconds"
                      onClick={() => seekBy(30)}
                    >
                      <RotateCw size={24} strokeWidth={1.7} />
                      <span>30s</span>
                    </button>
                    {activeChapter ? (
                      <button
                        type="button"
                        className="native-now-chapter"
                        aria-label="Next chapter"
                        onClick={nextChapter}
                        disabled={!hasNextChapter}
                      >
                        <SkipForward size={27} strokeWidth={1.65} />
                        <span>Next</span>
                      </button>
                    ) : null}
                  </div>

                  <div className="native-now-utility">
                    <button
                      type="button"
                      onClick={() => openNativePlayerSheet("speed")}
                    >
                      <Gauge size={16} /> {speed}×
                    </button>
                    <button type="button" onClick={() => {
                      setSleepCustomOpen(false);
                      setSleepCustomDraft("");
                      openNativePlayerSheet("sleep");
                    }}>
                      <Timer size={16} /> {sleepRemaining > 0 ? `${Math.ceil(sleepRemaining / 60)}m left` : "Sleep timer"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (playbackBook) setSelectedBookId(playbackBook.id);
                        openNativePlayerSheet("details");
                      }}
                    >
                      <Bookmark size={16} /> Details
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (playbackBook) setSelectedBookId(playbackBook.id);
                        openNativePlayerSheet("chapters");
                      }}
                    >
                      <ListMusic size={16} /> Chapters
                    </button>
                    {readalongEnabled && playbackBook?.readingFile ? (
                      <button
                        type="button"
                        className="native-now-read"
                        onClick={() => {
                          haptic("light");
                          openReadalong(playbackBook);
                        }}
                      >
                        <BookOpen size={16} /> Read along
                      </button>
                    ) : null}
                  </div>
                </div>

                {!native ? (
                  <div className="web-now-extras">
                    <section className="web-now-panel web-now-about" aria-labelledby="web-now-about-title">
                      <header className="web-now-panel-head">
                        <div>
                          <span className="web-now-panel-kicker"><ScrollText size={13} /> Edition</span>
                          <h3 id="web-now-about-title">About this book</h3>
                        </div>
                        <button type="button" onClick={() => openNativePlayerSheet("details")}>View details</button>
                      </header>
                      <p>
                        {playbackDescription
                          ?? `${nowPlayingBook.title}${nowPlayingBook.author ? ` by ${nowPlayingBook.author}` : ""}${nowPlayingBook.narrator ? `, narrated by ${nowPlayingBook.narrator}` : ""}.`}
                      </p>
                      <div className="web-now-tags" aria-label="Book metadata">
                        {nowPlayingBook.publishedDate ? <span>{nowPlayingBook.publishedDate}</span> : null}
                        {nowPlayingBook.metadata.publisher ? <span>{nowPlayingBook.metadata.publisher}</span> : null}
                        {nowPlayingBook.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
                      </div>
                    </section>

                    <section className="web-now-panel web-now-session" aria-labelledby="web-now-session-title">
                      <header className="web-now-panel-head">
                        <div>
                          <span className="web-now-panel-kicker"><Headphones size={13} /> Session</span>
                          <h3 id="web-now-session-title">Listening progress</h3>
                        </div>
                        <strong>{bookCompletionPercent ?? 0}%</strong>
                      </header>
                      <div className="web-now-progressbar" role="img" aria-label={`${bookCompletionPercent ?? 0}% complete`}>
                        <span style={{ width: `${bookCompletionPercent ?? 0}%` }} />
                      </div>
                      <dl className="web-now-facts">
                        <div>
                          <dt>Remaining</dt>
                          <dd>{displayBookRemainingSeconds !== null ? formatDurationLabel(displayBookRemainingSeconds) ?? formatTime(displayBookRemainingSeconds) : "—"}</dd>
                        </div>
                        <div>
                          <dt>Runtime</dt>
                          <dd>{formatDurationLabel(bookDuration) ?? formatTime(bookDuration)}</dd>
                        </div>
                        <div>
                          <dt>Chapter</dt>
                          <dd>{activeChapter ? `${activeChapter.chapterNumber} of ${chapterSegments.length}` : "—"}</dd>
                        </div>
                      </dl>
                      <label className="web-now-volume" htmlFor="web-now-volume">
                        <span><Volume2 size={13} /> Volume</span>
                        <input
                          id="web-now-volume"
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={volume}
                          onChange={(event) => setVolume(Number(event.currentTarget.value))}
                        />
                        <strong>{Math.round(volume * 100)}%</strong>
                      </label>
                    </section>

                    <section className="web-now-panel web-now-up-next" aria-labelledby="web-now-up-next-title">
                      <header className="web-now-panel-head">
                        <div>
                          <span className="web-now-panel-kicker"><ListMusic size={13} /> Contents</span>
                          <h3 id="web-now-up-next-title">Up next</h3>
                        </div>
                        <button type="button" onClick={() => openNativePlayerSheet("chapters")}>All chapters</button>
                      </header>
                      {upcomingChapters.length > 0 ? (
                        <div className="web-now-chapter-list">
                          {upcomingChapters.map((chapter) => (
                            <button type="button" key={chapter.id} onClick={() => jumpToChapterFromSheet(chapter)}>
                              <span>{String(chapter.chapterNumber).padStart(2, "0")}</span>
                              <strong>{chapter.title}</strong>
                              <em>{formatTime(chapter.durationSeconds)}</em>
                              <ChevronRight size={15} />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="web-now-end-copy">You’re in the final chapter of this book.</p>
                      )}
                    </section>
                  </div>
                ) : null}
                {showReaderInNowView ? <div className="web-now-reader">{readalongPanelElement}</div> : null}
              </section>
            ) : null}
            {/* On the shelf tab the details page is a child page of the library
                list, so it always needs its own way back — even with nothing
                playing. "Back to Now Playing" still requires a playing book. */}
            {nativePlayerView !== "now" && (playbackBook || (native && nativeTab === "shelf")) ? (
              <button
                type="button"
                className="native-player-return"
                onClick={() => {
                  if (native && nativeTab === "shelf") {
                    returnToLibrary();
                    return;
                  }
                  haptic("light");
                  withWebViewTransition(() => openPlaybackView("now"));
                }}
              >
                {native && nativeTab === "shelf" ? (
                  <><span className="native-player-return-icon"><ChevronLeft size={21} /></span><span>Back to Library</span></>
                ) : (
                  <><span className="native-player-return-icon"><ChevronLeft size={21} /></span><span>Back to Now Playing</span></>
                )}
              </button>
            ) : null}
            <div className="folio">
              <span>Vol. I <span className="dot">·</span> The Reading Room</span>
              <span>Folio {String(activeTrackIndex + 1).padStart(3, "0")} / {String(selectedBook.tracks.length).padStart(3, "0")}</span>
            </div>

            <div className="book-heading">
              <CoverArt book={selectedBook} size="large" />
              <div className="meta">
                <div className="heading-top">
                  <span className="eyebrow">
                    <Bookmark size={13} /> {isViewingPlayingBook ? "Now Reading" : "Book Details"}
                  </span>
                  <div className="heading-actions">
                    {capabilities.metadataEditing && selectedBook.source !== "device" ? (
                      <button
                        className="download-btn"
                        type="button"
                        onClick={() => {
                          haptic("light");
                          openMetadataEditor(selectedBook);
                        }}
                        aria-label={`Edit info for ${selectedBook.title}`}
                      >
                        <Pencil size={13} />
                        <span>Edit Info</span>
                      </button>
                    ) : null}
                    {capabilities.uploads && selectedBook.readingFile?.extension !== "epub" && selectedBook.source !== "device" ? (
                      <button
                        className="download-btn"
                        type="button"
                        onClick={() => {
                          haptic("light");
                          setEbookUploadBook(selectedBook);
                          setEbookUploadFile(null);
                          setEbookUploadError(null);
                        }}
                        aria-label={`Upload matching ebook for ${selectedBook.title}`}
                      >
                        <BookOpen size={13} />
                        <span>Add EPUB</span>
                      </button>
                    ) : null}
                    <button
                      className={`download-btn ${
                        selectedBook.progress?.status === "finished" ? "active" : ""
                      }`}
                      type="button"
                      onClick={() => {
                        haptic("light");
                        void changeBookCompletion(
                          selectedBook,
                          selectedBook.progress?.status !== "finished"
                        );
                      }}
                      disabled={completionPendingBookId === selectedBook.id}
                      aria-pressed={selectedBook.progress?.status === "finished"}
                      aria-label={
                        selectedBook.progress?.status === "finished"
                          ? `Mark ${selectedBook.title} unfinished`
                          : `Mark ${selectedBook.title} finished`
                      }
                    >
                      {completionPendingBookId === selectedBook.id ? (
                        <LoaderCircle size={13} className="spin-icon" />
                      ) : (
                        <CircleCheck size={13} />
                      )}
                      <span>
                        {selectedBook.progress?.status === "finished"
                          ? "Mark Unfinished"
                          : "Mark Finished"}
                      </span>
                    </button>
                    {selectedBook.progress && selectedBook.progress.status !== "notStarted" ? (
                      <button
                        className="download-btn"
                        type="button"
                        onClick={() => markBookUnplayed(selectedBook)}
                        disabled={completionPendingBookId === selectedBook.id}
                        aria-label={`Mark ${selectedBook.title} as unplayed and reset listening progress`}
                      >
                        {completionPendingBookId === selectedBook.id ? (
                          <LoaderCircle size={13} className="spin-icon" />
                        ) : (
                          <RotateCcw size={13} />
                        )}
                        <span>Mark Unplayed</span>
                      </button>
                    ) : null}
                    {readalongAvailable ? (
                      <button
                        className={`download-btn ${readalongOpen ? "active" : ""}`}
                        type="button"
                        onClick={() => {
                          haptic("light");
                          if (readalongOpen) closeReadalong();
                          else openReadalong(selectedBook);
                        }}
                        aria-pressed={readalongOpen}
                        aria-label={`${readalongOpen ? "Close" : "Open"} ${selectedBook.readingFile ? "read along" : "extras"} for ${selectedBook.title}`}
                      >
                        {selectedBook.readingFile ? <BookOpen size={13} /> : <Images size={13} />}
                        <span>{selectedBook.readingFile ? "Read Along" : "Extras"}</span>
                      </button>
                    ) : null}
                    {selectedBook.deviceBookId ? (
                      <span className="download-btn active device-status" aria-label="Imported from this device">
                        <FolderOpen size={13} />
                        <span>On device</span>
                      </span>
                    ) : demoMode ? (
                      <span className="download-btn active device-status" aria-label="Included with the on-device demo">
                        <CircleCheck size={13} />
                        <span>On device</span>
                      </span>
                    ) : Capacitor.isNativePlatform() && (capabilities.downloads || downloadedBookIds.has(selectedBook.id) || selectedDownload) ? (
                      <button
                        className={`download-btn ${downloadedBookIds.has(selectedBook.id) ? "active" : ""} ${
                          selectedDownload ? "downloading" : ""
                        }`}
                        type="button"
                        onClick={() => {
                          haptic("light");
                          void (selectedDownload
                            ? cancelOfflineDownload(selectedBook)
                            : downloadedBookIds.has(selectedBook.id)
                              ? removeOfflineDownload(selectedBook)
                              : downloadForOffline(selectedBook));
                        }}
                        aria-label={
                          selectedDownload
                            ? `Cancel download of ${selectedBook.title}`
                            : downloadedBookIds.has(selectedBook.id)
                              ? `Remove downloaded copy of ${selectedBook.title}`
                            : `Download ${selectedBook.title} for offline playback`
                        }
                      >
                        {selectedDownload ? (
                          <DownloadRing fraction={selectedDownload.fraction} />
                        ) : (
                          <Download size={13} />
                        )}
                        <span>
                          {selectedDownload
                            ? "Cancel"
                            : downloadedBookIds.has(selectedBook.id)
                              ? "Downloaded"
                              : "Download"}
                        </span>
                      </button>
                    ) : capabilities.bookArchive ? (
                      <a
                        className="download-btn"
                        href={bookDownloadUrl(selectedBook.id)}
                        download
                        aria-label={`Download ${selectedBook.title} as zip`}
                      >
                        <Download size={13} />
                        <span>Download</span>
                      </a>
                    ) : !native && capabilities.downloads ? (
                      <details className="track-downloads">
                        <summary className="download-btn"><Download size={13} /> Download tracks</summary>
                        <ul>
                          {selectedBook.tracks.map((track) => (
                            <li key={track.id}>
                              <a href={mediaUrl(track.downloadUrl ?? track.streamUrl)}
                                target="_blank" rel="noreferrer" download>{track.title}</a>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {Capacitor.isNativePlatform() && downloadStatus?.bookId === selectedBook.id ? (
                      <span className="download-status">{downloadStatus.message}</span>
                    ) : null}
                    {playbackError ? <span className="download-status">{playbackError}</span> : null}
                    {completionError?.bookId === selectedBook.id ? (
                      <span className="download-status" role="alert">
                        {completionError.message}
                      </span>
                    ) : null}
                  </div>
                </div>
                <h2>{selectedBook.title}</h2>
                {!isViewingPlayingBook ? (
                  <div className="book-quick-start">
                    <button
                      type="button"
                      className="book-quick-play"
                      aria-label={`Play ${selectedBook.title}`}
                      onClick={() => void playSelectedBook(selectedBook)}
                    >
                      <span className="book-quick-play-icon"><Play size={20} fill="currentColor" /></span>
                      <span className="book-quick-play-copy">
                        <strong>
                          {selectedBook.progress?.status === "inProgress"
                            ? "Resume this book"
                            : selectedBook.progress?.status === "finished"
                              ? "Read it again"
                              : "Begin this reading"}
                        </strong>
                        <small>
                          {selectedBook.progress?.status === "inProgress"
                            && formatDurationLabel(selectedBook.progress.remainingSeconds)
                            ? `${formatDurationLabel(selectedBook.progress.remainingSeconds)} left`
                            : formatDurationLabel(selectedBook.durationSeconds ?? durationFromTracks(selectedBook)) ?? "Start from the beginning"}
                        </small>
                      </span>
                    </button>
                    {playbackBook && playbackBook.id !== selectedBook.id ? (
                      <button type="button" className="book-quick-return" onClick={scrollToPlayer}>
                        <Headphones size={14} />
                        <span>Now playing <em>{playbackBook.title}</em></span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <p className="book-credits">
                  {selectedBook.author ? <span>{selectedBook.author}</span> : null}
                  {selectedBook.narrator ? <span>Narrated by {selectedBook.narrator}</span> : null}
                  {!selectedBook.author && !selectedBook.narrator ? <span>{selectedBook.trackCount} tracks</span> : null}
                </p>
                {formatDurationLabel(selectedBook.durationSeconds ?? durationFromTracks(selectedBook)) ? (
                  <div className="book-runtime" aria-label="Total runtime">
                    <span className="book-runtime-label">Runtime</span>
                    <span className="book-runtime-value">
                      {formatDurationLabel(selectedBook.durationSeconds ?? durationFromTracks(selectedBook))}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="metadata-strip">
              {selectedBook.metadata.series ? (
                <span>{selectedBook.metadata.series}{selectedBook.metadata.seriesPosition ? ` · #${selectedBook.metadata.seriesPosition}` : ""}</span>
              ) : null}
              {tagsForBook(selectedBook).map((tag) => (
                <span className="metadata-custom-tag" key={tag.name}>
                  {tag.name}{tag.position ? ` · #${tag.position}` : ""}
                </span>
              ))}
              {selectedBook.publishedDate ? <span>{selectedBook.publishedDate}</span> : null}
              {selectedBook.metadata.publisher ? <span>{selectedBook.metadata.publisher}</span> : null}
              {selectedBook.genres.slice(0, native ? 2 : 3).map((genre) => <span key={genre}>{genre}</span>)}
            </div>

            {selectedSharedReaders.length > 0 ? (
              <section className="shared-readers" aria-label="Other listeners">
                <span className="section-label"><Users size={13} /> Also read by</span>
                <ul>
                  {selectedSharedReaders.map((reader) => (
                    <li key={reader.userId} className={reader.status}>
                      <span className="shared-reader-name">{reader.username}</span>
                      <span className="shared-reader-status">{readerStatusLabel(reader)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {selectedDescription ? (
              <div className="book-description-wrap">
                <p
                  className={`book-description ${descriptionCanExpand && !descriptionExpanded ? "clamped" : ""}`}
                  id="selected-book-description"
                >
                  {selectedDescription}
                </p>
                {descriptionCanExpand ? (
                  <button
                    type="button"
                    className="book-description-toggle"
                    aria-controls="selected-book-description"
                    aria-expanded={descriptionExpanded}
                    onClick={() => {
                      haptic("light");
                      setDescriptionExpanded((expanded) => !expanded);
                    }}
                  >
                    {descriptionExpanded ? "Less" : "More"}
                  </button>
                ) : null}
              </div>
            ) : null}

            {!readalongOpen && readalongAvailable ? (
              <section className={`readalong-invite ${selectedBook.readingFile ? "" : "extras"}`} aria-label="Read along">
                <span className="readalong-invite-icon" aria-hidden="true">
                  {selectedBook.readingFile ? <BookOpen size={22} strokeWidth={1.4} /> : <Images size={22} strokeWidth={1.4} />}
                </span>
                <div className="readalong-invite-copy">
                  <strong>
                    {selectedBook.readingFile
                      ? selectedHasExtras
                        ? "Read along with the ebook — extras included"
                        : "Read along with the ebook"
                      : "Extras included with this book"}
                  </strong>
                  <span>
                    {selectedBook.readingFile && selectedReadAlongMode
                      ? `${READ_ALONG_MODE_LABELS[selectedReadAlongMode].title}. ${READ_ALONG_MODE_LABELS[selectedReadAlongMode].detail}`
                      : [
                          selectedCompanionGroups.supplements.length > 0
                            ? `${selectedCompanionGroups.supplements.length} picture ${selectedCompanionGroups.supplements.length === 1 ? "document" : "documents"}`
                            : null,
                          selectedCompanionGroups.images.length > 0
                            ? `${selectedCompanionGroups.images.length} ${selectedCompanionGroups.images.length === 1 ? "picture" : "pictures"}`
                            : null
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                  </span>
                </div>
                <button
                  type="button"
                  className="download-btn active"
                  onClick={() => {
                    haptic("light");
                    openReadalong(selectedBook);
                  }}
                >
                  {selectedBook.readingFile ? <BookOpen size={13} /> : <Images size={13} />}
                  <span>{selectedBook.readingFile ? "Open reader" : "View extras"}</span>
                </button>
              </section>
            ) : null}

            {showReaderInNowView ? null : readalongPanelElement}

            {isViewingPlayingBook && currentTrack ? (
              <>
                <div className="track-line">
                  <span className="title">{currentTrack.title}</span>
                  <span className="ordinal">
                    {String(activeTrackIndex + 1).padStart(2, "0")} / {String(selectedBook.tracks.length).padStart(2, "0")}
                  </span>
                </div>

                <div className="transport">
                  {activeChapter ? (
                    <button
                      className="round-button secondary transport-skip"
                      aria-label={chapterElapsed > 5 ? "Restart chapter" : "Previous chapter"}
                      onClick={restartOrPreviousChapter}
                      disabled={chapterElapsed <= 5 && !hasPreviousChapter}
                    >
                      <SkipBack size={22} strokeWidth={1.7} />
                      <small>{chapterElapsed > 5 ? "Restart" : "Previous"}</small>
                    </button>
                  ) : null}
                  <button
                    className="round-button secondary transport-skip"
                    aria-label="Rewind 15 seconds"
                    onClick={() => seekBy(-15)}
                  >
                    <RotateCcw size={22} strokeWidth={1.7} />
                    <small>15s</small>
                  </button>
                  <button
                    className={`round-button primary${playPending ? " play-pending" : ""}`}
                    aria-label={playPending ? "Cancel play" : isPlaying ? "Pause" : "Play"}
                    aria-busy={playPending}
                    onClick={togglePlayback}
                  >
                    {isPlaying || playPending ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
                    {playPending ? <span className="play-pending-ring" aria-hidden="true" /> : null}
                  </button>
                  <button
                    className="round-button secondary transport-skip"
                    aria-label="Forward 30 seconds"
                    onClick={() => seekBy(30)}
                  >
                    <RotateCw size={22} strokeWidth={1.7} />
                    <small>30s</small>
                  </button>
                  {activeChapter ? (
                    <button
                      className="round-button secondary transport-skip"
                      aria-label="Next chapter"
                      onClick={nextChapter}
                      disabled={!hasNextChapter}
                    >
                      <SkipForward size={22} strokeWidth={1.7} />
                      <small>Next</small>
                    </button>
                  ) : null}
                </div>

                <div className="timeline">
                  {activeChapter && chapterSegments.length > 1 ? (
                    <>
                      <div className="chapter-now">
                        <span>{activeChapter.title}</span>
                        <span>
                          Chapter {activeChapter.chapterNumber} / {chapterSegments.length}
                        </span>
                      </div>
                      {chapterSegments.length <= MAX_CHAPTER_SEGMENTS ? (
                        <div className="chapter-segments" aria-label="Book chapter progress">
                          {chapterSegments.map((chapter) => {
                            const isActive = chapter.id === activeChapter.id;
                            const isComplete = bookPosition >= chapter.endSeconds;
                            const fill =
                              isComplete
                                ? 100
                                : isActive
                                  ? Math.max(0, Math.min(100, (chapterElapsed / chapterDuration) * 100))
                                  : 0;
                            const segmentClass = `chapter-segment ${isActive ? "active" : ""} ${isComplete ? "complete" : ""}`;
                            // On touch the slivers are impossible to hit on
                            // purpose and far too easy to hit by accident —
                            // keep them purely visual there; the chapter list
                            // below handles deliberate jumps.
                            return native ? (
                              <div
                                key={chapter.id}
                                className={segmentClass}
                                style={{ flexGrow: chapter.durationSeconds }}
                                aria-hidden="true"
                              >
                                <span style={{ width: `${fill}%` }} />
                              </div>
                            ) : (
                              <button
                                key={chapter.id}
                                className={segmentClass}
                                style={{ flexGrow: chapter.durationSeconds }}
                                title={`${chapter.title} · ${formatTime(chapter.startSeconds)}`}
                                aria-label={`Jump to ${chapter.title}`}
                                onClick={() => seekBookPosition(chapter.startSeconds)}
                              >
                                <span style={{ width: `${fill}%` }} />
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="book-progressbar" aria-label="Book progress" role="img">
                          <span
                            style={{
                              width: `${bookDuration > 0 ? Math.min(100, Math.max(0, (bookPosition / bookDuration) * 100)) : 0}%`
                            }}
                          />
                        </div>
                      )}
                    </>
                  ) : null}
                  {activeChapter ? (
                    <ScrubSlider
                      ariaLabel={`Playback position in ${activeChapter.title}`}
                      max={chapterDuration}
                      value={Math.min(chapterElapsed, chapterDuration)}
                      onPreview={setScrubPreview}
                      onCommit={(value) => seekBookPosition(activeChapter.startSeconds + value)}
                    />
                  ) : (
                    <ScrubSlider
                      ariaLabel="Playback position"
                      max={Math.max(1, sliderMax)}
                      value={Math.min(position, Math.max(1, sliderMax))}
                      onPreview={setScrubPreview}
                      onCommit={seekTo}
                    />
                  )}
                  <div className="time-row">
                    <span className="elapsed">
                      {formatTime(scrubbedElapsed)}
                    </span>
                    <span>
                      {activeChapter ? formatTime(chapterDuration) : formatTime(sliderMax)}
                    </span>
                  </div>
                  {displayBookRemainingSeconds !== null && bookCompletionPercent !== null ? (
                    <div
                      className="book-time-row"
                      aria-label={`${formatTime(displayBookRemainingSeconds)} remaining in the book, ${bookCompletionPercent}% complete`}
                    >
                      <span>{formatTime(displayBookRemainingSeconds)} left in book</span>
                      <span>{bookCompletionPercent}% complete</span>
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="book-preview-actions">
                {native ? (
                  <button
                    type="button"
                    className="preview-primary"
                    aria-label={`Play ${selectedBook.title}`}
                    onClick={() => void playSelectedBook(selectedBook)}
                  >
                    <span className="preview-primary-icon"><Play size={19} fill="currentColor" /></span>
                    <span>
                      {selectedBook.progress?.status === "inProgress"
                        ? `Resume${
                            formatDurationLabel(selectedBook.progress.remainingSeconds)
                              ? ` · ${formatDurationLabel(selectedBook.progress.remainingSeconds)} left`
                              : ""
                          }`
                        : selectedBook.progress?.status === "finished"
                          ? "Read it again"
                          : "Begin this reading"}
                    </span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="round-button primary"
                      aria-label={`Play ${selectedBook.title}`}
                      onClick={() => void playSelectedBook(selectedBook)}
                    >
                      <Play size={30} fill="currentColor" />
                    </button>
                    <span className="preview-cta">
                      {selectedBook.progress?.status === "inProgress"
                        ? `Resume${
                            formatDurationLabel(selectedBook.progress.remainingSeconds)
                              ? ` · ${formatDurationLabel(selectedBook.progress.remainingSeconds)} left`
                              : ""
                          }`
                        : selectedBook.progress?.status === "finished"
                          ? "Read it again"
                          : "Begin this reading"}
                    </span>
                  </>
                )}
                {playbackBook && playbackBook.id !== selectedBook.id ? (
                  <button type="button" className="preview-return" onClick={scrollToPlayer}>
                    {native ? (
                      <><Play size={13} fill="currentColor" /><span>Return to <em>{playbackBook.title}</em></span></>
                    ) : (
                      <>Still playing · <em>{playbackBook.title}</em></>
                    )}
                  </button>
                ) : null}
              </div>
            )}

            <div className={`controls-grid controls-grid-${isViewingPlayingBook ? (native ? 3 : 4) : 1}`}>
              {isViewingPlayingBook ? (
                <>
                  <section className="control-section">
                    <div className="section-label"><Gauge size={13} /> Cadence</div>
                    <PlaybackSpeedControl value={speed} onChange={updateSpeed} rotary={native} />
                  </section>

                  {/* Phones have hardware volume buttons; a second software
                      volume just adds a card. */}
                  {!native ? (
                    <section className="control-section">
                      <label className="section-label" htmlFor="volume"><Volume2 size={13} /> Volume</label>
                      <input
                        id="volume"
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={volume}
                        onChange={(event) => setVolume(Number(event.currentTarget.value))}
                      />
                    </section>
                  ) : null}

                  <section className="control-section">
                    <label className="section-label" htmlFor="sleep"><Timer size={13} /> Nightfall</label>
                    <select
                      id="sleep"
                      value={sleepCustomOpen ? "custom" : String(sleepMinutes)}
                      onChange={(event) => {
                        const choice = event.currentTarget.value;
                        if (choice === "custom") {
                          setSleepCustomDraft(sleepMinutes > 0 ? String(sleepMinutes) : "");
                          setSleepCustomOpen(true);
                          return;
                        }
                        configureSleepTimer(Number(choice));
                      }}
                    >
                      <option value="0">—</option>
                      {sleepChoices.map((option) => (
                        <option key={option} value={String(option)}>
                          {formatSleepTimerMinutes(option)}
                        </option>
                      ))}
                      <option value="custom">Custom…</option>
                    </select>
                    {sleepCustomOpen ? (
                      <form className="sleep-custom" onSubmit={startCustomSleepTimer}>
                        <input
                          type="number"
                          autoFocus
                          inputMode="numeric"
                          enterKeyHint="done"
                          min={SLEEP_TIMER_MIN_MINUTES}
                          max={SLEEP_TIMER_MAX_MINUTES}
                          step={1}
                          placeholder="Minutes"
                          aria-label="Custom sleep timer in minutes"
                          value={sleepCustomDraft}
                          onChange={(event) => setSleepCustomDraft(event.currentTarget.value)}
                        />
                        <button type="submit" disabled={sleepCustomMinutes === null}>Set</button>
                        <button type="button" className="sleep-custom-cancel" aria-label="Cancel custom timer" onClick={() => { haptic("light"); setSleepCustomOpen(false); }}><X size={16} /></button>
                      </form>
                    ) : null}
                    {sleepRemaining > 0 ? <span className="sleep-copy">{formatTime(sleepRemaining)} remaining</span> : null}
                  </section>
                </>
              ) : null}

              {/* Unlike the device volume this one belongs to the book, so it
                  is offered on the book's own page whether or not it is the
                  thing currently playing. */}
              <section className="control-section">
                <label className="section-label" htmlFor="book-volume">
                  <Volume2 size={13} /> Book Volume
                </label>
                <BookVolumeControl
                  compact
                  inputId="book-volume"
                  value={selectedGain}
                  canBoost={selectedCanBoost}
                  onChange={(db) => updateBookGain(selectedBook, db)}
                />
              </section>
            </div>

            {selectedChapterSegments.length > 0 ? (
              <section className="track-list-section" ref={trackListSectionRef}>
                <button
                  type="button"
                  className="track-list-header track-list-toggle"
                  aria-expanded={chaptersOpen}
                  onClick={() => {
                    haptic("light");
                    setChaptersOpen((open) => {
                      if (open) setShowChapterJumpTop(false);
                      return !open;
                    });
                  }}
                >
                  <span className="title-of-contents">Embedded Chapters</span>
                  <span className="section-label">
                    <ListMusic size={13} /> {selectedChapterSegments.length} Markers
                    <ChevronDown size={14} className={`toggle-chevron ${chaptersOpen ? "open" : ""}`} />
                  </span>
                </button>
                {chaptersOpen ? (
                  <div className="track-list" ref={chaptersListRef}>
                    {selectedChapterSegments.map((chapter, index) => (
                      <button
                        key={chapter.id}
                        data-chapter-id={chapter.id}
                        className={`track-row ${isViewingPlayingBook && chapter.id === activeChapter?.id ? "active" : ""}`}
                        onClick={() => jumpToChapter(chapter)}
                      >
                        <span className="num">{String(index + 1).padStart(2, "0")}</span>
                        <strong>{chapter.title}</strong>
                        <em>{formatTime(chapter.durationSeconds)}</em>
                      </button>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
            {native && nativeTab === "shelf" && nativePlayerView === "details" && showChapterJumpTop ? (
              <button type="button" className="chapter-jump-top" onClick={jumpToPlayerTop} aria-label="Jump to top of book details">
                <ArrowUp size={16} />
                <span>Top</span>
              </button>
            ) : null}
          </>
        ) : (
          <div className="empty-player">
            <Headphones size={48} strokeWidth={1.25} />
            {books.length > 0 ? (
              <>
                <h2>Nothing <em>playing</em></h2>
                <p>Choose a book from your shelf to begin listening.</p>
              </>
            ) : (
              <>
                <h2>An empty <em>shelf</em></h2>
                <p>{localMode
                  ? "Choose audiobook files from this device to start listening."
                  : isOperaLibre
                    ? "Add audiobook files to your server’s library folder, then refresh the library."
                    : "Check your Jellyfin Books library and this account’s access, then refresh the library."}</p>
              </>
            )}
          </div>
        )}
      </section>

      {playbackBook && currentTrack ? (
        <aside ref={miniPlayerRef} className="mini-player" aria-label="Mini player">
          <button className="mini-cover-button" type="button" onClick={scrollToPlayer} aria-label="Open current book">
            <CoverArt book={playbackBook} size="small" />
          </button>

          <button className="mini-meta" type="button" onClick={scrollToPlayer}>
            <strong>{playbackBook.title}</strong>
            <span>{activeChapter?.title ?? currentTrack.title}</span>
          </button>

          <div className="mini-progress">
            <ScrubSlider
              ariaLabel="Mini player progress"
              max={activeChapter ? chapterDuration : Math.max(1, sliderMax)}
              value={activeChapter ? Math.min(chapterElapsed, chapterDuration) : Math.min(position, Math.max(1, sliderMax))}
              onPreview={setScrubPreview}
              onCommit={(nextValue) => {
                if (activeChapter) {
                  seekBookPosition(activeChapter.startSeconds + nextValue);
                } else {
                  seekTo(nextValue);
                }
              }}
            />
            <span>
              {activeChapter
                ? `${formatTime(scrubbedElapsed)} / ${formatTime(chapterDuration)}`
                : `${formatTime(scrubbedElapsed)} / ${formatTime(sliderMax)}`}
            </span>
          </div>

          <div className="mini-actions">
            {activeChapter ? (
              <button
                type="button"
                className="mini-chapter"
                aria-label={chapterElapsed > 5 ? "Restart chapter" : "Previous chapter"}
                onClick={restartOrPreviousChapter}
                disabled={chapterElapsed <= 5 && !hasPreviousChapter}
              >
                <SkipBack size={17} />
              </button>
            ) : null}
            <button type="button" className="mini-seek" aria-label="Rewind 15 seconds" onClick={() => seekBy(-15)}>
              <RotateCcw size={16} />
              <small>15</small>
            </button>
            <button
              type="button"
              className={`mini-play${playPending ? " play-pending" : ""}`}
              aria-label={playPending ? "Cancel play" : isPlaying ? "Pause" : "Play"}
              aria-busy={playPending}
              onClick={togglePlayback}
            >
              {isPlaying || playPending ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
              {playPending ? <span className="play-pending-ring" aria-hidden="true" /> : null}
            </button>
            <button type="button" className="mini-seek" aria-label="Forward 30 seconds" onClick={() => seekBy(30)}>
              <RotateCw size={16} />
              <small>30</small>
            </button>
            {activeChapter ? (
              <button
                type="button"
                className="mini-chapter"
                aria-label="Next chapter"
                onClick={nextChapter}
                disabled={!hasNextChapter}
              >
                <SkipForward size={17} />
              </button>
            ) : null}
          </div>
        </aside>
      ) : null}

      {syncConfirmationBook ? (
        <SyncConfirmationDialog
          setSyncConfirmationBook={setSyncConfirmationBook}
          startSyncGeneration={startSyncGeneration}
          syncConfirmationBook={syncConfirmationBook}
        />
      ) : null}

      {unplayedConfirmationBook ? (
        <UnplayedConfirmationDialog
          completionError={completionError}
          completionPendingBookId={completionPendingBookId}
          confirmBookUnplayed={confirmBookUnplayed}
          setCompletionError={setCompletionError}
          setUnplayedConfirmationBookId={setUnplayedConfirmationBookId}
          unplayedConfirmationBook={unplayedConfirmationBook}
        />
      ) : null}

      {nativePlayerSheet === "details" && playbackBook ? (
        <BookDetailsSheet
          activeChapter={activeChapter}
          bookCompletionPercent={bookCompletionPercent}
          changeBookCompletion={changeBookCompletion}
          closeNativePlayerSheet={closeNativePlayerSheet}
          completionPendingBookId={completionPendingBookId}
          displayBookRemainingSeconds={displayBookRemainingSeconds}
          markBookUnplayed={markBookUnplayed}
          openPlaybackView={openPlaybackView}
          playbackBook={playbackBook}
          playbackDescription={playbackDescription}
          setNativePlayerSheet={setNativePlayerSheet}
        />
      ) : null}

      {nativePlayerSheet === "speed" ? (
        <SpeedSheet
          closeNativePlayerSheet={closeNativePlayerSheet}
          playbackBook={playbackBook}
          playbackCanBoost={playbackCanBoost}
          playbackGain={playbackGain}
          setNativePlayerSheet={setNativePlayerSheet}
          speed={speed}
          updateBookGain={updateBookGain}
          updateSpeed={updateSpeed}
        />
      ) : null}

      {nativePlayerSheet === "chapters" && playbackBook ? (
        <ChapterSheet
          activeChapter={activeChapter}
          chapterSegments={chapterSegments}
          closeNativePlayerSheet={closeNativePlayerSheet}
          jumpToChapterFromSheet={jumpToChapterFromSheet}
          playbackBook={playbackBook}
          setNativePlayerSheet={setNativePlayerSheet}
        />
      ) : null}

      {nativePlayerSheet === "sleep" ? (
        <SleepTimerSheet
          closeNativePlayerSheet={closeNativePlayerSheet}
          configureSleepTimer={configureSleepTimer}
          setNativePlayerSheet={setNativePlayerSheet}
          setSleepCustomDraft={setSleepCustomDraft}
          setSleepCustomOpen={setSleepCustomOpen}
          sleepChoices={sleepChoices}
          sleepCustomDraft={sleepCustomDraft}
          sleepCustomMinutes={sleepCustomMinutes}
          sleepCustomOpen={sleepCustomOpen}
          sleepMinutes={sleepMinutes}
          sleepRemaining={sleepRemaining}
          startCustomSleepTimer={startCustomSleepTimer}
        />
      ) : null}

      {metadataEditOpen && metadataForm ? (
        <MetadataEditorDialog
          metadataError={metadataError}
          metadataForm={metadataForm}
          metadataSaving={metadataSaving}
          saveMetadata={saveMetadata}
          selectedBook={selectedBook}
          setMetadataEditOpen={setMetadataEditOpen}
          setMetadataError={setMetadataError}
          setMetadataForm={setMetadataForm}
        />
      ) : null}

      {capabilities.statistics && profileOpen ? (
        <ProfilePage
          books={books}
          user={currentUser}
          onClose={() => setProfileOpen(false)}
          onOpenBook={(bookId) => {
            openBookDetails(bookId);
            setProfileOpen(false);
            setLibraryOpen(false);
          }}
          onUserChanged={onCurrentUserChanged}
          onSharingChanged={() => void loadBooks()}
          sharingAvailable={sharedProgressAvailable && !native}
          deviceOnly={localMode}
        />
      ) : null}

      {capabilities.administration && !native && usersModalOpen ? (
        <AdminPanel
          currentUser={currentUser}
          books={administrableBooks}
          onClose={() => setUsersModalOpen(false)}
          onUpload={() => {
            setUsersModalOpen(false);
            setUploadModalOpen(true);
          }}
          onRescan={refreshLibrary}
          onBeforeLibraryMutation={prepareForAdminLibraryMutation}
          onBooksChanged={applyAdminLibraryChange}
          onAlignmentChanged={updateAlignmentStatus}
          onOpenBook={(bookId) => {
            openBookDetails(bookId);
            setUsersModalOpen(false);
          }}
        />
      ) : null}

      {capabilities.uploads && uploadModalOpen ? (
        <AudiobookUploadDialog
          chooseUploadFiles={chooseUploadFiles}
          native={native}
          setUploadBookName={setUploadBookName}
          setUploadModalOpen={setUploadModalOpen}
          submitAudiobookUpload={submitAudiobookUpload}
          uploadBookName={uploadBookName}
          uploadBusy={uploadBusy}
          uploadError={uploadError}
          uploadFiles={uploadFiles}
        />
      ) : null}

      {capabilities.uploads && ebookUploadBook ? (
        <EbookUploadDialog
          chooseEbookUpload={chooseEbookUpload}
          ebookUploadBook={ebookUploadBook}
          ebookUploadBusy={ebookUploadBusy}
          ebookUploadError={ebookUploadError}
          ebookUploadFile={ebookUploadFile}
          native={native}
          setEbookUploadBook={setEbookUploadBook}
          submitEbookUpload={submitEbookUpload}
        />
      ) : null}

      {showLedgerTab && nativeTab === "ledger" ? (
        <ProfilePage
          books={books}
          user={currentUser}
          onClose={() => openNativeTab("reading")}
          onOpenBook={(bookId) => {
            openBookDetails(bookId);
          }}
          onUserChanged={onCurrentUserChanged}
          onSharingChanged={() => void loadBooks()}
          sharingAvailable={sharedProgressAvailable && !native}
          deviceOnly={localMode}
        />
      ) : null}

      {native && gamesEnabled && nativeTab === "games" ? <GamesPage onGameChange={setActiveGame} /> : null}

      {native && nativeTab === "settings" ? (
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
      ) : null}

      {native && capabilities.administration && nativeTab === "admin" ? (
        <AdminPanel
          onBack={() => openNativeTab("settings")}
          currentUser={currentUser}
          books={administrableBooks}
          onUpload={() => setUploadModalOpen(true)}
          onRescan={refreshLibrary}
          onBeforeLibraryMutation={prepareForAdminLibraryMutation}
          onBooksChanged={applyAdminLibraryChange}
          onAlignmentChanged={updateAlignmentStatus}
          onOpenBook={(bookId) => {
            openBookDetails(bookId);
            openNativeTab("shelf");
          }}
        />
      ) : null}

      {native && !nativeTabsReady ? (
        <nav className="spine-tabs" aria-label="Primary">
          <button
            type="button"
            className={`spine-tab ${nativeTab === "shelf" ? "active" : ""}`}
            aria-current={nativeTab === "shelf" ? "page" : undefined}
            onClick={() => openNativeTab("shelf")}
          >
            <Library size={20} strokeWidth={1.6} />
            <span>Shelf</span>
            {currentUser.isAdmin && brokenLibationAccounts.length > 0 ? <em className="nav-alert-badge">{brokenLibationAccounts.length}</em> : null}
          </button>
          <button
            type="button"
            className={`spine-tab ${nativeTab === "reading" ? "active" : ""}`}
            aria-current={nativeTab === "reading" ? "page" : undefined}
            onClick={() => openNativeTab("reading")}
          >
            <Headphones size={20} strokeWidth={1.6} />
            <span>Reading</span>
          </button>
          {gamesEnabled ? <button
            type="button"
            className={`spine-tab ${nativeTab === "games" ? "active" : ""}`}
            aria-current={nativeTab === "games" ? "page" : undefined}
            onClick={() => openNativeTab("games")}
          >
            <Gamepad2 size={20} strokeWidth={1.6} />
            <span>Games</span>
          </button> : null}
          {showLedgerTab ? (
            <button
              type="button"
              className={`spine-tab ${nativeTab === "ledger" ? "active" : ""}`}
              aria-current={nativeTab === "ledger" ? "page" : undefined}
              onClick={() => openNativeTab("ledger")}
            >
              <ScrollText size={20} strokeWidth={1.6} />
              <span>Ledger</span>
            </button>
          ) : null}
          <button
            type="button"
            className={`spine-tab ${(nativeTab === "settings" || nativeTab === "admin") ? "active" : ""}`}
            aria-current={(nativeTab === "settings" || nativeTab === "admin") ? "page" : undefined}
            onClick={() => openNativeTab("settings")}
          >
            <Settings size={20} strokeWidth={1.6} />
            <span>Settings</span>
          </button>
        </nav>
      ) : null}
    </main>
  );
}
