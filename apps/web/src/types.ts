export type Track = {
  id: string;
  title: string;
  fileName: string;
  index: number;
  durationSeconds: number | null;
  streamUrl: string;
  chapters: Chapter[];
  metadata: MetadataSummary;
};

export type Book = {
  id: string;
  title: string;
  author: string | null;
  narrator: string | null;
  durationSeconds: number | null;
  trackCount: number;
  coverArtUrl: string | null;
  description: string | null;
  genres: string[];
  publishedDate: string | null;
  asin: string | null;
  readingFile: ReadingFile | null;
  chapters: Chapter[];
  metadata: MetadataSummary;
  tracks: Track[];
  progress: BookProgress | null;
};

export type ReadingFile = {
  id: string;
  fileName: string;
  extension: string;
  contentType: string;
  url: string;
};

export type BookProgress = {
  status: "notStarted" | "inProgress" | "finished";
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
};

export type LibationAccount = {
  accountId: string;
  name: string | null;
  locale: string;
  scanLibrary: boolean;
  authenticated: boolean;
};

export type LibationStatus = {
  enabled: boolean;
  cliPath: string | null;
  libationFilesDir: string | null;
  libraryRoot: string;
  accounts: LibationAccount[];
  authenticated: boolean;
  message: string | null;
};

export type LibationBook = {
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
  localBookId: string | null;
};

export type JobStatus = {
  id: string;
  kind: string;
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

export type AuthUser = {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
};

export type AuthStatus = {
  setupRequired: boolean;
  user: AuthUser | null;
};

export type LoginResponse = {
  token: string;
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
