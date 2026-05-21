import {
  AlertCircle,
  Bookmark,
  Cloud,
  CloudDownload,
  Download,
  Gauge,
  Headphones,
  KeyRound,
  LoaderCircle,
  LayoutGrid,
  Library,
  List,
  ListMusic,
  LogOut,
  Pause,
  Play,
  RefreshCcw,
  RotateCcw,
  RotateCw,
  Search,
  ServerOff,
  Timer,
  ScrollText,
  UserCog,
  Volume2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bookDownloadUrl,
  getAuthStatus,
  getBooks,
  getJob,
  getLibationBooks,
  getLibationStatus,
  getMe,
  getProgress,
  getStoredToken,
  liberateLibationBook,
  logout as apiLogout,
  mediaUrl,
  rescanLibrary,
  saveProgress,
  setStoredToken,
  setUnauthorizedHandler,
  syncLibationLibrary
} from "./api";
import { AuthGate, UserManagementModal } from "./Auth";
import { ProfilePage } from "./Profile";
import type { AuthUser, Book, Chapter, JobStatus, LibationBook, LibationStatus, Track } from "./types";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEP_OPTIONS = [0, 15, 30, 45, 60];

type SortMode = "title" | "author" | "duration" | "tracks";
type ViewMode = "list" | "grid";
type LibrarySource = "local" | "audible";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "title", label: "Title" },
  { value: "author", label: "Author" },
  { value: "duration", label: "Length" },
  { value: "tracks", label: "Tracks" }
];

