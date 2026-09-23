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
import { revalidatedCompanion } from "./companionCache";
import { downloadWebBook } from "./offlineDownload";
import type { AuthUser, Book, CompanionFile, Progress, SyncMap, Track } from "./types";

const DB_NAME = "operalibre-offline";
const DB_VERSION = 1;
const USER_KEY = "operalibre.offlineUser";

// Native downloads live on disk (survives WebView storage eviction, no
// in-memory blobs); IndexedDB keeps only small JSON (library, progress) plus
// the media blobs used by the web fallback.
const MEDIA_ROOT = "offline-media";
const MEDIA_DIRECTORY = Directory.Data;

type StoredMedia = { key: string; blob: Blob };
type LibrarySnapshot = { cachedAt: number; books: Book[] };

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
const nativeLibraryPath = (userId: string) =>
  `${MEDIA_ROOT}/${sanitizeSegment(getServerStorageKey())}/library-${sanitizeSegment(userId)}.json`;
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
const unscopedTrackFilePath = (book: Book, track: Track, extension: string) =>
  `${legacyBookDirectory(book.id)}/${trackFileName(track, extension)}`;
function coverExtension(book: Book) {
  switch (book.coverArtContentType?.toLowerCase()) {
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return "jpg";
  }
}

const coverFilePath = (book: Book) => `${bookDirectory(book.id)}/cover.${coverExtension(book)}`;

// The ebook, its picture supplements, and any loose images, kept beside the
// audio so a downloaded book can be read as well as heard.
const companionFilePath = (book: Book, companion: CompanionFile) =>
  `${bookDirectory(book.id)}/companion-${sanitizeSegment(companion.id)}.${sanitizeSegment(companion.extension || "bin")}`;
const syncMapFilePath = (book: Book) => `${bookDirectory(book.id)}/sync.json`;
const companionMediaKind = (companion: CompanionFile) => `companion:${companion.id}`;
const SYNC_MAP_KIND = "sync";

