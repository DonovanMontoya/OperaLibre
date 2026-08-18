export type Track = {
  id: string;
  title: string;
  fileName: string;
  index: number;
  durationSeconds: number | null;
  streamUrl: string;
  downloadUrl?: string;
  chapters: Chapter[];
  metadata: MetadataSummary;
  /** App-private file copied from the iOS/Android document picker. */
  localFilePath?: string;
};

export type Book = {
  id: string;
  title: string;
  author: string | null;
  narrator: string | null;
  durationSeconds: number | null;
  trackCount: number;
  coverArtUrl: string | null;
  coverArtContentType: string | null;
  description: string | null;
  genres: string[];
  publishedDate: string | null;
  asin: string | null;
  readingFile: ReadingFile | null;
  syncFile: SyncFile | null;
  chapters: Chapter[];
  metadata: MetadataSummary;
  tracks: Track[];
  progress: BookProgress | null;
  /**
   * What the other listeners on this server have done with the book. Omitted
   * by Jellyfin, by device-only books, and whenever the viewer has turned
   * progress sharing off.
   */
  sharedProgress?: SharedProgress[];
  /** Device books need no server; matched server books may retain a device copy. */
  source?: "server" | "device";
  deviceBookId?: string;
  /** Cover art extracted from an imported file's tags, stored in app storage. */
  localCoverPath?: string;
  /**
   * The viewer's own playback gain for this book, as a linear multiplier of the
   * file's level. Absent on Jellyfin, on device-only books, and on OperaLibre
   * servers released before per-book volume; all of those mean unity.
   */
  volumeGain?: number;
};

export type SharedProgress = {
  userId: string;
  username: string;
  status: "notStarted" | "inProgress" | "finished";
  percentComplete: number | null;
  updatedAt: string;
};

export type BookMetadataUpdate = {
  title: string;
  author: string;
  narrator: string;
  description: string;
  genres: string[];
  publishedDate: string;
  publisher: string;
  series: string;
  seriesPosition: string;
  asin: string;
};

export type ReadingFile = {
  id: string;
  fileName: string;
  extension: string;
  contentType: string;
  url: string;
};

export type SyncFile = {
  fileName: string;
  source: "sidecar" | "generated" | string;
  url: string;
};

export type SyncFragment = {
  startSeconds: number;
  endSeconds: number;
  href: string;
  text: string;
};

export type SyncMap = {
  version: number;
  generator?: string | null;
  generatedAt?: string | null;
  fragments: SyncFragment[];
};

export type AlignmentStatus = {
  enabled: boolean;
  cliPath: string | null;
};

export type FaststartBookSummary = {
  bookId: string;
  title: string;
  pendingFiles: number;
  pendingBytes: number;
  /** Somebody's position moved recently, so the book is left for a later run. */
  inUse: boolean;
};

export type FaststartStatus = {
  enabled: boolean;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  /** Without ffprobe a conversion is only checked by container layout and size. */
  verificationLimited: boolean;
  mp4Files: number;
  optimizedFiles: number;
  pendingFiles: number;
  unreadableFiles: number;
  pendingBytes: number;
  books: FaststartBookSummary[];
  activeJobId: string | null;
};

export type BookProgress = {
  status: "notStarted" | "inProgress" | "finished";
  /** Explicit reader choice; null/undefined means infer completion from position. */
  finishedOverride?: boolean | null;
  bookPositionSeconds: number;
  durationSeconds: number | null;
  remainingSeconds: number | null;
  percentComplete: number | null;
  updatedAt: string;
};

export type Chapter = {
  id: string;
  title: string;
  trackId: string;
  trackIndex: number;
  startSeconds: number;
  endSeconds: number | null;
  source: string;
};

export type MetadataSummary = {
  album: string | null;
  subtitle: string | null;
  publisher: string | null;
  publishedDate: string | null;
  description: string | null;
  language: string | null;
  series: string | null;
  seriesPosition: string | null;
  genres: string[];
  rawFields: MetadataField[];
};

export type MetadataField = {
  key: string;
  value: string;
  description: string | null;
};

export type Progress = {
  bookId: string;
  trackId: string;
  positionSeconds: number;
  bookPositionSeconds: number;
  durationSeconds: number | null;
  updatedAt: string;
  /** Explicit reader choice; null/undefined means infer completion from position. */
  finishedOverride?: boolean | null;
};

