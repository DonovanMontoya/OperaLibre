import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { getServerStorageKey, getServerUrl } from "./api";
import {
  cancelBackgroundBookDownload,
  getBackgroundBookDownloadStatus,
  runBackgroundBookDownload,
  type BackgroundDownloadFile,
  type BackgroundDownloadStatus
} from "./backgroundDownloads";
import { fileExtension, storedMediaExtension } from "./mediaFiles";
import type { AuthUser, Book, Progress, Track } from "./types";

const DB_NAME = "operalibre-offline";
const DB_VERSION = 1;
const USER_KEY = "operalibre.offlineUser";

// Native downloads live on disk (survives WebView storage eviction, no
// in-memory blobs); IndexedDB keeps only small JSON (library, progress) plus
// the media blobs used by the web fallback.
const MEDIA_ROOT = "offline-media";
const MEDIA_DIRECTORY = Directory.Data;

type StoredMedia = { key: string; blob: Blob };

const isNative = () => Capacitor.isNativePlatform();

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("media")) db.createObjectStore("media", { keyPath: "key" });
      if (!db.objectStoreNames.contains("data")) db.createObjectStore("data");
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        databasePromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error);
    };
  });
  return databasePromise;
}

async function read<T>(storeName: string, key: string): Promise<T | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function write(storeName: string, value: unknown, key?: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    key === undefined ? store.put(value) : store.put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function removeRecord(storeName: string, key: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Deletes every record whose string key starts with `prefix`, in one transaction. */
async function removeRecordsWithPrefix(storeName: string, prefix: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    // Keys are strings, so every key with this prefix sorts between the
    // prefix itself and the prefix followed by the highest code unit.
    const request = store.getAllKeys(IDBKeyRange.bound(prefix, prefix + String.fromCharCode(0xffff)));
    request.onsuccess = () => {
      for (const key of request.result) store.delete(key);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function readMedia(bookId: string, kind: string) {
  const scoped = await read<StoredMedia>("media", mediaKey(bookId, kind));
  if (scoped) return scoped;
  const legacy = await read<StoredMedia>("media", `${bookId}:${kind}`);
  if (legacy) {
    await write("media", { ...legacy, key: mediaKey(bookId, kind) });
    await removeRecord("media", `${bookId}:${kind}`);
  }
  return legacy;
}

const scopedKey = (value: string) => `${getServerStorageKey()}:${value}`;
const libraryKey = (userId: string) => scopedKey(`library:${userId}`);
const progressKey = (userId: string, bookId: string) => scopedKey(`progress:${userId}:${bookId}`);
const mediaKey = (bookId: string, kind: string) => scopedKey(`${bookId}:${kind}`);

function sanitizeSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

const bookDirectory = (bookId: string) =>
  `${MEDIA_ROOT}/${sanitizeSegment(getServerStorageKey())}/${sanitizeSegment(bookId)}`;
const legacyBookDirectory = (bookId: string) => `${MEDIA_ROOT}/${sanitizeSegment(bookId)}`;

// WKWebView's capacitor:// file server picks the Content-Type from the file
// extension, so stored files must carry an extension the platform can type.
const trackFileName = (track: Track, extension: string) =>
  `track-${sanitizeSegment(track.id)}.${extension}`;
const trackFilePath = (book: Book, track: Track) =>
  `${bookDirectory(book.id)}/${trackFileName(track, storedMediaExtension(fileExtension(track.fileName, "mp3")))}`;
// Where a download made before the stored-extension rule landed still sits.
const legacyTrackFilePath = (book: Book, track: Track) =>
  `${bookDirectory(book.id)}/${trackFileName(track, fileExtension(track.fileName, "mp3"))}`;
function coverExtension(book: Book) {
  switch (book.coverArtContentType?.toLowerCase()) {
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return "jpg";
  }
}

const coverFilePath = (book: Book) => `${bookDirectory(book.id)}/cover.${coverExtension(book)}`;

export const backgroundDownloadJobId = (book: Pick<Book, "id">) =>
  `${sanitizeSegment(getServerStorageKey())}-${sanitizeSegment(book.id)}`;

export function getBookBackgroundDownloadStatus(book: Pick<Book, "id">) {
  return getBackgroundBookDownloadStatus(backgroundDownloadJobId(book));
}

export async function cancelBookOfflineDownload(book: Pick<Book, "id">) {
  if (isNative()) {
    await cancelBackgroundBookDownload(backgroundDownloadJobId(book));
  }
}

// One in-flight move per book, shared by concurrent callers. A failed move is
// forgotten so the next caller tries again instead of treating the book as
// already migrated and then finding no files at the new path.
const legacyBookMigrations = new Map<string, Promise<void>>();
function migrateLegacyBookDirectory(book: Book) {
  const migrationKey = `${getServerStorageKey()}:${book.id}`;
  let migration = legacyBookMigrations.get(migrationKey);
  if (!migration) {
    migration = moveLegacyBookDirectory(book).catch((error) => {
      legacyBookMigrations.delete(migrationKey);
      throw error;
    });
    legacyBookMigrations.set(migrationKey, migration);
  }
  return migration;
}

async function moveLegacyBookDirectory(book: Book) {
  const destination = bookDirectory(book.id);
  if (await fileExists(destination)) return;
  const legacy = legacyBookDirectory(book.id);
  if (!(await fileExists(legacy))) return;
  await Filesystem.mkdir({
    path: `${MEDIA_ROOT}/${sanitizeSegment(getServerStorageKey())}`,
    directory: MEDIA_DIRECTORY,
    recursive: true
  });
  await Filesystem.rename({
    from: legacy,
    to: destination,
    directory: MEDIA_DIRECTORY,
    toDirectory: MEDIA_DIRECTORY
  });
  const expectedCover = coverFilePath(book);
  const oldCover = `${destination}/cover.jpg`;
  if (expectedCover !== oldCover && await fileExists(oldCover) && !(await fileExists(expectedCover))) {
    await Filesystem.rename({
      from: oldCover,
      to: expectedCover,
      directory: MEDIA_DIRECTORY,
      toDirectory: MEDIA_DIRECTORY
    });
  }
}

async function fileExists(path: string) {
  try {
    await Filesystem.stat({ path, directory: MEDIA_DIRECTORY });
    return true;
  } catch {
    return false;
  }
}

/**
 * The on-disk path of a downloaded track, renaming a download that predates the
 * stored-extension rule so an existing copy is reused instead of silently
 * re-downloading. Callers must have run `migrateLegacyBookDirectory` first.
 */
async function resolveTrackFilePath(book: Book, track: Track) {
  const path = trackFilePath(book, track);
  const legacy = legacyTrackFilePath(book, track);
  if (legacy === path || (await fileExists(path))) return path;
  if (!(await fileExists(legacy))) return path;
  try {
    await Filesystem.rename({
      from: legacy,
      to: path,
      directory: MEDIA_DIRECTORY,
      toDirectory: MEDIA_DIRECTORY
    });
    return path;
  } catch {
    // Keep playing the file that is already there if it could not be renamed.
    return legacy;
  }
}

async function nativeFileUrl(path: string) {
  if (!(await fileExists(path))) return null;
  const { uri } = await Filesystem.getUri({ path, directory: MEDIA_DIRECTORY });
  return Capacitor.convertFileSrc(uri);
}

// Downloads from before the filesystem migration sit as large blobs in
// IndexedDB; clear them once so they stop wasting WebView storage.
let legacyMediaCleared = false;
async function clearLegacyMediaBlobs() {
  if (!isNative() || legacyMediaCleared) return;
  legacyMediaCleared = true;
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("media", "readwrite");
      transaction.objectStore("media").clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    // Best effort only.
  }
}

export function cacheOfflineUser(user: AuthUser) {
  localStorage.setItem(scopedKey(USER_KEY), JSON.stringify(user));
}

export function getOfflineUser(): AuthUser | null {
  try {
    const scoped = localStorage.getItem(scopedKey(USER_KEY));
    const legacy = scoped ?? localStorage.getItem(USER_KEY);
    const user = JSON.parse(legacy ?? "null") as AuthUser | null;
    if (!scoped && user) {
      cacheOfflineUser(user);
      localStorage.removeItem(USER_KEY);
    }
    return user;
  } catch {
    return null;
  }
}

export async function cacheLibrary(userId: string, books: Book[]) {
  await write("data", books, libraryKey(userId));
}

export async function getCachedLibrary(userId: string) {
  const scoped = await read<Book[]>("data", libraryKey(userId));
  if (scoped) return scoped;
  const legacy = await read<Book[]>("data", `library:${userId}`);
  if (legacy) {
    await cacheLibrary(userId, legacy);
    await removeRecord("data", `library:${userId}`);
  }
  return legacy ?? [];
}

export async function cacheProgress(userId: string, progress: Progress) {
  await write("data", progress, progressKey(userId, progress.bookId));
}

export function getCachedProgress(userId: string, bookId: string) {
  return read<Progress>("data", progressKey(userId, bookId)).then(async (scoped) => {
    if (scoped) return scoped;
    const legacy = await read<Progress>("data", `progress:${userId}:${bookId}`);
    if (legacy) {
      await cacheProgress(userId, legacy);
      await removeRecord("data", `progress:${userId}:${bookId}`);
    }
    return legacy;
  });
}

export async function isBookDownloaded(book: Book) {
  if (!book.tracks.length) return false;
  if (isNative()) {
    if (book.tracks.every((track) => track.localFilePath)) {
      return (await Promise.all(book.tracks.map((track) => fileExists(track.localFilePath!)))).every(Boolean);
    }
    void clearLegacyMediaBlobs();
    await migrateLegacyBookDirectory(book);
    const paths = await Promise.all(book.tracks.map((track) => resolveTrackFilePath(book, track)));
    const checks = await Promise.all(paths.map((path) => fileExists(path)));
    return checks.every(Boolean);
  }
  const records = await Promise.all(
    book.tracks.map((track) => readMedia(book.id, `track:${track.id}`))
  );
  return records.every(Boolean);
}

export async function downloadBookForOffline(
  book: Book,
  resolveUrl: (path: string) => string,
  onProgress: (
    completedTracks: number,
    totalTracks: number,
    currentTrackPercent?: number,
    state?: BackgroundDownloadStatus["state"]
  ) => void,
  signal?: AbortSignal
) {
  const total = book.tracks.length;
  if (isNative()) {
    void clearLegacyMediaBlobs();
    await migrateLegacyBookDirectory(book);
    const files: BackgroundDownloadFile[] = await Promise.all(book.tracks.map(async (track) => ({
      url: resolveUrl(track.downloadUrl ?? track.streamUrl),
      path: (await Filesystem.getUri({ path: trackFilePath(book, track), directory: MEDIA_DIRECTORY })).uri,
      label: track.title,
      required: true
    })));
    if (book.coverArtUrl) {
      files.push({
        url: resolveUrl(book.coverArtUrl),
        path: (await Filesystem.getUri({ path: coverFilePath(book), directory: MEDIA_DIRECTORY })).uri,
        label: "cover art",
        required: false
      });
    }
    // Stable IDs let a relaunched app reattach to work the OS is already
    // running instead of scheduling a duplicate copy of the same book.
    const jobId = backgroundDownloadJobId(book);
    await runBackgroundBookDownload(jobId, book.title, getServerUrl(), files, (fraction, state) => {
      const trackProgress = fraction * total;
      const completed = Math.min(total, Math.floor(trackProgress));
      onProgress(completed, total, completed < total ? (trackProgress - completed) * 100 : undefined, state);
    }, signal);
    return;
  }

  // Records written by this attempt, so an abort or failure part-way leaves
  // no half-downloaded book behind that `isBookDownloaded` would then have to
  // explain.
  const written: string[] = [];
  try {
    let completed = 0;
    for (const track of book.tracks) {
      const response = await fetch(resolveUrl(track.downloadUrl ?? track.streamUrl), { signal });
      if (!response.ok) throw new Error(`Could not download ${track.title} (${response.status}).`);
      const key = mediaKey(book.id, `track:${track.id}`);
      await write("media", { key, blob: await response.blob() });
      written.push(key);
      completed += 1;
      onProgress(completed, total);
    }
    if (book.coverArtUrl) {
      const response = await fetch(resolveUrl(book.coverArtUrl), { signal });
      if (response.ok) {
        const key = mediaKey(book.id, "cover");
        await write("media", { key, blob: await response.blob() });
        written.push(key);
      }
    }
  } catch (error) {
    await Promise.all(written.map((key) => removeRecord("media", key).catch(() => undefined)));
    throw error;
  }
}

export async function removeBookDownload(book: Book) {
  if (isNative()) {
    await migrateLegacyBookDirectory(book);
    await Filesystem.rmdir({ path: bookDirectory(book.id), directory: MEDIA_DIRECTORY, recursive: true }).catch(
      () => undefined
    );
    return;
  }
  // Delete by key prefix rather than from the current track list: a track
  // the server has since renamed or dropped would otherwise leave its blob
  // behind forever.
  await Promise.all([
    removeRecordsWithPrefix("media", mediaKey(book.id, "")),
    removeRecordsWithPrefix("media", `${book.id}:`)
  ]);
}

/**
 * Native URLs point at files on disk (served by WKWebView with byte-range
 * support, so seeking works); web URLs are blob object URLs the caller must
 * revoke. `releaseOfflineMediaUrl` handles both.
 */
export async function getOfflineTrackUrl(book: Book, track: Track): Promise<string | null> {
  if (isNative()) {
    if (track.localFilePath) return nativeFileUrl(track.localFilePath);
    await migrateLegacyBookDirectory(book);
    return nativeFileUrl(await resolveTrackFilePath(book, track));
  }
  const record = await readMedia(book.id, `track:${track.id}`);
  return record ? URL.createObjectURL(record.blob) : null;
}

export async function getOfflineCoverUrl(book: Book): Promise<string | null> {
  if (isNative()) {
    // A book imported from the device picker keeps the cover its own tags
    // carried; there is no server copy to fall back to.
    if (book.localCoverPath) return nativeFileUrl(book.localCoverPath);
    await migrateLegacyBookDirectory(book);
    return nativeFileUrl(coverFilePath(book));
  }
  const record = await readMedia(book.id, "cover");
  return record ? URL.createObjectURL(record.blob) : null;
}

export function releaseOfflineMediaUrl(url: string | null) {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}

/**
 * Forget the offline fallback account. Signing out clears the token, but
 * checkAuth's offline branch would otherwise resurrect the last user from
 * this record the next time the server is unreachable.
 */
export function forgetOfflineUser(): void {
  try {
    localStorage.removeItem(scopedKey(USER_KEY));
    localStorage.removeItem(USER_KEY);
  } catch {
    // Storage can be unavailable in private browsing; nothing to forget then.
  }
}
