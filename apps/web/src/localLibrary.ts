import { FilePicker, type PickedFile } from "@capawesome/capacitor-file-picker";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { readAudioFileTags, rangeSource, type AudioFileTags, type EmbeddedCover } from "./audioTags";
import { isSupportedAudioFileName, storedMediaExtension } from "./mediaFiles";
import type { AuthUser, Book, Chapter, MetadataSummary, Progress, Track } from "./types";
import {
  deviceBookMatchesServer,
  progressTimestamp,
  summarizeBookProgress
} from "./reliability.ts";

const LIBRARY_KEY = "operalibre.deviceLibrary.v1";
const PROGRESS_KEY = "operalibre.deviceProgress.v1";
const LIBRARY_ROOT = "device-library";

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
  series: null,
  seriesPosition: null,
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
  try {
    const all = storedProgress();
    all[bookId] = {
      ...progress,
      bookId,
      finishedOverride: progress.finishedOverride ?? all[bookId]?.finishedOverride ?? null
    };
    writeJson(PROGRESS_KEY, all);
  } catch {
    // Progress also has a synchronous per-book checkpoint and an IndexedDB
    // copy. A full/unavailable localStorage must not abort the server save
    // that follows this best-effort device mirror.
  }
}

export function getDeviceBooks(): Book[] {
  const progress = storedProgress();
  return storedBooks().map((book) => ({
    ...book,
    source: "device",
    deviceBookId: book.id,
    progress: summarizeBookProgress(book, progress[book.id] ?? null)
  }));
}

