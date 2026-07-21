import { FilePicker, type PickedFile } from "@capawesome/capacitor-file-picker";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import type { AuthUser, Book, BookProgress, MetadataSummary, Progress, Track } from "./types";
import { deviceBookMatchesServer, progressTimestamp } from "./reliability";

const LIBRARY_KEY = "operalibre.deviceLibrary.v1";
const PROGRESS_KEY = "operalibre.deviceProgress.v1";
const LIBRARY_ROOT = "device-library";
const AUDIO_EXTENSIONS = new Set(["aac", "aiff", "flac", "m4a", "m4b", "mp3", "mp4", "ogg", "opus", "wav"]);

export const DEVICE_USER: AuthUser = {
  id: "device-reader",
  username: "Device reader",
  isAdmin: false,
  isOwner: false,
  canApproveLibationRequests: false,
  allowedBookIds: null,
  libationAccess: "approval",
  createdAt: "1970-01-01T00:00:00.000Z"
};

const EMPTY_METADATA: MetadataSummary = {
  album: null,
  subtitle: null,
  publisher: null,
  publishedDate: null,
  description: null,
  language: null,
  genres: [],
  rawFields: []
};

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

function naturalCompare(a: PickedFile, b: PickedFile) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function extension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function sanitizeSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function inferredTitle(name: string) {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[\s._-]*(?:track|chapter|part|cd|disc)?[\s._-]*\d+$/i, "")
    .replace(/[._]+/g, " ")
    .trim() || "Imported audiobook";
}

function progressSummary(book: Book, progress: Progress | null): BookProgress | null {
  if (!progress) return null;
  const duration = book.durationSeconds;
  const remaining = duration === null ? null : Math.max(0, duration - progress.bookPositionSeconds);
  const percent = duration && duration > 0 ? Math.min(100, (progress.bookPositionSeconds / duration) * 100) : null;
  return {
    status: remaining !== null && (remaining <= 30 || (percent ?? 0) >= 99.5)
      ? "finished"
      : progress.bookPositionSeconds > 0 ? "inProgress" : "notStarted",
    bookPositionSeconds: progress.bookPositionSeconds,
    durationSeconds: duration,
    remainingSeconds: remaining,
    percentComplete: percent,
    updatedAt: progress.updatedAt
  };
}

function storedBooks() {
  return readJson<Book[]>(LIBRARY_KEY, []);
}

function storedProgress() {
  return readJson<Record<string, Progress>>(PROGRESS_KEY, {});
}

export function getDeviceProgress(bookId: string) {
  return storedProgress()[bookId] ?? null;
}

export function saveDeviceProgress(bookId: string, progress: Progress) {
  const all = storedProgress();
  all[bookId] = { ...progress, bookId };
  writeJson(PROGRESS_KEY, all);
}

export function getDeviceBooks(): Book[] {
  const progress = storedProgress();
  return storedBooks().map((book) => ({
    ...book,
    source: "device",
    deviceBookId: book.id,
    progress: progressSummary(book, progress[book.id] ?? null)
  }));
}

async function mediaDuration(path: string): Promise<number | null> {
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
  const audio = new Audio();
  audio.preload = "metadata";
  audio.src = Capacitor.convertFileSrc(uri);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      audio.removeAttribute("src");
      audio.load();
      resolve(value);
    };
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => finish(null);
    window.setTimeout(() => finish(null), 12_000);
  });
}

