import { Capacitor } from "@capacitor/core";
import { FileTransfer } from "@capacitor/file-transfer";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { getServerStorageKey } from "./api";
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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("media")) db.createObjectStore("media", { keyPath: "key" });
      if (!db.objectStoreNames.contains("data")) db.createObjectStore("data");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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

async function readMedia(bookId: string, kind: string) {
  const scoped = await read<StoredMedia>("media", mediaKey(bookId, kind));
  if (scoped) return scoped;
  const legacy = await read<StoredMedia>("media", `${bookId}:${kind}`);
  if (legacy) {
    await write("media", { ...legacy, key: mediaKey(bookId, kind) });
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

// WKWebView's capacitor:// file server picks the Content-Type from the file
// extension, so stored files must keep the real audio extension.
function fileExtension(name: string | null | undefined, fallback: string) {
  const base = (name ?? "").split(/[?#]/)[0];
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  return (match ? match[1] : fallback).toLowerCase();
}

const bookDirectory = (bookId: string) =>
  `${MEDIA_ROOT}/${sanitizeSegment(getServerStorageKey())}/${sanitizeSegment(bookId)}`;
const legacyBookDirectory = (bookId: string) => `${MEDIA_ROOT}/${sanitizeSegment(bookId)}`;
const trackFilePath = (book: Book, track: Track) =>
  `${bookDirectory(book.id)}/track-${sanitizeSegment(track.id)}.${fileExtension(track.fileName, "mp3")}`;
function coverExtension(book: Book) {
  switch (book.coverArtContentType?.toLowerCase()) {
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return "jpg";
  }
}

const coverFilePath = (book: Book) => `${bookDirectory(book.id)}/cover.${coverExtension(book)}`;

const migratedLegacyBooks = new Set<string>();
async function migrateLegacyBookDirectory(book: Book) {
  const migrationKey = `${getServerStorageKey()}:${book.id}`;
  if (migratedLegacyBooks.has(migrationKey)) return;
  migratedLegacyBooks.add(migrationKey);
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

async function nativeFileUrl(path: string) {
  if (!(await fileExists(path))) return null;
  const { uri } = await Filesystem.getUri({ path, directory: MEDIA_DIRECTORY });
  return Capacitor.convertFileSrc(uri);
}

/**
 * Download straight to disk through the native layer (URLSession) so tracks
 * never pass through WebView memory — fetching multi-hundred-MB audiobook
 * blobs is what crashed the old IndexedDB approach on iOS.
 */
async function downloadToFile(
  url: string,
  path: string,
  label: string,
  onPercent?: (percent: number) => void
) {
  const listener = onPercent
    ? await FileTransfer.addListener("progress", (status) => {
        if (status.type === "download" && status.url === url && status.contentLength > 0) {
          onPercent(Math.min(100, Math.round((status.bytes / status.contentLength) * 100)));
        }
      })
    : null;
  try {
    // FileTransfer requires an absolute native destination URI. The old
    // Filesystem downloader accepted a Directory/path pair, but is deprecated
    // and has proven unreliable for large iOS audiobook transfers.
    const destination = await Filesystem.getUri({ path, directory: MEDIA_DIRECTORY });
    await FileTransfer.downloadFile({
      url,
      path: destination.uri,
      progress: !!onPercent,
      connectTimeout: 60_000,
      readTimeout: 600_000
    });
  } catch (error) {
    // Don't leave a partial file behind: it would make the book look downloaded.
    if (await fileExists(path)) {
      await Filesystem.deleteFile({ path, directory: MEDIA_DIRECTORY }).catch(() => undefined);
    }
    const reason = error instanceof Error && error.message ? ` ${error.message}` : "";
    throw new Error(`Could not download ${label}.${reason}`);
  } finally {
    await listener?.remove();
  }
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
    if (!scoped && user) cacheOfflineUser(user);
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
  if (legacy) await cacheLibrary(userId, legacy);
  return legacy ?? [];
}

export async function cacheProgress(userId: string, progress: Progress) {
  await write("data", progress, progressKey(userId, progress.bookId));
}

export function getCachedProgress(userId: string, bookId: string) {
  return read<Progress>("data", progressKey(userId, bookId)).then(async (scoped) => {
    if (scoped) return scoped;
    const legacy = await read<Progress>("data", `progress:${userId}:${bookId}`);
    if (legacy) await cacheProgress(userId, legacy);
    return legacy;
  });
}

export async function isBookDownloaded(book: Book) {
  if (!book.tracks.length) return false;
  if (isNative()) {
    void clearLegacyMediaBlobs();
    await migrateLegacyBookDirectory(book);
    const checks = await Promise.all(book.tracks.map((track) => fileExists(trackFilePath(book, track))));
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
  onProgress: (completedTracks: number, totalTracks: number, currentTrackPercent?: number) => void
) {
  const total = book.tracks.length;
  if (isNative()) {
    void clearLegacyMediaBlobs();
    await migrateLegacyBookDirectory(book);
    for (const [index, track] of book.tracks.entries()) {
      onProgress(index, total, 0);
      await downloadToFile(resolveUrl(track.downloadUrl ?? track.streamUrl), trackFilePath(book, track), track.title, (percent) =>
        onProgress(index, total, percent)
      );
      onProgress(index + 1, total);
    }
    if (book.coverArtUrl) {
      await downloadToFile(resolveUrl(book.coverArtUrl), coverFilePath(book), "cover art").catch(() => undefined);
    }
    return;
  }

  let completed = 0;
  for (const track of book.tracks) {
    const response = await fetch(resolveUrl(track.downloadUrl ?? track.streamUrl));
    if (!response.ok) throw new Error(`Could not download ${track.title} (${response.status}).`);
    await write("media", { key: mediaKey(book.id, `track:${track.id}`), blob: await response.blob() });
    completed += 1;
    onProgress(completed, total);
  }
  if (book.coverArtUrl) {
    const response = await fetch(resolveUrl(book.coverArtUrl));
    if (response.ok) await write("media", { key: mediaKey(book.id, "cover"), blob: await response.blob() });
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
  await Promise.all([
    ...book.tracks.map((track) => removeRecord("media", mediaKey(book.id, `track:${track.id}`))),
    ...book.tracks.map((track) => removeRecord("media", `${book.id}:track:${track.id}`)),
    removeRecord("media", mediaKey(book.id, "cover")),
    removeRecord("media", `${book.id}:cover`)
  ]);
}

/**
 * Native URLs point at files on disk (served by WKWebView with byte-range
 * support, so seeking works); web URLs are blob object URLs the caller must
 * revoke. `releaseOfflineMediaUrl` handles both.
 */
export async function getOfflineTrackUrl(book: Book, track: Track): Promise<string | null> {
  if (isNative()) {
    await migrateLegacyBookDirectory(book);
    return nativeFileUrl(trackFilePath(book, track));
  }
  const record = await readMedia(book.id, `track:${track.id}`);
  return record ? URL.createObjectURL(record.blob) : null;
}

export async function getOfflineCoverUrl(book: Book): Promise<string | null> {
  if (isNative()) {
    await migrateLegacyBookDirectory(book);
    return nativeFileUrl(coverFilePath(book));
  }
  const record = await readMedia(book.id, "cover");
  return record ? URL.createObjectURL(record.blob) : null;
}

export function releaseOfflineMediaUrl(url: string | null) {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}