export function setDeviceBookCompletion(
  book: Book,
  finished: boolean,
  finalProgress?: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">
) {
  const existing = getDeviceProgress(book.id);
  const firstTrack = book.tracks[0];
  if (!firstTrack) {
    throw new Error("This book has no playable tracks.");
  }
  const progress: Progress = {
    bookId: book.id,
    trackId: finalProgress?.trackId ?? existing?.trackId ?? firstTrack.id,
    positionSeconds: finalProgress?.positionSeconds ?? existing?.positionSeconds ?? 0,
    bookPositionSeconds: finalProgress?.bookPositionSeconds ?? existing?.bookPositionSeconds ?? 0,
    durationSeconds: finalProgress?.durationSeconds ?? existing?.durationSeconds ?? firstTrack.durationSeconds,
    updatedAt: finalProgress ? new Date().toISOString() : existing?.updatedAt ?? new Date().toISOString(),
    finishedOverride: finished
  };
  saveDeviceProgress(book.id, progress);
  return {
    progress,
    summary: summarizeBookProgress(book, progress)!
  };
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

async function fileExists(path: string) {
  try {
    await Filesystem.stat({ path, directory: Directory.Data });
    return true;
  } catch {
    return false;
  }
}

/**
 * The tags embedded in a file this app has already copied into its own
 * storage. WKWebView serves that copy over `capacitor://` with range support,
 * so the reader pulls in the few hundred kilobytes of metadata rather than the
 * whole audiobook.
 */
async function readStoredFileTags(path: string) {
  try {
    const [{ uri }, stat] = await Promise.all([
      Filesystem.getUri({ path, directory: Directory.Data }),
      Filesystem.stat({ path, directory: Directory.Data }).catch(() => null)
    ]);
    return await readAudioFileTags(rangeSource(Capacitor.convertFileSrc(uri), stat?.size ?? null));
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array) {
  // Chunked: spreading a whole cover into `fromCharCode` blows the call stack.
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function coverExtension(contentType: string) {
  switch (contentType.toLowerCase()) {
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return "jpg";
  }
}

/** Writes embedded cover art beside the book's audio; null when it cannot. */
async function writeCoverArt(directory: string, cover: EmbeddedCover) {
  const path = `${directory}/cover.${coverExtension(cover.contentType)}`;
  try {
    await Filesystem.writeFile({
      path,
      directory: Directory.Data,
      data: bytesToBase64(cover.bytes)
    });
    return path;
  } catch {
    // A book without its cover is still a book worth importing.
    return null;
  }
}

function summaryFromTags(tags: AudioFileTags | null): MetadataSummary {
  if (!tags) return EMPTY_METADATA;
  return {
    album: tags.album,
    subtitle: tags.subtitle,
    publisher: tags.publisher,
    publishedDate: tags.publishedDate,
    description: tags.description,
    language: tags.language,
    series: tags.series,
    seriesPosition: tags.seriesPosition,
    genres: tags.genres,
    rawFields: tags.rawFields
  };
}

/**
 * Track-relative chapter markers, matching what the server stores on a track.
 * A file with no markers of its own keeps the one-chapter-per-file fallback so
 * a multi-file book still has something to navigate by.
 */
function trackChapters(track: Track, tags: AudioFileTags | null): Chapter[] {
  const embedded = (tags?.chapters ?? [])
    .filter((chapter) => Number.isFinite(chapter.startSeconds) && chapter.startSeconds >= 0)
    .sort((a, b) => a.startSeconds - b.startSeconds);
  if (!embedded.length) {
    return [{
      id: `${track.id}:chapter`,
      title: track.title,
      trackId: track.id,
      trackIndex: track.index,
      startSeconds: 0,
      endSeconds: track.durationSeconds,
      source: "device-file"
    }];
  }
  return embedded.map((chapter, position) => ({
    id: `${track.id}:chapter:${position + 1}`,
    title: chapter.title || `Chapter ${position + 1}`,
    trackId: track.id,
    trackIndex: track.index,
    startSeconds: chapter.startSeconds,
    endSeconds: embedded[position + 1]?.startSeconds ?? track.durationSeconds,
    source: "embedded-chapters"
  }));
}

/** The book-wide chapter list: track markers shifted onto whole-book time. */
function bookChapters(tracks: Track[]): Chapter[] {
  const chapters: Chapter[] = [];
  let offset = 0;
  for (const track of tracks) {
    for (const chapter of track.chapters) {
      chapters.push({
        ...chapter,
        startSeconds: chapter.startSeconds + offset,
        endSeconds: chapter.endSeconds === null ? null : chapter.endSeconds + offset
      });
    }
    offset += track.durationSeconds ?? 0;
  }
  return chapters.sort((a, b) => a.startSeconds - b.startSeconds);
}

function tagTitle(value: string | null | undefined) {
  const title = value?.trim();
  return title ? title : null;
}

/**
 * Runs one step of an import, naming it if it fails.
 *
 * The platform's own errors say things like "Load failed" with no hint as to
 * what was being read, which leaves a reader — and anyone helping them — with
 * nothing to act on. A cancelled picker is passed through untouched, since the
 * caller recognises it by message and stays silent.
 */
async function importStep<T>(label: string, action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : String(error);
    if (/cancel/i.test(detail)) throw error;
    throw new Error(`${label}: ${detail}`);
  }
}

let deviceExtensionsMigrated = false;
/**
 * Imports made before the stored-extension rule kept the source file's `.m4b`
 * name, which iOS refuses to type. Rename them and repoint the stored library
 * so an existing import keeps playing after an app update. Cheap and idempotent
 * after the first pass, so callers can run it on every library load.
 *
 * Best effort: this sits in front of the library load, so a failure here must
 * leave the existing import alone rather than stop the shelf from appearing.
 */
export async function migrateDeviceLibraryFileExtensions() {
  if (!Capacitor.isNativePlatform() || deviceExtensionsMigrated) return;
  deviceExtensionsMigrated = true;
  try {
    const books = storedBooks();
    let changed = false;
    for (const book of books) {
      for (const track of book.tracks) {
        const path = track.localFilePath;
        if (!path) continue;
        const ext = extension(path);
        const stored = storedMediaExtension(ext);
        if (stored === ext) continue;
        const next = `${path.slice(0, path.length - ext.length)}${stored}`;
        try {
          await Filesystem.rename({
            from: path,
            to: next,
            directory: Directory.Data,
            toDirectory: Directory.Data
          });
        } catch {
          // A previous pass may have renamed the file without recording it.
          if (!(await fileExists(next))) continue;
        }
        track.localFilePath = next;
        changed = true;
      }
    }
    if (changed) writeJson(LIBRARY_KEY, books);
  } catch {
    // Retried on the next launch.
  }
}

let deviceMetadataBackfilled = false;
/**
 * Books imported before the app could read tags kept only a file name. Read
 * their metadata now so an existing import gains its cover, author and
 * chapters without being imported again.
 *
 * Durations and identifiers are left exactly as they were: they anchor saved
 * progress, and no tag is worth moving a listener's place in a book.
 */
export async function backfillDeviceLibraryMetadata() {
  if (!Capacitor.isNativePlatform() || deviceMetadataBackfilled) return;
  deviceMetadataBackfilled = true;
  try {
    const books = storedBooks();
    let changed = false;
    for (const book of books) {
      const untagged =
        !book.author && !book.localCoverPath && !book.chapters.some((chapter) => chapter.source === "embedded-chapters");
      if (!untagged) continue;
      const tagsByTrack: (AudioFileTags | null)[] = [];
      for (const track of book.tracks) {
        tagsByTrack.push(track.localFilePath ? await readStoredFileTags(track.localFilePath) : null);
      }
      if (!tagsByTrack.some(Boolean)) continue;
      book.tracks.forEach((track, index) => {
        const tags = tagsByTrack[index];
        if (!tags) return;
        track.title = tagTitle(tags.title) ?? track.title;
        track.metadata = summaryFromTags(tags);
        track.chapters = trackChapters(track, tags);
      });
      const bookTags = tagsByTrack[0];
      const cover = tagsByTrack.find((tags) => tags?.cover)?.cover ?? null;
      const directory = book.tracks[0]?.localFilePath?.split("/").slice(0, -1).join("/");
      const localCoverPath = cover && directory ? await writeCoverArt(directory, cover) : null;
      book.title =
        tagTitle(bookTags?.album) ??
        (book.tracks.length === 1 ? tagTitle(bookTags?.title) : null) ??
        book.title;
      book.author = bookTags?.author ?? book.author;
      book.narrator = bookTags?.narrator ?? book.narrator;
      book.description = bookTags?.description ?? book.description;
      book.genres = bookTags?.genres.length ? bookTags.genres : book.genres;
      book.publishedDate = bookTags?.publishedDate ?? book.publishedDate;
      book.asin = bookTags?.asin ?? book.asin;
      book.metadata = summaryFromTags(bookTags);
      book.chapters = bookChapters(book.tracks);
      if (localCoverPath) {
        book.localCoverPath = localCoverPath;
        book.coverArtContentType = cover!.contentType;
      }
      changed = true;
    }
    if (changed) writeJson(LIBRARY_KEY, books);
  } catch {
    // Retried on the next launch.
  }
}

export async function importAudiobookFromDevice(
  onProgress?: (completed: number, total: number) => void
): Promise<Book> {
  if (!Capacitor.isNativePlatform()) throw new Error("Device file import is available in the iOS and Android apps.");
  const picked = await importStep("The file picker could not be opened", () =>
    FilePicker.pickFiles({ limit: 0, readData: false })
  );
  const files = picked.files
    .filter((file) => isSupportedAudioFileName(file.name) || !!file.mimeType?.startsWith("audio/"))
    .sort(naturalCompare);
  if (!files.length) throw new Error("Choose at least one supported audiobook audio file.");
  if (files.some((file) => !file.path)) throw new Error("The file picker did not provide access to one or more files.");

  const id = `device:${crypto.randomUUID()}`;
  const directory = `${LIBRARY_ROOT}/${sanitizeSegment(id)}`;
  await importStep("The book folder could not be created", () =>
    Filesystem.mkdir({ path: directory, directory: Directory.Data, recursive: true })
  );
  const tracks: Track[] = [];
  const tagsByTrack: (AudioFileTags | null)[] = [];
  const discardCopiedFiles = () =>
    Filesystem.rmdir({ path: directory, directory: Directory.Data, recursive: true }).catch(() => undefined);
  try {
    for (const [index, file] of files.entries()) {
      const ext = storedMediaExtension(extension(file.name) || "m4a");
      const path = `${directory}/track-${String(index + 1).padStart(4, "0")}.${sanitizeSegment(ext)}`;
      const destination = await Filesystem.getUri({ path, directory: Directory.Data });
      // Each import gets a unique directory, so overwriting cannot replace an
      // existing book. The Android plugin currently mishandles `false` for a
      // destination that does not exist yet; the default `true` works on both
      // platforms.
      await importStep(`${file.name} could not be copied onto this device`, () =>
        FilePicker.copyFile({ from: file.path!, to: destination.uri, overwrite: true })
      );
      const tags = await readStoredFileTags(path);
      // The container's own duration is exact and free; the audio element is
      // only needed for files whose tags do not carry one.
      const durationSeconds = tags?.durationSeconds ?? (await mediaDuration(path));
      const trackId = `${id}:track:${index + 1}`;
      const track: Track = {
        id: trackId,
        title: tagTitle(tags?.title) ?? file.name.replace(/\.[^.]+$/, ""),
        fileName: file.name,
        index,
        durationSeconds,
        streamUrl: "",
        chapters: [],
        metadata: summaryFromTags(tags),
        localFilePath: path
      };
      track.chapters = trackChapters(track, tags);
      tracks.push(track);
      tagsByTrack.push(tags);
      onProgress?.(index + 1, files.length);
    }
  } catch (error) {
    await discardCopiedFiles();
    throw error;
  }

  const bookTags = tagsByTrack[0];
  const cover = tagsByTrack.find((tags) => tags?.cover)?.cover ?? null;
  const localCoverPath = cover ? await writeCoverArt(directory, cover) : null;
  const knownDuration = tracks.every((track) => track.durationSeconds !== null);
  const book: Book = {
    id,
    // A single file names the whole book; across several files only the album
    // does, because each file's own title is just that part's name.
    title:
      tagTitle(bookTags?.album) ??
      (files.length === 1 ? tagTitle(bookTags?.title) : null) ??
      inferredTitle(files[0].name),
    author: bookTags?.author ?? null,
    narrator: bookTags?.narrator ?? null,
    durationSeconds: knownDuration ? tracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0) : null,
    trackCount: tracks.length,
    coverArtUrl: null,
    coverArtContentType: localCoverPath ? cover!.contentType : null,
    localCoverPath: localCoverPath ?? undefined,
    description: bookTags?.description ?? null,
    genres: bookTags?.genres ?? [],
    publishedDate: bookTags?.publishedDate ?? null,
    asin: bookTags?.asin ?? null,
    readingFile: null,
    syncFile: null,
    chapters: bookChapters(tracks),
    metadata: summaryFromTags(bookTags),
    tracks,
    progress: null,
    source: "device",
    deviceBookId: id
  };
  // Without an index entry the copied files are orphans nothing can list or
  // delete, so a failed index write rolls the copy back too.
  try {
    await importStep("The imported book could not be saved", async () =>
      writeJson(LIBRARY_KEY, [...storedBooks(), book])
    );
  } catch (error) {
    await discardCopiedFiles();
    throw error;
  }
  return book;
}

export async function removeDeviceBook(bookId: string) {
  const book = storedBooks().find((candidate) => candidate.id === bookId);
  const path = book?.tracks[0]?.localFilePath?.split("/").slice(0, -1).join("/");
  if (path) await Filesystem.rmdir({ path, directory: Directory.Data, recursive: true }).catch(() => undefined);
  writeJson(LIBRARY_KEY, storedBooks().filter((candidate) => candidate.id !== bookId));
  // Media and listening history have different lifetimes. Keep the compact
  // progress record even when the on-device files are removed.
}

/** Attach a picked-file copy to an equivalent server book and hide the duplicate device row. */
export function mergeDeviceAndServerBooks(serverBooks: Book[], deviceBooks = getDeviceBooks()): Book[] {
  const unmatched = new Set(deviceBooks.map((book) => book.id));
  const merged = serverBooks.map((serverBook) => {
    const candidates = deviceBooks.filter((candidate) =>
      unmatched.has(candidate.id) &&
      deviceBookMatchesServer(candidate, serverBook)
    );
    if (candidates.length !== 1) return { ...serverBook, source: "server" as const };
    const deviceBook = candidates[0];
    const matchingServerCount = serverBooks.filter((candidate) =>
      deviceBookMatchesServer(deviceBook, candidate)
    ).length;
    if (matchingServerCount !== 1) return { ...serverBook, source: "server" as const };
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
