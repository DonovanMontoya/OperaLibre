import { hasPlaybackSource } from "./nativeAudioStartup";
import { useDeviceFold } from "./deviceFold";
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
  Gamepad2,
  Headphones,
  Library,
  PanelLeftOpen,
  Settings,
  ScrollText
} from "lucide-react";
import {
} from "./readalong";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { flushSync } from "react-dom";
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
  BOOK_GAIN_DEFAULT,
  bookGainFromDb,
  createBookGainSync,
  mergeServerBookGains
} from "./bookVolume";
import {
} from "./shelfView";
import {
  shelfDownloadScanKey
} from "./shelfFilters";
import { PlaybackGainChain, streamCanBeBoosted } from "./playbackGain";
import { displayBookDescription, enrichBooksFromLibation } from "./bookMetadata";
import { buildChapterSegments, chapterAtBookPosition } from "./chapters";
import {
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
  setBookVolume,
  setStoredMediaToken,
  setStoredToken,
  setUnauthorizedHandler
} from "./api";
import {
  cacheLibrary,
  cacheOfflineUser,
  cacheProgress,
  forgetOfflineUser,
  getBookBackgroundDownloadStatus,
  getCachedLibrary,
  getCachedProgress,
  getOfflineCoverUrl,
  getOfflineTrackUrl,
  getOfflineUser,
  isBookDownloaded,
  releaseOfflineMediaUrl,
  warnCacheFailure
} from "./offline";
import { haptic } from "./native";
import { isLeftEdgeBackSwipe } from "./nativeNavigation";
import { type NativeTab } from "./nativeTabs";
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
  mergeDeviceAndServerBooks,
  migrateDeviceLibraryFileExtensions,
  saveDeviceProgress
} from "./localLibrary";
import { AuthGate, ServerSetup } from "./Auth";
import { AdminPanel } from "./Admin";
import { refreshLibroDevice } from "./libroDevice";
import { ProfilePage } from "./Profile";
import { GamesPage, type GameName } from "./GameRoom";
import { readGamesEnabled, writeGamesEnabled } from "./gamePreferences";
import {
} from "./readalongPreferences";
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
  CONNECT_PROMPT_DISMISSED_KEY,
  readStoredBookId,
  readStoredSpeed,
  readStoredValue,
  unsyncedBookGainStore,
  withoutCachedBookGains,
  writeStoredBookGains,
  writeStoredBookId,
  writeStoredSpeed
} from "./appStorage";
import {
  type LibrarySource
} from "./shelfSort";
import {
  currentTrackIndex,
  durationFromTracks,
  errorMessage,
  trackOffsetSeconds
} from "./formatting";
import { usePullToRefresh } from "./usePullToRefresh";
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
import { useReadalong } from "./useReadalong";
import { useOfflineDownloads } from "./useOfflineDownloads";
import { useBookCompletion } from "./useBookCompletion";
import { useMediaSession } from "./useMediaSession";
import { useStartupReveal } from "./useStartupReveal";
import { useNativeChrome } from "./useNativeChrome";
import { renderUserMenu } from "./UserMenu";
import { describeSyncJob } from "./syncJobProgress";
import { renderCompanionTabs, renderEpubReader, renderReadalongPanel, renderReaderSyncActions, renderReaderSyncMessages } from "./ReaderPanel";
import { renderAudibleManagement } from "./AudibleManagement";
import { SettingsPage } from "./SettingsPage";
import { MiniPlayer } from "./MiniPlayer";
import { PlayerPane } from "./PlayerPane";
import { LibraryPane } from "./LibraryPane";

const PROGRESS_SAVE_INTERVAL_MS = 2_000;