export async function importAudiobookFromDevice(
  onProgress?: (completed: number, total: number) => void
): Promise<Book> {
  if (!Capacitor.isNativePlatform()) throw new Error("Device file import is available in the iOS and Android apps.");
  const picked = await FilePicker.pickFiles({ limit: 0, readData: false });
  const files = picked.files
    .filter((file) => AUDIO_EXTENSIONS.has(extension(file.name)) || file.mimeType.startsWith("audio/"))
    .sort(naturalCompare);
  if (!files.length) throw new Error("Choose at least one supported audiobook audio file.");
  if (files.some((file) => !file.path)) throw new Error("The file picker did not provide access to one or more files.");

  const id = `device:${crypto.randomUUID()}`;
  const directory = `${LIBRARY_ROOT}/${sanitizeSegment(id)}`;
  await Filesystem.mkdir({ path: directory, directory: Directory.Data, recursive: true });
  const tracks: Track[] = [];
  try {
    for (const [index, file] of files.entries()) {
      const ext = extension(file.name) || "m4b";
      const path = `${directory}/track-${String(index + 1).padStart(4, "0")}.${sanitizeSegment(ext)}`;
      const destination = await Filesystem.getUri({ path, directory: Directory.Data });
      // Each import gets a unique directory, so overwriting cannot replace an
      // existing book. The Android plugin currently mishandles `false` for a
      // destination that does not exist yet; the default `true` works on both
      // platforms.
      await FilePicker.copyFile({ from: file.path!, to: destination.uri, overwrite: true });
      const durationSeconds = await mediaDuration(path);
      const trackId = `${id}:track:${index + 1}`;
      tracks.push({
        id: trackId,
        title: file.name.replace(/\.[^.]+$/, ""),
        fileName: file.name,
        index,
        durationSeconds,
        streamUrl: "",
        chapters: [],
        metadata: EMPTY_METADATA,
        localFilePath: path
      });
      onProgress?.(index + 1, files.length);
    }
  } catch (error) {
    await Filesystem.rmdir({ path: directory, directory: Directory.Data, recursive: true }).catch(() => undefined);
    throw error;
  }

  const chapters = tracks.map((track, index) => ({
    id: `${track.id}:chapter`,
    title: track.title,
    trackId: track.id,
    trackIndex: index,
    startSeconds: tracks.slice(0, index).reduce((sum, item) => sum + (item.durationSeconds ?? 0), 0),
    endSeconds: null,
    source: "device-file"
  }));
  tracks.forEach((track, index) => { track.chapters = [chapters[index]]; });
  const knownDuration = tracks.every((track) => track.durationSeconds !== null);
  const book: Book = {
    id,
    title: inferredTitle(files[0].name),
    author: null,
    narrator: null,
    durationSeconds: knownDuration ? tracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0) : null,
    trackCount: tracks.length,
    coverArtUrl: null,
    coverArtContentType: null,
    description: null,
    genres: [],
    publishedDate: null,
    asin: null,
    readingFile: null,
    syncFile: null,
    chapters,
    metadata: EMPTY_METADATA,
    tracks,
    progress: null,
    source: "device",
    deviceBookId: id
  };
  writeJson(LIBRARY_KEY, [...storedBooks(), book]);
  return book;
}

export async function removeDeviceBook(bookId: string) {
  const book = storedBooks().find((candidate) => candidate.id === bookId);
  const path = book?.tracks[0]?.localFilePath?.split("/").slice(0, -1).join("/");
  if (path) await Filesystem.rmdir({ path, directory: Directory.Data, recursive: true }).catch(() => undefined);
  writeJson(LIBRARY_KEY, storedBooks().filter((candidate) => candidate.id !== bookId));
  const progress = storedProgress();
  delete progress[bookId];
  writeJson(PROGRESS_KEY, progress);
}

/** Attach a picked-file copy to an equivalent server book and hide the duplicate device row. */
export function mergeDeviceAndServerBooks(serverBooks: Book[], deviceBooks = getDeviceBooks()): Book[] {
  const unmatched = new Set(deviceBooks.map((book) => book.id));
  const merged = serverBooks.map((serverBook) => {
    const deviceBook = deviceBooks.find((candidate) =>
      unmatched.has(candidate.id) &&
      deviceBookMatchesServer(candidate, serverBook)
    );
    if (!deviceBook) return { ...serverBook, source: "server" as const };
    unmatched.delete(deviceBook.id);
    const deviceProgressIsNewer = !!deviceBook.progress && (
      !serverBook.progress || progressTimestamp(deviceBook.progress.updatedAt) > progressTimestamp(serverBook.progress.updatedAt)
    );
    return {
      ...serverBook,
      source: "server" as const,
      deviceBookId: deviceBook.id,
      progress: deviceProgressIsNewer ? deviceBook.progress : serverBook.progress,
      tracks: serverBook.tracks.map((track, index) => ({
        ...track,
        localFilePath: deviceBook.tracks[index]?.localFilePath
      }))
    };
  });
  return [...merged, ...deviceBooks.filter((book) => unmatched.has(book.id))];
}