function formatTime(value: number | null | undefined) {
  if (!Number.isFinite(value ?? NaN)) {
    return "--:--";
  }

  const totalSeconds = Math.max(0, Math.floor(value ?? 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function bookSubtitle(book: Book) {
  return [book.author, book.narrator ? `Narrated by ${book.narrator}` : null]
    .filter(Boolean)
    .join(" • ");
}

function currentTrackIndex(book: Book | null, track: Track | null) {
  if (!book || !track) {
    return 0;
  }
  return Math.max(0, book.tracks.findIndex((candidate) => candidate.id === track.id));
}

function trackOffsetSeconds(book: Book, trackIndex: number) {
  return book.tracks
    .slice(0, Math.max(0, trackIndex))
    .reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
}

function durationFromTracks(book: Book) {
  return book.tracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
}

function formatMinutes(minutes: number | null | undefined) {
  if (!Number.isFinite(minutes ?? NaN)) {
    return "Unknown length";
  }
  const totalMinutes = Math.max(0, Math.round(minutes ?? 0));
  const hours = Math.floor(totalMinutes / 60);
  const remainder = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function formatElapsed(startedAt: string | null | undefined, finishedAt?: string | null) {
  if (!startedAt) {
    return null;
  }
  const start = Number(new Date(startedAt));
  const end = finishedAt ? Number(new Date(finishedAt)) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return formatDurationLabel((end - start) / 1000);
}

function jobTitle(job: JobStatus) {
  if (job.kind === "libation-sync") {
    return "Audible library sync";
  }
  if (job.kind === "libation-liberate") {
    return "Audible download";
  }
  return job.kind;
}

function jobDetailLines(job: JobStatus) {
  const text = [job.error, job.output].filter(Boolean).join("\n");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12);
}

function jobSummary(job: JobStatus) {
  if (job.error) {
    return job.error;
  }
  const lines = job.output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const latest = lines[lines.length - 1];
  if (latest) {
    return latest;
  }
  return job.status === "running" ? "Waiting for Libation output..." : "No output captured.";
}

function formatDurationLabel(seconds: number | null | undefined) {
  if (!Number.isFinite(seconds ?? NaN)) {
    return null;
  }
  const totalMinutes = Math.max(0, Math.ceil((seconds ?? 0) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${Math.max(1, minutes)}m`;
}

function bookProgressLabel(book: Book) {
  if (!book.progress) {
    return "Not started";
  }
  if (book.progress.status === "finished") {
    return "Finished";
  }
  const remaining = formatDurationLabel(book.progress.remainingSeconds);
  if (remaining) {
    return `${remaining} left`;
  }
  if (book.progress.status === "inProgress") {
    return "In progress";
  }
  return "Not started";
}

function isLiberatedStatus(status: string | null | undefined) {
  const normalized = status?.toLowerCase() ?? "";
  return normalized.includes("liberated") || normalized.includes("downloaded");
}

function CoverArt({ book, size }: { book: Book; size: "small" | "large" }) {
  const className = size === "small" ? "cover-mark" : "large-cover";
  if (book.coverArtUrl) {
    return <img className={className} src={mediaUrl(book.coverArtUrl)} alt="" />;
  }
  return (
    <span className={className} aria-hidden="true">
      <Headphones size={size === "small" ? 22 : 42} strokeWidth={1.25} />
    </span>
  );
}

export default function App() {
  const [authState, setAuthState] = useState<
    { phase: "loading" }
    | { phase: "setup" }
    | { phase: "login" }
    | { phase: "ready"; user: AuthUser }
  >({ phase: "loading" });

  const checkAuth = useCallback(async () => {
    try {
      const status = await getAuthStatus();
      if (status.setupRequired) {
        setStoredToken(null);
        setAuthState({ phase: "setup" });
        return;
      }
      if (status.user) {
        setAuthState({ phase: "ready", user: status.user });
        return;
      }
      const token = getStoredToken();
      if (!token) {
        setAuthState({ phase: "login" });
        return;
      }
      try {
        const user = await getMe();
        setAuthState({ phase: "ready", user });
      } catch {
        setStoredToken(null);
        setAuthState({ phase: "login" });
      }
    } catch {
      setAuthState({ phase: "login" });
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setStoredToken(null);
      setAuthState({ phase: "login" });
    });
    void checkAuth();
    return () => setUnauthorizedHandler(null);
  }, [checkAuth]);

  if (authState.phase === "loading") {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <p>Loading…</p>
        </div>
      </main>
    );
  }

  if (authState.phase === "setup" || authState.phase === "login") {
    return (
      <AuthGate
        mode={authState.phase}
        onAuthenticated={(token, user) => {
          setStoredToken(token);
          setAuthState({ phase: "ready", user });
        }}
      />
    );
  }

  return (
    <MainApp
      currentUser={authState.user}
      onLogout={async () => {
        try {
          await apiLogout();
        } catch {
          // ignore
        }
        setStoredToken(null);
        setAuthState({ phase: "login" });
      }}
    />
  );
}

function MainApp({
  currentUser,
  onLogout
}: {
  currentUser: AuthUser;
  onLogout: () => void | Promise<void>;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playerPaneRef = useRef<HTMLElement | null>(null);
  const saveStartedAt = useRef(0);
  const [books, setBooks] = useState<Book[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [playbackBookId, setPlaybackBookId] = useState<string | null>(null);
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(0.9);
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [sleepEndsAt, setSleepEndsAt] = useState<number | null>(null);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("title");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [librarySource, setLibrarySource] = useState<LibrarySource>("local");
  const [searchQuery, setSearchQuery] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libationStatus, setLibationStatus] = useState<LibationStatus | null>(null);
  const [libationBooks, setLibationBooks] = useState<LibationBook[]>([]);
  const [libationLoading, setLibationLoading] = useState(false);
  const [libationBooksLoaded, setLibationBooksLoaded] = useState(false);
  const [libationError, setLibationError] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<JobStatus | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const visibleBooks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = query
      ? books.filter((book) =>
          [book.title, book.author, book.narrator]
            .filter(Boolean)
            .some((field) => field!.toLowerCase().includes(query))
        )
      : books;

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortMode) {
        case "author":
          return (a.author ?? "").localeCompare(b.author ?? "") || a.title.localeCompare(b.title);
        case "duration":
          return (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0);
        case "tracks":
          return b.trackCount - a.trackCount;
        case "title":
        default:
          return a.title.localeCompare(b.title);
      }
    });
    return sorted;
  }, [books, searchQuery, sortMode]);

  const visibleLibationBooks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = query
      ? libationBooks.filter((book) =>
          [book.title, book.subtitle, book.authors, book.narrators]
            .filter(Boolean)
            .some((field) => field!.toLowerCase().includes(query))
        )
      : libationBooks;

    return [...filtered].sort((a, b) => a.title.localeCompare(b.title));
  }, [libationBooks, searchQuery]);

  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedBookId) ?? books[0] ?? null,
    [books, selectedBookId]
  );

  const playbackBook = useMemo(
    () =>
      books.find((book) => book.id === playbackBookId) ??
      selectedBook ??
      books[0] ??
      null,
    [books, playbackBookId, selectedBook]
  );

  const currentTrack = useMemo(() => {
    if (!playbackBook) {
      return null;
    }
    return (
      playbackBook.tracks.find((track) => track.id === currentTrackId) ??
      playbackBook.tracks[0] ??
      null
    );
  }, [currentTrackId, playbackBook]);

  const activeTrackIndex = currentTrackIndex(playbackBook, currentTrack);
  const streamUrl = currentTrack ? mediaUrl(currentTrack.streamUrl) : "";
  const sliderMax = duration || currentTrack?.durationSeconds || 0;
  const bookDuration = playbackBook?.durationSeconds ?? (playbackBook ? durationFromTracks(playbackBook) : 0);
  const bookPosition =
    playbackBook && currentTrack
      ? trackOffsetSeconds(playbackBook, activeTrackIndex) + position
      : 0;
  const chapterSegments = useMemo(() => {
    if (!playbackBook || !bookDuration || playbackBook.chapters.length === 0) {
      return [];
    }

    return playbackBook.chapters.map((chapter, index) => {
      const nextChapter = playbackBook.chapters[index + 1];
      const endSeconds = chapter.endSeconds ?? nextChapter?.startSeconds ?? bookDuration;
      return {
        ...chapter,
        chapterNumber: index + 1,
        endSeconds: Math.max(chapter.startSeconds, Math.min(endSeconds, bookDuration)),
        durationSeconds: Math.max(1, Math.min(endSeconds, bookDuration) - chapter.startSeconds)
      };
    });
  }, [bookDuration, playbackBook]);
  const activeChapter =
    chapterSegments.find(
      (chapter) => bookPosition >= chapter.startSeconds && bookPosition < chapter.endSeconds
    ) ?? chapterSegments[chapterSegments.length - 1] ?? null;
  const chapterElapsed = activeChapter
    ? Math.max(0, bookPosition - activeChapter.startSeconds)
    : position;
  const chapterDuration = activeChapter
    ? Math.max(1, activeChapter.endSeconds - activeChapter.startSeconds)
    : Math.max(1, sliderMax);
  const isViewingPlayingBook = !!selectedBook && !!playbackBook && selectedBook.id === playbackBook.id;

  const loadBooks = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const nextBooks = await getBooks();
      setBooks(nextBooks);
      setSelectedBookId((existing) => existing ?? nextBooks[0]?.id ?? null);
      setPlaybackBookId((existing) => existing ?? nextBooks[0]?.id ?? null);
    } catch {
      setError("The audiobook server is not reachable.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBooks();
  }, [loadBooks]);

  const loadLibationStatus = useCallback(async () => {
    try {
      const status = await getLibationStatus();
      setLibationStatus(status);
    } catch {
      setLibationStatus(null);
    }
  }, []);

  const loadLibationBooks = useCallback(async () => {
    setLibationLoading(true);
    setLibationError(null);
    try {
      const nextBooks = await getLibationBooks();
      setLibationBooks(nextBooks);
      setLibationBooksLoaded(true);
    } catch {
      setLibationError("Libation books could not be loaded.");
      setLibationBooksLoaded(true);
    } finally {
      setLibationLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLibationStatus();
  }, [loadLibationStatus]);

  useEffect(() => {
    if (librarySource === "audible" && libationStatus?.enabled && !libationBooksLoaded && !libationLoading) {
      void loadLibationBooks();
    }
  }, [libationBooksLoaded, libationLoading, libationStatus?.enabled, librarySource, loadLibationBooks]);

  useEffect(() => {
    if (!activeJob || activeJob.status !== "running") {
      return;
    }

    const timer = window.setInterval(() => {
      void getJob(activeJob.id)
        .then((job) => {
          setActiveJob(job);
          if (job.status !== "running") {
            void loadLibationStatus();
            void loadLibationBooks();
            void loadBooks();
          }
        })
        .catch(() => undefined);
    }, 1800);

    return () => window.clearInterval(timer);
  }, [activeJob, loadBooks, loadLibationBooks, loadLibationStatus]);

  useEffect(() => {
    if (!playbackBook) {
      return;
    }

    let cancelled = false;
    void getProgress(playbackBook.id)
      .then((progress) => {
        if (cancelled) {
          return;
        }
        const savedTrack = playbackBook.tracks.find((track) => track.id === progress?.trackId);
        setCurrentTrackId(savedTrack?.id ?? playbackBook.tracks[0]?.id ?? null);
        setPendingSeek(savedTrack ? progress?.positionSeconds ?? 0 : 0);
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentTrackId(playbackBook.tracks[0]?.id ?? null);
          setPendingSeek(0);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [playbackBook]);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!playbackBook || !currentTrack || !("mediaSession" in navigator)) {
      return;
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: playbackBook.author ?? "Audiobook",
      album: playbackBook.title
    });
    navigator.mediaSession.setActionHandler("play", () => void audioRef.current?.play());
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
    navigator.mediaSession.setActionHandler("seekbackward", () => seekBy(-15));
    navigator.mediaSession.setActionHandler("seekforward", () => seekBy(30));
  }, [currentTrack, playbackBook]);

  useEffect(() => {
    if (sleepMinutes <= 0) {
      setSleepEndsAt(null);
      setSleepRemaining(0);
      return;
    }
    setSleepEndsAt(Date.now() + sleepMinutes * 60 * 1000);
  }, [sleepMinutes]);

  useEffect(() => {
    if (!sleepEndsAt) {
      return;
    }

    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((sleepEndsAt - Date.now()) / 1000));
      setSleepRemaining(remaining);
      if (remaining === 0) {
        audioRef.current?.pause();
        setSleepMinutes(0);
        setSleepEndsAt(null);
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [sleepEndsAt]);

  useEffect(() => {
    const saveBeforeLeaving = () => {
      void persistProgress();
    };
    const saveWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        void persistProgress();
      }
    };

    window.addEventListener("pagehide", saveBeforeLeaving);
    document.addEventListener("visibilitychange", saveWhenHidden);

    return () => {
      window.removeEventListener("pagehide", saveBeforeLeaving);
      document.removeEventListener("visibilitychange", saveWhenHidden);
    };
  }, [playbackBook, currentTrack, activeTrackIndex]);

  async function persistProgress() {
    if (!playbackBook || !currentTrack || !audioRef.current) {
      return;
    }

    const saved = await saveProgress(playbackBook.id, {
      trackId: currentTrack.id,
      positionSeconds: audioRef.current.currentTime,
      bookPositionSeconds:
        trackOffsetSeconds(playbackBook, activeTrackIndex) + audioRef.current.currentTime,
      durationSeconds: Number.isFinite(audioRef.current.duration)
        ? audioRef.current.duration
        : currentTrack.durationSeconds
    }).catch(() => undefined);
    if (!saved) {
      return;
    }

    setBooks((existing) =>
      existing.map((book) => {
        if (book.id !== playbackBook.id) {
          return book;
        }
        const durationSeconds = book.durationSeconds ?? durationFromTracks(book);
        const remainingSeconds =
          durationSeconds > 0
            ? Math.max(0, durationSeconds - saved.bookPositionSeconds)
            : null;
        const percentComplete =
          durationSeconds > 0
            ? Math.min(100, Math.max(0, (saved.bookPositionSeconds / durationSeconds) * 100))
            : null;
        const status =
          durationSeconds > 0 && remainingSeconds !== null && (remainingSeconds <= 30 || percentComplete! >= 99.5)
            ? "finished"
            : saved.bookPositionSeconds > 0
              ? "inProgress"
              : "notStarted";
        return {
          ...book,
          progress: {
            status,
            bookPositionSeconds: saved.bookPositionSeconds,
            durationSeconds: durationSeconds > 0 ? durationSeconds : null,
            remainingSeconds,
            percentComplete,
            updatedAt: saved.updatedAt
          }
        };
      })
    );
  }

  function onTimeUpdate() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    setPosition(audio.currentTime);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);

    const now = Date.now();
    if (now - saveStartedAt.current > 5000) {
      saveStartedAt.current = now;
      void persistProgress();
    }
  }

  function onLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.playbackRate = speed;
    audio.volume = volume;
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);

    if (pendingSeek !== null) {
      audio.currentTime = Math.min(pendingSeek, audio.duration || pendingSeek);
      setPosition(audio.currentTime);
      setPendingSeek(null);
    } else {
      setPosition(0);
    }
  }

  function seekBy(delta: number) {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.currentTime = Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + delta));
    setPosition(audio.currentTime);
    void persistProgress();
  }

  function seekTo(value: number) {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.currentTime = value;
    setPosition(value);
    void persistProgress();
  }

  function seekBookPosition(value: number, autoPlay = false) {
    if (!playbackBook) {
      return;
    }

    const clampedValue = Math.max(0, Math.min(value, bookDuration || value));
    let offset = 0;
    let targetTrack = playbackBook.tracks[0];

    for (const track of playbackBook.tracks) {
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
    if (targetTrack.id === currentTrack?.id && audioRef.current) {
      audioRef.current.currentTime = trackPosition;
      setPosition(trackPosition);
      void persistProgress();
      if (autoPlay) {
        void audioRef.current.play();
      }
      return;
    }

    setCurrentTrackId(targetTrack.id);
    setPendingSeek(trackPosition);
    setPosition(trackPosition);
    if (autoPlay) {
      window.setTimeout(() => void audioRef.current?.play(), 0);
    }
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  }

  function selectBook(book: Book) {
    setSelectedBookId(book.id);
  }

  function selectTrack(track: Track, autoPlay = true) {
    void persistProgress();
    if (selectedBook) {
      setPlaybackBookId(selectedBook.id);
    }
    setCurrentTrackId(track.id);
    setPendingSeek(0);
    setPosition(0);
    if (autoPlay) {
      window.setTimeout(() => void audioRef.current?.play(), 0);
    }
  }

  function jumpToChapter(chapter: Chapter) {
    if (!selectedBook) {
      return;
    }
    const track = selectedBook.tracks.find((candidate) => candidate.id === chapter.trackId);
    if (!track) {
      return;
    }

    void persistProgress();
    setPlaybackBookId(selectedBook.id);
    const trackOffset = trackOffsetSeconds(selectedBook, chapter.trackIndex);
    setCurrentTrackId(track.id);
    setPendingSeek(Math.max(0, chapter.startSeconds - trackOffset));
    setPosition(Math.max(0, chapter.startSeconds - trackOffset));
    window.setTimeout(() => void audioRef.current?.play(), 0);
  }

  function playNextTrack() {
    void persistProgress();
    if (!playbackBook || activeTrackIndex >= playbackBook.tracks.length - 1) {
      setIsPlaying(false);
      return;
    }
    setCurrentTrackId(playbackBook.tracks[activeTrackIndex + 1].id);
    setPendingSeek(0);
    setPosition(0);
  }

  function scrollToPlayer() {
    if (playbackBook) {
      setSelectedBookId(playbackBook.id);
    }
    playerPaneRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function refreshLibrary() {
    setIsLoading(true);
    try {
      const nextBooks = await rescanLibrary();
      setBooks(nextBooks);
      setSelectedBookId((existing) =>
        nextBooks.some((book) => book.id === existing) ? existing : nextBooks[0]?.id ?? null
      );
      setError(null);
    } catch {
      setError("Library rescan failed.");
    } finally {
      setIsLoading(false);
    }
  }

  async function startLibationSync() {
    setLibationError(null);
    setLibationBooksLoaded(false);
    try {
      const created = await syncLibationLibrary();
      setActiveJob({
        id: created.jobId,
        kind: "libation-sync",
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        output: "Starting Libation library scan.",
        error: null
      });
    } catch {
      setLibationError("Libation sync could not be started.");
    }
  }

  async function startLiberation(book: LibationBook) {
    setLibationError(null);
    setLibationBooksLoaded(false);
    try {
      const created = await liberateLibationBook(book.asin);
      setActiveJob({
        id: created.jobId,
        kind: "libation-liberate",
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        output: `Starting liberation for ${book.title}.`,
        error: null
      });
    } catch {
      setLibationError(`Liberation could not be started for ${book.title}.`);
    }
  }

  return (
    <main className="shell">
      <audio
        ref={audioRef}
        src={streamUrl}
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onPlay={() => setIsPlaying(true)}
        onPause={() => {
          setIsPlaying(false);
          void persistProgress();
        }}
        onEnded={playNextTrack}
      />

      <button
        type="button"
        className={`library-scrim ${libraryOpen ? "show" : ""}`}
        aria-hidden={!libraryOpen}
        tabIndex={-1}
        onClick={() => setLibraryOpen(false)}
      />

      <aside className={`library-pane ${libraryOpen ? "open" : ""}`}>
        <div className="pane-title">
          <div>
            <span className="eyebrow"><Library size={13} /> The Collection</span>
            <h1>Audio <span className="amp">&amp;</span> Books</h1>
          </div>
          <div className="pane-actions">
            <button className="icon-button" aria-label="Rescan library" onClick={() => void refreshLibrary()}>
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
              {userMenuOpen ? (
                <div className="user-menu" role="menu">
                  <div className="user-menu-head">
                    <strong>{currentUser.username}</strong>
                    <span>{currentUser.isAdmin ? "Administrator" : "Reader"}</span>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setUserMenuOpen(false);
                      setProfileOpen(true);
                    }}
                  >
                    <ScrollText size={14} /> Reader's ledger
                  </button>
                  {currentUser.isAdmin ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        setUsersModalOpen(true);
                      }}
                    >
                      <UserCog size={14} /> Manage readers
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setUserMenuOpen(false);
                      void onLogout();
                    }}
                  >
                    <LogOut size={14} /> Sign out
                  </button>
                </div>
              ) : null}
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
          <label className="library-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              placeholder={librarySource === "local" ? "Search title, author…" : "Search Audible titles…"}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              aria-label="Search library"
            />
          </label>

          <div className="library-controls">
            <label className="library-sort">
              <span className="sr-only">Sort by</span>
              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.currentTarget.value as SortMode)}
                aria-label="Sort library by"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="view-toggle" role="group" aria-label="View mode">
              <button
                className={viewMode === "list" ? "selected" : ""}
                onClick={() => setViewMode("list")}
                aria-label="List view"
                aria-pressed={viewMode === "list"}
              >
                <List size={14} />
              </button>
              <button
                className={viewMode === "grid" ? "selected" : ""}
                onClick={() => setViewMode("grid")}
                aria-label="Grid view"
                aria-pressed={viewMode === "grid"}
              >
                <LayoutGrid size={14} />
              </button>
            </div>
          </div>

          <div className="source-toggle" role="group" aria-label="Library source">
            <button
              type="button"
              className={librarySource === "local" ? "selected" : ""}
              onClick={() => setLibrarySource("local")}
              aria-pressed={librarySource === "local"}
            >
              <Library size={13} />
              <span>Local</span>
            </button>
            <button
              type="button"
              className={librarySource === "audible" ? "selected" : ""}
              onClick={() => setLibrarySource("audible")}
              aria-pressed={librarySource === "audible"}
            >
              <Cloud size={13} />
              <span>Audible</span>
            </button>
          </div>
        </div>

        {librarySource === "audible" ? (
          <section className="libation-panel">
            <div className="libation-status">
              {libationStatus?.enabled ? <Cloud size={15} /> : <ServerOff size={15} />}
              <span>
                {libationStatus?.enabled
                  ? libationStatus.authenticated
                    ? "Libation ready"
                    : "Libation needs sign-in"
                  : "Libation not configured"}
              </span>
            </div>

            {libationStatus?.message ? <p>{libationStatus.message}</p> : null}

            {libationStatus?.accounts.length ? (
              <div className="account-list">
                {libationStatus.accounts.map((account) => (
                  <span key={`${account.accountId}-${account.locale}`} className={account.authenticated ? "ok" : "warn"}>
                    <KeyRound size={12} />
                    {account.name || account.accountId} · {account.locale}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="libation-actions">
              <button
                type="button"
                onClick={() => void loadLibationBooks()}
                disabled={!libationStatus?.enabled || libationLoading || activeJob?.status === "running"}
              >
                <RefreshCcw size={13} />
                <span>{libationLoading ? "Loading" : "Load"}</span>
              </button>
              <button
                type="button"
                onClick={() => void startLibationSync()}
                disabled={!libationStatus?.enabled || libationLoading || activeJob?.status === "running"}
              >
                <CloudDownload size={13} />
                <span>Sync</span>
              </button>
            </div>

            {activeJob ? (
              <div className={`job-card ${activeJob.status}`}>
                <div className="job-card-head">
                  <span className="job-state">
                    {activeJob.status === "running" ? (
                      <LoaderCircle size={13} />
                    ) : activeJob.status === "failed" ? (
                      <AlertCircle size={13} />
                    ) : (
                      <CloudDownload size={13} />
                    )}
                    {activeJob.status === "running" ? "Running" : activeJob.status}
                  </span>
                  <strong>{jobTitle(activeJob)}</strong>
                </div>
                <p>{jobSummary(activeJob)}</p>
                <dl className="job-meta">
                  <div>
                    <dt>Elapsed</dt>
                    <dd>{formatElapsed(activeJob.startedAt, activeJob.finishedAt) ?? "Starting"}</dd>
                  </div>
                  {activeJob.exitCode !== null ? (
                    <div>
                      <dt>Exit</dt>
                      <dd>{activeJob.exitCode}</dd>
                    </div>
                  ) : null}
                </dl>
                {activeJob.status !== "running" || activeJob.error ? (
                  <pre className="job-output">{jobDetailLines(activeJob).join("\n")}</pre>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {librarySource === "local" ? (
          <>
            {isLoading ? <div className="empty-state">Loading library…</div> : null}
            {error ? <div className="empty-state error">{error}</div> : null}
            {!isLoading && !error && books.length === 0 ? (
              <div className="empty-state">No audiobooks found in the configured library folder.</div>
            ) : null}
            {!isLoading && !error && books.length > 0 && visibleBooks.length === 0 ? (
              <div className="empty-state">Nothing matches “{searchQuery}”.</div>
            ) : null}

            <div className={`book-list ${viewMode === "grid" ? "is-grid" : "is-list"}`}>
              {visibleBooks.map((book, index) => {
                const progressPercent = book.progress?.percentComplete ?? 0;
                return (
                  <button
                    key={book.id}
                    className={`book-row ${book.id === selectedBook?.id ? "active" : ""}`}
                    onClick={() => {
                      selectBook(book);
                      setLibraryOpen(false);
                    }}
                  >
                    {viewMode === "grid" || book.coverArtUrl ? (
                      <CoverArt book={book} size="small" />
                    ) : (
                      <span className="index">{String(index + 1).padStart(2, "0")}</span>
                    )}
                    <span className="book-text">
                      <strong>{book.title}</strong>
                      <span>{bookSubtitle(book) || `${book.trackCount} track${book.trackCount === 1 ? "" : "s"}`}</span>
                      {formatDurationLabel(book.durationSeconds ?? durationFromTracks(book)) ? (
                        <span className="book-runtime-tag">
                          <Timer size={11} strokeWidth={1.5} />
                          {formatDurationLabel(book.durationSeconds ?? durationFromTracks(book))}
                        </span>
                      ) : null}
                      <span className={`book-progress ${book.progress?.status ?? "notStarted"}`}>
                        <em>{bookProgressLabel(book)}</em>
                        {book.progress?.status === "inProgress" && book.progress.percentComplete !== null ? (
                          <i style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }} />
                        ) : null}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            {libationLoading || (libationStatus?.enabled && !libationBooksLoaded) ? (
              <div className="empty-state">Loading Audible library…</div>
            ) : null}
            {libationError ? <div className="empty-state error">{libationError}</div> : null}
            {!libationLoading && !libationError && libationBooksLoaded && libationStatus?.enabled && visibleLibationBooks.length === 0 ? (
              <div className="empty-state">No Libation books loaded yet.</div>
            ) : null}

            <div className="audible-list">
              {visibleLibationBooks.map((book) => {
                const isLocal = !!book.localBookId;
                const metaParts = [
                  book.authors,
                  formatMinutes(book.lengthMinutes),
                  isLocal ? "In library" : book.bookStatus
                ].filter(Boolean);
                return (
                  <div key={book.asin} className={`audible-row ${isLocal ? "is-local" : ""}`}>
                    <div>
                      <strong>{book.title}</strong>
                      <span>{metaParts.join(" · ")}</span>
                    </div>
                    {isLocal ? (
                      <button
                        type="button"
                        className="local-marker"
                        aria-label={`Open ${book.title} from the local library`}
                        onClick={() => {
                          if (!book.localBookId) {
                            return;
                          }
                          setSelectedBookId(book.localBookId);
                          setLibrarySource("local");
                          setLibraryOpen(false);
                        }}
                      >
                        <Library size={14} />
                        <span>In library</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={`${isLiberatedStatus(book.bookStatus) ? "Sync" : "Liberate"} ${book.title}`}
                        disabled={activeJob?.status === "running"}
                        onClick={() => void startLiberation(book)}
                      >
                        <CloudDownload size={14} />
                        <span>{isLiberatedStatus(book.bookStatus) ? "Sync" : "Liberate"}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </aside>

      <section className="player-pane" ref={playerPaneRef}>
        <button
          type="button"
          className="library-open-btn"
          aria-label="Open library"
          onClick={() => setLibraryOpen(true)}
        >
          <Library size={16} />
          <span>Library</span>
        </button>
        {selectedBook && currentTrack ? (
          <>
            <div className="folio">
              <span>Vol. I <span className="dot">·</span> The Reading Room</span>
              <span>Folio {String(activeTrackIndex + 1).padStart(3, "0")} / {String(selectedBook.tracks.length).padStart(3, "0")}</span>
            </div>

            <div className="book-heading">
              <CoverArt book={selectedBook} size="large" />
              <div className="meta">
                <div className="heading-top">
                  <span className="eyebrow"><Bookmark size={13} /> Now Reading</span>
                  <a
                    className="download-btn"
                    href={bookDownloadUrl(selectedBook.id)}
                    download
                    aria-label={`Download ${selectedBook.title} as zip`}
                  >
                    <Download size={13} />
                    <span>Download</span>
                  </a>
                </div>
                <h2>
                  {selectedBook.title.split(" ").map((word, i, arr) => {
                    const isLast = i === arr.length - 1;
                    return (
                      <span key={i}>
                        {isLast ? <em>{word}</em> : word}
                        {isLast ? "" : " "}
                      </span>
                    );
                  })}
                </h2>
                <p>{bookSubtitle(selectedBook) || `${selectedBook.trackCount} tracks`}</p>
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
              {selectedBook.publishedDate ? <span>{selectedBook.publishedDate}</span> : null}
              {selectedBook.metadata.publisher ? <span>{selectedBook.metadata.publisher}</span> : null}
              {selectedBook.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
              {selectedBook.chapters.length > 0 ? <span>{selectedBook.chapters.length} chapters</span> : null}
            </div>

            {selectedBook.description ? <p className="book-description">{selectedBook.description}</p> : null}

            {isViewingPlayingBook && currentTrack ? (
              <>
                <div className="track-line">
                  <span className="title">{currentTrack.title}</span>
                  <span className="ordinal">
                    {String(activeTrackIndex + 1).padStart(2, "0")} / {String(selectedBook.tracks.length).padStart(2, "0")}
                  </span>
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

                          return (
                            <button
                              key={chapter.id}
                              className={`chapter-segment ${isActive ? "active" : ""} ${isComplete ? "complete" : ""}`}
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
                      <input
                        aria-label={`Playback position in ${activeChapter.title}`}
                        type="range"
                        min="0"
                        max={chapterDuration}
                        step="1"
                        value={Math.min(chapterElapsed, chapterDuration)}
                        onChange={(event) =>
                          seekBookPosition(activeChapter.startSeconds + Number(event.currentTarget.value))
                        }
                      />
                    </>
                  ) : (
                    <input
                      aria-label="Playback position"
                      type="range"
                      min="0"
                      max={Math.max(1, sliderMax)}
                      step="1"
                      value={Math.min(position, Math.max(1, sliderMax))}
                      onChange={(event) => seekTo(Number(event.currentTarget.value))}
                    />
                  )}
                  <div className="time-row">
                    <span className="elapsed">
                      {activeChapter ? formatTime(chapterElapsed) : formatTime(position)}
                    </span>
                    <span>
                      {activeChapter ? formatTime(chapterDuration) : formatTime(sliderMax)}
                    </span>
                  </div>
                </div>

                <div className="transport">
                  <button className="round-button secondary" aria-label="Skip back 15 seconds" onClick={() => seekBy(-15)}>
                    <RotateCcw size={22} strokeWidth={1.5} />
                    <small>15s</small>
                  </button>
                  <button className="round-button primary" aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlayback}>
                    {isPlaying ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
                  </button>
                  <button className="round-button secondary" aria-label="Skip forward 30 seconds" onClick={() => seekBy(30)}>
                    <RotateCw size={22} strokeWidth={1.5} />
                    <small>30s</small>
                  </button>
                </div>
              </>
            ) : (
              <div className="book-preview-actions">
                <span>
                  {playbackBook ? (
                    <>Still playing <em>{playbackBook.title}</em></>
                  ) : (
                    <>Begin a new reading</>
                  )}
                </span>
                <button
                  type="button"
                  className="round-button primary"
                  aria-label={`Play ${selectedBook.title}`}
                  onClick={() => selectedBook.tracks[0] && selectTrack(selectedBook.tracks[0])}
                >
                  <Play size={30} fill="currentColor" />
                </button>
              </div>
            )}

            <div className="controls-grid">
              <section className="control-section">
                <div className="section-label"><Gauge size={13} /> Cadence</div>
                <div className="segmented">
                  {SPEEDS.map((option) => (
                    <button
                      key={option}
                      className={speed === option ? "selected" : ""}
                      onClick={() => setSpeed(option)}
                    >
                      {option}×
                    </button>
                  ))}
                </div>
              </section>

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

              <section className="control-section">
                <label className="section-label" htmlFor="sleep"><Timer size={13} /> Nightfall</label>
                <select
                  id="sleep"
                  value={sleepMinutes}
                  onChange={(event) => setSleepMinutes(Number(event.currentTarget.value))}
                >
                  {SLEEP_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option === 0 ? "—" : `${option} minutes`}
                    </option>
                  ))}
                </select>
                {sleepRemaining > 0 ? <span className="sleep-copy">{formatTime(sleepRemaining)} remaining</span> : null}
              </section>
            </div>

            <section className="track-list-section">
              <div className="track-list-header">
                <span className="title-of-contents">Table of Contents</span>
                <span className="section-label"><ListMusic size={13} /> {selectedBook.tracks.length} Chapters</span>
              </div>
              <div className="track-list">
                {selectedBook.tracks.map((track, index) => (
                  <button
                    key={track.id}
                    className={`track-row ${isViewingPlayingBook && track.id === currentTrack.id ? "active" : ""}`}
                    onClick={() => selectTrack(track)}
                  >
                    <span className="num">{String(index + 1).padStart(2, "0")}</span>
                    <strong>{track.title}</strong>
                    <em>{formatTime(track.durationSeconds)}</em>
                  </button>
                ))}
              </div>
            </section>

            {selectedBook.chapters.length > 0 ? (
              <section className="track-list-section">
                <div className="track-list-header">
                  <span className="title-of-contents">Embedded Chapters</span>
                  <span className="section-label"><ListMusic size={13} /> {selectedBook.chapters.length} Markers</span>
                </div>
                <div className="track-list">
                  {selectedBook.chapters.map((chapter, index) => (
                    <button
                      key={chapter.id}
                      className={`track-row ${isViewingPlayingBook && chapter.trackId === currentTrack.id && Math.abs(chapter.startSeconds - bookPosition) < 2 ? "active" : ""}`}
                      onClick={() => jumpToChapter(chapter)}
                    >
                      <span className="num">{String(index + 1).padStart(2, "0")}</span>
                      <strong>{chapter.title}</strong>
                      <em>{formatTime(chapter.startSeconds)}</em>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : (
          <div className="empty-player">
            <Headphones size={48} strokeWidth={1.25} />
            <h2>An empty <em>shelf</em></h2>
            <p>Start the server with AUDIOBOOK_LIBRARY pointed at your files.</p>
          </div>
        )}
      </section>

      {playbackBook && currentTrack ? (
        <aside className="mini-player" aria-label="Mini player">
          <button className="mini-cover-button" type="button" onClick={scrollToPlayer} aria-label="Open current book">
            <CoverArt book={playbackBook} size="small" />
          </button>

          <button className="mini-meta" type="button" onClick={scrollToPlayer}>
            <strong>{playbackBook.title}</strong>
            <span>{activeChapter?.title ?? currentTrack.title}</span>
          </button>

          <div className="mini-progress">
            <input
              aria-label="Mini player progress"
              type="range"
              min="0"
              max={activeChapter ? chapterDuration : Math.max(1, sliderMax)}
              step="1"
              value={activeChapter ? Math.min(chapterElapsed, chapterDuration) : Math.min(position, Math.max(1, sliderMax))}
              onChange={(event) => {
                const nextValue = Number(event.currentTarget.value);
                if (activeChapter) {
                  seekBookPosition(activeChapter.startSeconds + nextValue);
                } else {
                  seekTo(nextValue);
                }
              }}
            />
            <span>
              {activeChapter
                ? `${formatTime(chapterElapsed)} / ${formatTime(chapterDuration)}`
                : `${formatTime(position)} / ${formatTime(sliderMax)}`}
            </span>
          </div>

          <div className="mini-actions">
            <button type="button" aria-label="Skip back 15 seconds" onClick={() => seekBy(-15)}>
              <RotateCcw size={17} />
            </button>
            <button type="button" className="mini-play" aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlayback}>
              {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
            <button type="button" aria-label="Skip forward 30 seconds" onClick={() => seekBy(30)}>
              <RotateCw size={17} />
            </button>
          </div>
        </aside>
      ) : null}

      {profileOpen ? (
        <ProfilePage
          user={currentUser}
          onClose={() => setProfileOpen(false)}
          onOpenBook={(bookId) => {
            setSelectedBookId(bookId);
            setProfileOpen(false);
            setLibraryOpen(false);
          }}
        />
      ) : null}

      {usersModalOpen ? (
        <UserManagementModal
          currentUser={currentUser}
          onClose={() => setUsersModalOpen(false)}
        />
      ) : null}
    </main>
  );
}