function audioSourceMatches(audio: HTMLAudioElement, source: string) {
  if (!source) return false;
  try {
    return audio.currentSrc === new URL(source, document.baseURI).href;
  } catch {
    return audio.currentSrc === source;
  }
}


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
  const readerPreferences = useReaderPreferences();
  const {
    followSyncEnabled,
    readalongEnabled,
    setReadalongEnabled,
  } = readerPreferences;
  const displaySettings = useDisplaySettings({
    ios
  });
  const {
    appearanceMode,
  } = displaySettings;
  const serverAliasesState = useServerAliases();
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
  const finishFeedState = useFinishFeed({
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
  const {
    scheduleStartupReveal,
    setStartupViewReady,
    startupProgressAppliedRef,
    startupViewReady,
    startupViewReadyRef
  } = useStartupReveal({
    native
  });

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
  const uploads = useUploads({
    books,
    reconcileServerBookGains,
    setBooks,
    setError,
    setIsOffline,
    setLibrarySource,
    setSelectedBookId
  });
  const {
    chooseEbookUpload,
    chooseUploadFiles,
    ebookUploadBook,
    ebookUploadBusy,
    ebookUploadError,
    ebookUploadFile,
    setEbookUploadBook,
    setUploadBookName,
    setUploadModalOpen,
    submitAudiobookUpload,
    submitEbookUpload,
    uploadBookName,
    uploadBusy,
    uploadError,
    uploadFiles,
    uploadModalOpen
  } = uploads;
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
  const sleepTimer = useSleepTimer({
    audioRef,
    isPlaying,
    nativeAudio,
    pausePlaybackRef,
    setNativePlayerSheet,
    setPlaybackError
  });
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
  } = sleepTimer;
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
  const [downloadedBookIds, setDownloadedBookIds] = useState<Set<string>>(new Set());
  const shelf = useShelf({
    books,
    demoMode,
    downloadedBookIds,
    ipad,
    librarySource,
    localMode,
    native,
    playbackFold
  });
  const {
    changeShelfLayout,
    searchQuery,
    shelfFolded,
    shelfLandscape,
    shelfLayout,
    sortMode,
    sortReversed,
  } = shelf;
  const [downloadStatus, setDownloadStatus] = useState<DeviceNotice | null>(null);
  const [completionPendingBookId, setCompletionPendingBookId] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<DeviceNotice | null>(null);
  const [unplayedConfirmationBookId, setUnplayedConfirmationBookId] = useState<string | null>(null);
  const [syncConfirmationBook, setSyncConfirmationBook] = useState<Book | null>(null);
  // Native jobs are persisted and serialized by iOS; this map only mirrors
  // their current queue/progress for the UI.
  const [activeDownloads, setActiveDownloads] = useState<Record<string, DeviceDownloadActivity>>({});
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
  const metadataEditor = useMetadataEditor({
    reconcileServerBookGains,
    selectedBook,
    setBooks
  });
  const {
    metadataEditOpen,
    metadataError,
    metadataForm,
    metadataSaving,
    saveMetadata,
    setMetadataEditOpen,
    setMetadataError,
    setMetadataForm
  } = metadataEditor;
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
  const carPlay = useCarPlay({
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
  const {
    adoptCarPlaybackState,
    carEventHandlersRef,
    carPlaybackBookId,
    setCarPlaybackBookId,
    takeOverFromCar
  } = carPlay;

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
  const readalong = useReadalong({
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
    readalongOpen,
    readerClosing,
    setReadalongOpen,
    setReaderClosing,
    startSyncGeneration,
    syncJob,
    updateAlignmentStatus,
    writeReaderOpenFlag
  } = readalong;

  const purchases = usePurchases({
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
  const {
    brokenLibationAccounts,
    canBrowseLibation,
    libationBooks,
    libationBooksLoaded,
    libationBooksRef,
    libroAccounts,
    libroOnDevice,
    loadLibationBooks,
    setLibationBooks,
    setLibationBooksLoaded,
    setLibroRefreshKey,
  } = purchases;

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
  const {
    activeChapterId,
    mediaSessionHandlersRef
  } = useMediaSession({
    activeChapter,
    audioRef,
    chapterDuration,
    chapterElapsed,
    currentTrackKey,
    nativeAudio,
    nextChapter,
    pausePlayback,
    position,
    restartOrPreviousChapter,
    seekBookPosition,
    seekBy,
    seekTo,
    sliderMax,
    speed,
    startPlayback
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
  const bookCompletion = useBookCompletion({
    audioRef,
    clearPlaybackSession,
    completionPendingBookId,
    currentUser,
    nativePlaybackPlayingRef,
    pausePlayback,
    playbackBookId,
    playbackBookIdRef,
    playbackReportRef,
    playbackTouchedRef,
    progressMutationVersion,
    progressSaveAbortController,
    progressSaveDrainPromiseRef,
    queuedProgressSaves,
    setBooks,
    setCompletionError,
    setCompletionPendingBookId,
    setIsPlaying,
    setUnplayedConfirmationBookId
  });
  const {
    changeBookCompletion,
    confirmBookUnplayed,
    markBookUnplayed
  } = bookCompletion;

  const offlineDownloads = useOfflineDownloads({
    audioRef,
    booksRef,
    capabilities,
    clearPlaybackSession,
    currentTrack,
    currentUser,
    loadBooks,
    nativeAudio,
    nativePlaybackPlayingRef,
    pausePlayback,
    pendingSeekRef,
    persistProgress,
    playWhenTrackLoads,
    playbackBook,
    setActiveDownloads,
    setBooks,
    setDeviceImport,
    setDownloadStatus,
    setDownloadedBookIds,
    setLibrarySource,
    setNativeTab,
    setOfflineSource,
    setPendingSeek,
    setPlaybackBookId,
    setSelectedBookId
  });
  const {
    downloadForOffline,
  } = offlineDownloads;


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
  const nativeChrome = useNativeChrome({
    appearanceMode,
    brokenLibationAccounts,
    capabilities,
    currentTrack,
    currentUser,
    gamesEnabled,
    miniPlayerRef,
    native,
    nativeTab,
    openNativeTab,
    playbackBook,
    readalongOpen,
    readerClosing,
    setReadalongOpen,
    setReaderClosing,
    shelfLayout,
    shellRef
  });
  const {
    hasMiniPlayer,
    nativeTabsReady,
    showLedgerTab
  } = nativeChrome;


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

  const userMenu = renderUserMenu({
    audioRef,
    capabilities,
    currentUser,
    demoMode,
    isOperaLibre,
    localMode,
    native,
    onLogout,
    openNativeTab,
    pausePlayback,
    purchases,
    readalong,
    readerPreferences,
    setLibraryOpen,
    setLibrarySource,
    setProfileOpen,
    setUserMenuOpen,
    setUsersModalOpen
  });
  const {
    syncJobForBook,
    syncJobRunning,
    syncProgressNote,
    syncProgressPercent
  } = describeSyncJob({
    selectedBook,
    syncJob
  });

  const readerSyncActions = renderReaderSyncActions({
    readalong,
    selectedBook,
    syncJobRunning
  });
  const readerSyncMessages = renderReaderSyncMessages({
    readalong,
    syncJobForBook,
    syncJobRunning,
    syncProgressNote,
    syncProgressPercent
  });
  const companionTabs = renderCompanionTabs({
    readalong
  });
  const epubReaderElement = renderEpubReader({
    activeChapter,
    bookPosition,
    closeReadalong,
    companionTabs,
    displayBookPosition,
    isPlaying,
    isViewingPlayingBook,
    native,
    openNativePlayerSheet,
    playSelectedBook,
    readalong,
    readerPreferences,
    readerSyncActions,
    readerSyncMessages,
    seekBookPositionInBook,
    seekBy,
    selectedBook,
    selectedChapterSegments,
    sleepTimer,
    speed,
    togglePlayback
  });
  // The native ebook reader is a full-screen layer of its own; everything
  // else (extras, pictures, the web reader) lives in the inline panel.
  const immersiveEpub = native && !!epubReaderElement;

  const readalongPanelElement = renderReadalongPanel({
    activeChapter,
    closeReadalong,
    companionTabs,
    displayBookPosition,
    epubReaderElement,
    immersiveEpub,
    nativeChrome,
    readalong,
    readerSyncActions,
    readerSyncMessages,
    selectedBook
  });

  const audibleManagement = renderAudibleManagement({
    currentUser,
    native,
    purchases
  });

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

      <LibraryPane
        applyAdminLibraryChange={applyAdminLibraryChange}
        audibleManagement={audibleManagement}
        audioRef={audioRef}
        books={books}
        capabilities={capabilities}
        carPlay={carPlay}
        connectPromptDismissed={connectPromptDismissed}
        currentUser={currentUser}
        demoMode={demoMode}
        deviceImport={deviceImport}
        downloadedBookIds={downloadedBookIds}
        error={error}
        finishFeedState={finishFeedState}
        ipad={ipad}
        isLoading={isLoading}
        isOffline={isOffline}
        isOperaLibre={isOperaLibre}
        lastPurchaseSource={lastPurchaseSource}
        libraryOpen={libraryOpen}
        librarySource={librarySource}
        localMode={localMode}
        native={native}
        nativeTab={nativeTab}
        offlineDownloads={offlineDownloads}
        onConnectServer={onConnectServer}
        openBookDetails={openBookDetails}
        openNativeTab={openNativeTab}
        pausePlayback={pausePlayback}
        playbackBook={playbackBook}
        purchases={purchases}
        readerPreferences={readerPreferences}
        refreshLibrary={refreshLibrary}
        resumeSelectedBook={resumeSelectedBook}
        selectBook={selectBook}
        selectFromShelf={selectFromShelf}
        selectedBook={selectedBook}
        setBooks={setBooks}
        setConnectPromptDismissed={setConnectPromptDismissed}
        setLibraryOpen={setLibraryOpen}
        setLibrarySource={setLibrarySource}
        setUserMenuOpen={setUserMenuOpen}
        shelf={shelf}
        shelfPull={shelfPull}
        showYourLibrary={showYourLibrary}
        uploads={uploads}
        userMenu={userMenu}
        userMenuOpen={userMenuOpen}
      />

      <PlayerPane
        activeChapter={activeChapter}
        activeTrackIndex={activeTrackIndex}
        beginBookDetailsBackSwipe={beginBookDetailsBackSwipe}
        bookCompletion={bookCompletion}
        bookCompletionPercent={bookCompletionPercent}
        bookDetailsSwipeStartRef={bookDetailsSwipeStartRef}
        bookDuration={bookDuration}
        bookPosition={bookPosition}
        books={books}
        capabilities={capabilities}
        chapterDuration={chapterDuration}
        chapterElapsed={chapterElapsed}
        chapterSegments={chapterSegments}
        chaptersListRef={chaptersListRef}
        chaptersOpen={chaptersOpen}
        closeReadalong={closeReadalong}
        completionError={completionError}
        completionPendingBookId={completionPendingBookId}
        currentTrack={currentTrack}
        demoMode={demoMode}
        descriptionCanExpand={descriptionCanExpand}
        descriptionExpanded={descriptionExpanded}
        displayBookRemainingSeconds={displayBookRemainingSeconds}
        downloadStatus={downloadStatus}
        downloadedBookIds={downloadedBookIds}
        finishBookDetailsBackSwipe={finishBookDetailsBackSwipe}
        handlePlayerPaneScroll={handlePlayerPaneScroll}
        hasNextChapter={hasNextChapter}
        hasPreviousChapter={hasPreviousChapter}
        isOperaLibre={isOperaLibre}
        isPlaying={isPlaying}
        isViewingPlayingBook={isViewingPlayingBook}
        jumpToChapter={jumpToChapter}
        jumpToChapterFromSheet={jumpToChapterFromSheet}
        jumpToPlayerTop={jumpToPlayerTop}
        localMode={localMode}
        metadataEditor={metadataEditor}
        native={native}
        nativePlayerView={nativePlayerView}
        nativeTab={nativeTab}
        nextChapter={nextChapter}
        nowPlayingBook={nowPlayingBook}
        offlineDownloads={offlineDownloads}
        openNativePlayerSheet={openNativePlayerSheet}
        openPlaybackView={openPlaybackView}
        playPending={playPending}
        playSelectedBook={playSelectedBook}
        playbackBook={playbackBook}
        playbackDescription={playbackDescription}
        playbackError={playbackError}
        playbackFold={playbackFold}
        playerPaneRef={playerPaneRef}
        position={position}
        readalong={readalong}
        readalongPanelElement={readalongPanelElement}
        readerPreferences={readerPreferences}
        restartOrPreviousChapter={restartOrPreviousChapter}
        returnToLibrary={returnToLibrary}
        scrollToPlayer={scrollToPlayer}
        scrubbedElapsed={scrubbedElapsed}
        seekBookPosition={seekBookPosition}
        seekBy={seekBy}
        seekTo={seekTo}
        selectedBook={selectedBook}
        selectedCanBoost={selectedCanBoost}
        selectedChapterSegments={selectedChapterSegments}
        selectedDescription={selectedDescription}
        selectedDownload={selectedDownload}
        selectedGain={selectedGain}
        selectedSharedReaders={selectedSharedReaders}
        setChaptersOpen={setChaptersOpen}
        setDescriptionExpanded={setDescriptionExpanded}
        setLibraryOpen={setLibraryOpen}
        setScrubPreview={setScrubPreview}
        setSelectedBookId={setSelectedBookId}
        setShowChapterJumpTop={setShowChapterJumpTop}
        setVolume={setVolume}
        showChapterJumpTop={showChapterJumpTop}
        sleepTimer={sleepTimer}
        sliderMax={sliderMax}
        speed={speed}
        togglePlayback={togglePlayback}
        trackListSectionRef={trackListSectionRef}
        upcomingChapters={upcomingChapters}
        updateBookGain={updateBookGain}
        updateSpeed={updateSpeed}
        uploads={uploads}
        volume={volume}
        withWebViewTransition={withWebViewTransition}
      />

      {playbackBook && currentTrack ? (
        <MiniPlayer
          activeChapter={activeChapter}
          chapterDuration={chapterDuration}
          chapterElapsed={chapterElapsed}
          currentTrack={currentTrack}
          hasNextChapter={hasNextChapter}
          hasPreviousChapter={hasPreviousChapter}
          isPlaying={isPlaying}
          miniPlayerRef={miniPlayerRef}
          nextChapter={nextChapter}
          playPending={playPending}
          playbackBook={playbackBook}
          position={position}
          restartOrPreviousChapter={restartOrPreviousChapter}
          scrollToPlayer={scrollToPlayer}
          scrubbedElapsed={scrubbedElapsed}
          seekBookPosition={seekBookPosition}
          seekBy={seekBy}
          seekTo={seekTo}
          setScrubPreview={setScrubPreview}
          sliderMax={sliderMax}
          togglePlayback={togglePlayback}
        />
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
        <SettingsPage
          applyAdminLibraryChange={applyAdminLibraryChange}
          audibleManagement={audibleManagement}
          audioRef={audioRef}
          books={books}
          capabilities={capabilities}
          currentUser={currentUser}
          demoMode={demoMode}
          deviceDownloadQueue={deviceDownloadQueue}
          deviceImport={deviceImport}
          displaySettings={displaySettings}
          downloadStatus={downloadStatus}
          downloadedBookIds={downloadedBookIds}
          gamesEnabled={gamesEnabled}
          ios={ios}
          isOperaLibre={isOperaLibre}
          loadBooks={loadBooks}
          localMode={localMode}
          nativeTab={nativeTab}
          offlineDownloads={offlineDownloads}
          onConnectServer={onConnectServer}
          onCurrentUserChanged={onCurrentUserChanged}
          onLogout={onLogout}
          openNativeTab={openNativeTab}
          pausePlayback={pausePlayback}
          purchases={purchases}
          readalong={readalong}
          readerPreferences={readerPreferences}
          rotationLockAvailable={rotationLockAvailable}
          serverAliasesState={serverAliasesState}
          setBooks={setBooks}
          sharedProgressAvailable={sharedProgressAvailable}
          speed={speed}
          toggleGamesEnabled={toggleGamesEnabled}
          updateSpeed={updateSpeed}
          uploads={uploads}
        />
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