export type LibationAccount = {
  id: string;
  accountId: string;
  name: string | null;
  locale: string;
  scanLibrary: boolean;
  authenticated: boolean;
  managed: boolean;
  connectionState: "connected" | "needs_sign_in" | "signing_in" | "error" | string;
  lastSuccessfulAuth: string | null;
  lastSuccessfulRefresh: string | null;
  lastError: string | null;
  addedBy: string | null;
  addedAt: string | null;
};

export type LibationStatus = {
  enabled: boolean;
  cliPath: string | null;
  libationFilesDir: string | null;
  libraryRoot: string;
  accounts: LibationAccount[];
  authenticated: boolean;
  message: string | null;
  autoRefreshHours: number | null;
  manualRefreshesPerHour: number;
};

export type LibationBook = {
  catalogId: string;
  profileId: string;
  profileName: string;
  accountId: string | null;
  asin: string;
  title: string;
  subtitle: string | null;
  authors: string | null;
  narrators: string | null;
  lengthMinutes: number | null;
  description: string | null;
  publisher: string | null;
  bookStatus: string | null;
  pdfStatus: string | null;
  contentType: string | null;
  locale: string | null;
  lastDownloaded: string | null;
  isAudiblePlus: boolean;
  coverArtUrl: string | null;
  localBookId: string | null;
};

export type LibationAccess = "direct" | "approval";

export type LibationAccessStatus = {
  enabled: boolean;
  libationAccess: LibationAccess;
  autoRefreshHours: number | null;
  manualRefreshesPerHour: number;
};

export type LibationDownloadRequest = {
  id: string;
  userId: string;
  username: string;
  asin: string;
  profileId: string | null;
  profileName: string | null;
  catalogId: string | null;
  title: string;
  status: "pending" | "approved" | "rejected" | string;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  jobId: string | null;
};

export type LibationLoginStarted = {
  sessionId: string;
  profileId: string;
  loginUrl: string;
  expiresAt: number;
};

export type JobStatus = {
  id: string;
  kind: string;
  targetId: string | null;
  status: "running" | "completed" | "failed" | string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  output: string;
  error: string | null;
};

export type JobCreated = {
  jobId: string;
};

export type UpdateStatus = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  canAutoUpdate: boolean;
  platform: string | null;
  releaseUrl: string;
  publishedAt: string | null;
  notes: string | null;
  message: string | null;
};

export type UpdateInstallStarted = {
  version: string;
  restarting: boolean;
};

export type FrontendUpdateStatus = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  canAutoUpdate: boolean;
  releaseUrl: string;
  publishedAt: string | null;
  notes: string | null;
  message: string | null;
};

export type AuthUser = {
  id: string;
  username: string;
  isAdmin: boolean;
  isOwner: boolean;
  canApproveLibationRequests: boolean;
  allowedBookIds: string[] | null;
  libationAccess: LibationAccess;
  /** Absent on servers released before progress sharing; treated as sharing. */
  shareProgress?: boolean;
  createdAt: string;
};

export type ServerType = "operalibre" | "jellyfin";

export type AuthStatus = {
  setupRequired: boolean;
  /** Newer OperaLibre servers require a one-time console token for remote setup. */
  setupTokenRequired?: boolean;
  /** True when this client must complete setup from the server machine instead. */
  setupLocalOnly?: boolean;
  user: AuthUser | null;
  /** Absent when connected to a server released before media tokens. */
  mediaToken?: string | null;
};

export type LoginResponse = {
  token: string;
  /** Absent when connected to a server released before media tokens. */
  mediaToken?: string;
  user: AuthUser;
};

export type ProfileStats = {
  totalHoursRead: number;
  booksFinished: number;
  totalTracksCompleted: number;
  currentStreakDays: number;
  longestStreakDays: number;
  avgDailyMinutes: number;
  lastListenedAt: string | null;
  favoriteNarrator: string | null;
  favoriteGenre: string | null;
  daysActive: number;
  memberSince: string;
  streakCalendar: StreakDay[];
  recentBooks: ProfileRecentBook[];
  /** First day the server measured listening, as YYYY-MM-DD. */
  measuringSince: string | null;
};

export type StreakDay = {
  date: string;
  minutes: number;
};

export type ProfileRecentBook = {
  id: string;
  title: string;
  coverArtUrl: string | null;
  hoursRead: number;
  finished: boolean;
  updatedAt: string;
};