/** Base64 in chunks: one apply() over a whole ebook overruns the call stack. */
function toBase64(data: ArrayBuffer) {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

export const backgroundDownloadJobId = (book: Pick<Book, "id">) =>
  `${sanitizeSegment(getServerStorageKey())}-${sanitizeSegment(book.id)}`;

export function getBookBackgroundDownloadStatus(book: Pick<Book, "id">) {
  return getBackgroundBookDownloadStatus(backgroundDownloadJobId(book));
}

export async function cancelBookOfflineDownload(book: Pick<Book, "id">) {
  if (Capacitor.isNativePlatform()) {
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
  if (await fileExists(path)) return path;
  if (legacy !== path && await fileExists(legacy)) {
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
  // A migration can legitimately find a partially populated scoped folder
  // left by a newer retry. In that case the old whole-book folder cannot be
  // renamed, but its complete tracks are still valid offline sources.
  const storedExtension = storedMediaExtension(fileExtension(track.fileName, "mp3"));
  const originalExtension = fileExtension(track.fileName, "mp3");
  for (const candidate of [
    unscopedTrackFilePath(book, track, storedExtension),
    unscopedTrackFilePath(book, track, originalExtension)
  ]) {
    if (await fileExists(candidate)) return candidate;
  }
  return path;
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
  if (!Capacitor.isNativePlatform() || legacyMediaCleared) return;
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

function librarySnapshot(value: unknown): LibrarySnapshot | null {
  if (Array.isArray(value)) return { cachedAt: 0, books: value as Book[] };
  if (
    value && typeof value === "object"
    && Number.isFinite((value as LibrarySnapshot).cachedAt)
    && Array.isArray((value as LibrarySnapshot).books)
  ) {
    return value as LibrarySnapshot;
  }
  return null;
}

export function newestLibrarySnapshot(
  first: LibrarySnapshot | null,
  second: LibrarySnapshot | null
) {
  if (!first) return second;
  if (!second) return first;
  return second.cachedAt > first.cachedAt ? second : first;
}

async function writeNativeLibrary(userId: string, snapshot: LibrarySnapshot) {
  // Freeze the scope before yielding so changing servers cannot redirect an
  // in-flight write into the next server's native catalogue.
  const directory = `${MEDIA_ROOT}/${sanitizeSegment(getServerStorageKey())}`;
  const path = nativeLibraryPath(userId);
  await Filesystem.mkdir({
    path: directory,
    directory: MEDIA_DIRECTORY,
    recursive: true
  });
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  await Filesystem.writeFile({
    path,
    directory: MEDIA_DIRECTORY,
    data: toBase64(bytes.buffer as ArrayBuffer)
  });
}

async function readNativeLibrary(userId: string): Promise<LibrarySnapshot | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const result = await Filesystem.readFile({
      path: nativeLibraryPath(userId),
      directory: MEDIA_DIRECTORY
    });
    if (typeof result.data !== "string") return null;
    const bytes = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0));
    return librarySnapshot(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

export async function cacheLibrary(userId: string, books: Book[]) {
  const snapshot: LibrarySnapshot = { cachedAt: Date.now(), books };
  if (!Capacitor.isNativePlatform()) {
    await write("data", snapshot, libraryKey(userId));
    return;
  }
  // WebView storage and native app data have different eviction/failure
  // modes. Keep the small catalogue in both so durable downloaded audio never
  // becomes unreachable solely because IndexedDB cannot open.
  const results = await Promise.allSettled([
    write("data", snapshot, libraryKey(userId)),
    writeNativeLibrary(userId, snapshot)
  ]);
  if (results.every((result) => result.status === "rejected")) {
    throw (results[0] as PromiseRejectedResult).reason;
  }
}

export async function getCachedLibrary(userId: string) {
  let indexedSnapshot: LibrarySnapshot | null = null;
  let legacySnapshot: LibrarySnapshot | null = null;
  try {
    indexedSnapshot = librarySnapshot(await read<unknown>("data", libraryKey(userId)));
    legacySnapshot = librarySnapshot(await read<unknown>("data", `library:${userId}`));
  } catch {
    // The native app-data copy below remains available when WebKit storage is unavailable.
  }
  const selected = newestLibrarySnapshot(
    newestLibrarySnapshot(indexedSnapshot, legacySnapshot),
    await readNativeLibrary(userId)
  );
  if (legacySnapshot && selected === legacySnapshot) {
    // The legacy record goes only once the current store holds its books;
    // otherwise the next load still has it to fall back on.
    try {
      await cacheLibrary(userId, legacySnapshot.books);
      await removeRecord("data", `library:${userId}`);
    } catch (error) {
      console.warn("Could not migrate the cached library", error);
    }
  }
  return selected?.books ?? [];
}

/**
 * For a write that duplicates a copy kept elsewhere, such as progress that is
 * already in the localStorage checkpoint: a failure costs only this copy, so
 * it is logged rather than surfaced.
 */
export function warnCacheFailure(what: string) {
  return (error: unknown) => console.warn(`Could not ${what}`, error);
}

export async function cacheProgress(userId: string, progress: Progress) {
  await write("data", progress, progressKey(userId, progress.bookId));
}

export function getCachedProgress(userId: string, bookId: string) {
  return read<Progress>("data", progressKey(userId, bookId)).then(async (scoped) => {
    if (scoped) return scoped;
    const legacy = await read<Progress>("data", `progress:${userId}:${bookId}`);
    if (legacy) {
      // A failed migration still returns the position it read; the legacy
      // record stays for the next attempt.
      try {
        await cacheProgress(userId, legacy);
        await removeRecord("data", `progress:${userId}:${bookId}`);
      } catch (error) {
        console.warn("Could not migrate cached progress", error);
      }
    }
    return legacy;
  });
}

export async function isBookDownloaded(book: Book) {
  if (!book.tracks.length) return false;
  if (Capacitor.isNativePlatform()) {
    if (book.tracks.every((track) => track.localFilePath)) {
      return (await Promise.all(book.tracks.map((track) => fileExists(track.localFilePath!)))).every(Boolean);
    }
    void clearLegacyMediaBlobs();
    await migrateLegacyBookDirectory(book).catch(() => undefined);
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
  if (Capacitor.isNativePlatform()) {
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
    // The ebook and pictures belong to the book, so they come down with it:
    // a book taken on a flight can be read as well as heard. They are not
    // required, so a missing companion cannot fail the audio download.
    for (const companion of book.companions ?? []) {
      files.push({
        url: resolveUrl(companion.url),
        path: (await Filesystem.getUri({ path: companionFilePath(book, companion), directory: MEDIA_DIRECTORY })).uri,
        label: companion.fileName,
        required: false
      });
    }
    if (book.syncFile) {
      files.push({
        url: resolveUrl(book.syncFile.url),
        path: (await Filesystem.getUri({ path: syncMapFilePath(book), directory: MEDIA_DIRECTORY })).uri,
        label: "read-along sync",
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

  const prefix = mediaKey(book.id, "");
  await downloadWebBook(
    book,
    resolveUrl,
    (kind, blob) => write("media", { key: prefix + kind, blob }),
    (kind) => removeRecord("media", prefix + kind),
    onProgress,
    signal
  );
}

export async function removeBookDownload(book: Book) {
  if (Capacitor.isNativePlatform()) {
    await migrateLegacyBookDirectory(book).catch(() => undefined);
    await Promise.all([
      Filesystem.rmdir({ path: bookDirectory(book.id), directory: MEDIA_DIRECTORY, recursive: true }),
      Filesystem.rmdir({ path: legacyBookDirectory(book.id), directory: MEDIA_DIRECTORY, recursive: true })
    ].map((removal) => removal.catch(() => undefined)));
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
  if (Capacitor.isNativePlatform()) {
    if (track.localFilePath) return nativeFileUrl(track.localFilePath);
    await migrateLegacyBookDirectory(book).catch(() => undefined);
    return nativeFileUrl(await resolveTrackFilePath(book, track));
  }
  const record = await readMedia(book.id, `track:${track.id}`);
  return record ? URL.createObjectURL(record.blob) : null;
}

export async function getOfflineCoverUrl(book: Book): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    // A book imported from the device picker keeps the cover its own tags
    // carried; there is no server copy to fall back to.
    if (book.localCoverPath) return nativeFileUrl(book.localCoverPath);
    await migrateLegacyBookDirectory(book);
    return nativeFileUrl(coverFilePath(book));
  }
  const record = await readMedia(book.id, "cover");
  return record ? URL.createObjectURL(record.blob) : null;
}

/** A local preview URL; callers release web blob URLs when no longer used. */
export async function getOfflineCompanionUrl(book: Book, companion: CompanionFile): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    await migrateLegacyBookDirectory(book);
    return nativeFileUrl(companionFilePath(book, companion));
  }
  const record = await readMedia(book.id, companionMediaKind(companion));
  return record ? URL.createObjectURL(record.blob) : null;
}

/** Previously opened web companions remain available during a network outage. */
export async function getCachedEpubBytes(
  book: Book, companion: CompanionFile, signal?: AbortSignal
): Promise<ArrayBuffer | null> {
  signal?.throwIfAborted();
  const local = await getOfflineCompanionUrl(book, companion);
  if (!local) {
    signal?.throwIfAborted();
    return null;
  }
  try {
    signal?.throwIfAborted();
    const response = await fetch(local, { signal });
    const data = response.ok ? await response.arrayBuffer() : null;
    signal?.throwIfAborted();
    return data;
  } finally {
    if (local.startsWith("blob:")) URL.revokeObjectURL(local);
  }
}

/** A complete local download remains usable offline; online EPUBs can open by chapter. */
export async function loadEpubSource(
  book: Book, companion: CompanionFile, url: string, signal: AbortSignal
): Promise<ArrayBuffer | string> {
  signal.throwIfAborted();
  const native = Capacitor.isNativePlatform();
  if (native) await migrateLegacyBookDirectory(book);
  const preferLocal = native || await isBookDownloaded(book).catch(() => false);
  const local = preferLocal ? await getOfflineCompanionUrl(book, companion).catch(() => null) : null;
  if (local) {
    try {
      signal.throwIfAborted();
      const response = await fetch(local, { signal });
      if (response.ok) return await response.arrayBuffer();
    } catch {
      signal.throwIfAborted();
    } finally {
      if (local.startsWith("blob:")) URL.revokeObjectURL(local);
    }
  }
  signal.throwIfAborted();
  return url;
}

/** Native reads prefer disk, independent of the asynchronous download badge scan.
 * Web reads still revalidate; native copies persist until the download is removed.
 */
export async function loadCompanionBytes(
  book: Book,
  companion: CompanionFile,
  url: string,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  if (Capacitor.isNativePlatform()) {
    await migrateLegacyBookDirectory(book);
    const path = companionFilePath(book, companion);
    return revalidatedCompanion(url, async () => {
      const cached = await nativeFileUrl(path);
      if (!cached) return null;
      const response = await fetch(cached, { signal });
      return response.ok ? response.arrayBuffer() : null;
    }, async (data) => {
      await Filesystem.mkdir({ path: bookDirectory(book.id), directory: MEDIA_DIRECTORY, recursive: true }).catch(() => undefined);
      await Filesystem.writeFile({ path, directory: MEDIA_DIRECTORY, data: toBase64(data) });
    }, signal, true);
  }
  return revalidatedCompanion(url, async () => {
    const record = await readMedia(book.id, companionMediaKind(companion));
    return record ? record.blob.arrayBuffer() : null;
  }, (data) => write("media", {
    key: mediaKey(book.id, companionMediaKind(companion)),
    blob: new Blob([data], { type: companion.contentType })
  }), signal);
}

/** The sync map stored with a downloaded book, for reading with no server. */
export async function getOfflineSyncMap(book: Book): Promise<SyncMap | null> {
  try {
    if (Capacitor.isNativePlatform()) {
      await migrateLegacyBookDirectory(book);
      const url = await nativeFileUrl(syncMapFilePath(book));
      return url ? ((await (await fetch(url)).json()) as SyncMap) : null;
    }
    const record = await readMedia(book.id, SYNC_MAP_KIND);
    return record ? ((JSON.parse(await record.blob.text())) as SyncMap) : null;
  } catch {
    return null;
  }
}

/**
 * Re-persists a freshly fetched map over the copy a downloaded book carries.
 * That copy is otherwise written once, at download time, so a book downloaded
 * before its narration had been aligned would never gain a usable map offline
 * until it was downloaded again. Best effort: a cache that cannot be refreshed
 * must not fail the reader, which already has the map in hand.
 */
export async function saveOfflineSyncMap(book: Book, map: SyncMap, signal?: AbortSignal): Promise<void> {
  // Freeze the destination before yielding: changing servers must never move
  // an in-flight write into the new server's cache.
  const scope = getServerStorageKey();
  const directory = bookDirectory(book.id);
  const path = syncMapFilePath(book);
  const key = mediaKey(book.id, SYNC_MAP_KIND);
  const isCurrent = () => !signal?.aborted && getServerStorageKey() === scope;
  try {
    if (!isCurrent() || !(await isBookDownloaded(book)) || !isCurrent()) return;
    const json = JSON.stringify(map);
    if (Capacitor.isNativePlatform()) {
      await Filesystem.mkdir({
        path: directory,
        directory: MEDIA_DIRECTORY,
        recursive: true
      }).catch(() => undefined);
      if (!isCurrent()) return;
      await Filesystem.writeFile({
        path,
        directory: MEDIA_DIRECTORY,
        data: toBase64(new TextEncoder().encode(json).buffer as ArrayBuffer)
      });
      return;
    }
    await write("media", {
      key,
      blob: new Blob([json], { type: "application/json" })
    });
  } catch {
    // Left as it was; the next open tries again.
  }
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
