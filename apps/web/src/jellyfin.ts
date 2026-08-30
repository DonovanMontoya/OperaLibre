import type { AuthUser, Book, Chapter, Progress, Track } from "./types";
import { summarizeBookProgress } from "./reliability.ts";

const CLIENT_NAME = "OperaLibre";
const CLIENT_VERSION = "0.1.0";
const DEVICE_ID_STORAGE_KEY = "operalibre.jellyfinDeviceId";
const TICKS_PER_SECOND = 10_000_000;
const REQUEST_TIMEOUT_MS = 8_000;

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  init?.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
    init?.signal?.removeEventListener("abort", abort);
  }
}

type JellyfinUser = {
  Id?: string;
  Name?: string | null;
  LastLoginDate?: string | null;
  Policy?: { IsAdministrator?: boolean };
};

type JellyfinUserData = {
  PlaybackPositionTicks?: number;
  Played?: boolean;
  LastPlayedDate?: string | null;
};

type JellyfinChapter = {
  Name?: string | null;
  StartPositionTicks?: number;
};

type JellyfinPerson = {
  Name?: string | null;
  Role?: string | null;
  Type?: string | null;
};

type JellyfinItem = {
  Id?: string;
  Name?: string | null;
  Path?: string | null;
  Container?: string | null;
  MediaSources?: Array<{ Container?: string | null }> | null;
  Album?: string | null;
  AlbumId?: string | null;
  AlbumArtist?: string | null;
  Artists?: string[] | null;
  Overview?: string | null;
  Genres?: string[] | null;
  ProductionYear?: number | null;
  PremiereDate?: string | null;
  RunTimeTicks?: number | null;
  IndexNumber?: number | null;
  ParentIndexNumber?: number | null;
  ImageTags?: Record<string, string | null> | null;
  PrimaryImageItemId?: string | null;
  AlbumPrimaryImageTag?: string | null;
  ProviderIds?: Record<string, string | null> | null;
  Studios?: Array<{ Name?: string | null }> | null;
  People?: JellyfinPerson[] | null;
  Chapters?: JellyfinChapter[] | null;
  UserData?: JellyfinUserData | null;
};

type JellyfinItemsResponse = {
  Items?: JellyfinItem[] | null;
};

type JellyfinAuthenticationResult = {
  AccessToken?: string | null;
  User?: JellyfinUser | null;
};

const progressByBook = new Map<string, Progress | null>();

function deviceId() {
  if (typeof window === "undefined") {
    return "operalibre-web";
  }
  const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }
  const next = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `operalibre-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, next);
  return next;
}

function authorizationHeader(token?: string | null) {
  const fields = [
    `Client="${CLIENT_NAME}"`,
    `Device="Web"`,
    `DeviceId="${deviceId()}"`,
    `Version="${CLIENT_VERSION}"`
  ];
  if (token) {
    fields.push(`Token="${token}"`);
  }
  return `MediaBrowser ${fields.join(", ")}`;
}

async function jellyfinRequest<T>(
  baseUrl: string,
  path: string,
  token?: string | null,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", authorizationHeader(token));
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetchWithTimeout(`${baseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    let message = `Jellyfin request failed: ${response.status}`;
    try {
      const body = await response.json() as { Message?: string; message?: string };
      message = body.Message ?? body.message ?? message;
    } catch {
      // Jellyfin may return an empty body for authentication failures.
    }
    throw new Error(message);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

function seconds(ticks: number | null | undefined) {
  return typeof ticks === "number" && Number.isFinite(ticks)
    ? Math.max(0, ticks / TICKS_PER_SECOND)
    : null;
}

function ticks(value: number | null | undefined) {
  return Math.max(0, Math.round((value ?? 0) * TICKS_PER_SECOND));
}

function mapUser(user: JellyfinUser): AuthUser {
  if (!user.Id || !user.Name) {
    throw new Error("Jellyfin returned an incomplete user record.");
  }
  return {
    id: user.Id,
    username: user.Name,
    isAdmin: user.Policy?.IsAdministrator ?? false,
    isOwner: false,
    canApproveLibationRequests: false,
    allowedBookIds: null,
    libationAccess: "approval",
    createdAt: user.LastLoginDate ?? new Date(0).toISOString()
  };
}

/**
 * Offline downloads take their stored file extension from this name, so it has
 * to carry a real one. `Path` is hidden from non-admin Jellyfin users, and
 * neither `Name` nor the final fallback has an extension — without `Container`
 * an MPEG-4 audiobook would be stored as `.mp3` and fail to decode.
 */
function fileName(item: JellyfinItem) {
  const path = item.Path?.replace(/\\/g, "/");
  const named = path?.split("/").pop();
  if (named && /\.[A-Za-z0-9]{1,8}$/.test(named)) return named;
  const container = (item.Container || item.MediaSources?.[0]?.Container || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const base = named || item.Name || "Audiobook";
  // Only strip something that already looks like an extension, so a title with
  // a dot in it ("Vol. 1") keeps its text.
  return container ? `${base.replace(/\.[A-Za-z0-9]{1,8}$/, "")}.${container}` : base;
}

function narrator(item: JellyfinItem) {
  return item.People
    ?.filter((person) =>
      person.Role?.toLowerCase().includes("narrator") ||
      person.Type?.toLowerCase() === "narrator"
    )
    .map((person) => person.Name)
    .filter((name): name is string => !!name)
    .join(", ") || null;
}

function trackChapters(item: JellyfinItem, track: Track, trackOffset: number): Chapter[] {
  const chapters = item.Chapters ?? [];
  return chapters.map((chapter, index) => {
    const next = chapters[index + 1];
    const start = seconds(chapter.StartPositionTicks) ?? 0;
    return {
      id: `${track.id}-chapter-${index}`,
      title: chapter.Name || `Chapter ${index + 1}`,
      trackId: track.id,
      trackIndex: track.index,
      startSeconds: trackOffset + start,
      endSeconds: next?.StartPositionTicks === undefined
        ? trackOffset + (track.durationSeconds ?? start)
        : trackOffset + (seconds(next.StartPositionTicks) ?? start),
      source: "jellyfin"
    };
  });
}

function groupKey(item: JellyfinItem) {
  const albumArtist = item.AlbumArtist || item.Artists?.join(", ") || "unknown";
  return item.AlbumId || (item.Album ? `album:${albumArtist}:${item.Album}` : item.Id) || "unknown";
}

/**
 * Jellyfin keeps playback state on each track item rather than on the book, so
 * a book's position is whichever track carries a position (or the first
 * unplayed one) plus the durations before it. Shared by the library mapper and
 * the single-book refresh so both read the same book position from the same
 * user data.
 */
function readItemProgress(bookId: string, items: JellyfinItem[], tracks: Track[]) {
  const totalDuration = tracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
  const firstUnplayedIndex = items.findIndex((item) => !item.UserData?.Played);
  const positionedIndex = items.reduce(
    (found, item, index) => (item.UserData?.PlaybackPositionTicks ?? 0) > 0 ? index : found,
    -1
  );
  const activeIndex = positionedIndex >= 0
    ? positionedIndex
    : firstUnplayedIndex >= 0
      ? firstUnplayedIndex
      : Math.max(0, tracks.length - 1);
  const activeTrack = tracks[activeIndex];
  const activePosition = seconds(items[activeIndex]?.UserData?.PlaybackPositionTicks) ?? 0;
  const bookPosition = tracks
    .slice(0, activeIndex)
    .reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0) + activePosition;
  const allPlayed = items.every((item) => item.UserData?.Played);
  const playedDates = items
    .map((item) => item.UserData?.LastPlayedDate)
    .filter((value): value is string => !!value)
    .sort();
  const lastPlayedAt = playedDates[playedDates.length - 1] ?? new Date(0).toISOString();
  const effectivePosition = allPlayed && totalDuration > 0 ? totalDuration : bookPosition;

  const progress: Progress | null = activeTrack && (effectivePosition > 0 || allPlayed)
    ? {
        bookId,
        trackId: activeTrack.id,
        positionSeconds: allPlayed ? activeTrack.durationSeconds ?? 0 : activePosition,
        bookPositionSeconds: effectivePosition,
        durationSeconds: totalDuration || null,
        updatedAt: lastPlayedAt,
        finishedOverride: allPlayed ? true : null
      }
    : null;
  return { progress, allPlayed, effectivePosition, totalDuration };
}

function mapBook(items: JellyfinItem[]): Book | null {
  const sorted = [...items].sort((a, b) =>
    (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) ||
    (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0) ||
    (a.Name ?? "").localeCompare(b.Name ?? "")
  );
  const first = sorted[0];
  const id = groupKey(first);
  if (!first || id === "unknown") {
    return null;
  }

  const tracks: Track[] = sorted.flatMap((item, index) => {
    if (!item.Id) {
      return [];
    }
    return [{
      id: item.Id,
      title: item.Name || `Track ${index + 1}`,
      fileName: fileName(item),
      index,
      durationSeconds: seconds(item.RunTimeTicks),
      streamUrl: `/Audio/${encodeURIComponent(item.Id)}/stream?static=true`,
      downloadUrl: `/Items/${encodeURIComponent(item.Id)}/Download`,
      chapters: [],
      metadata: {
        album: item.Album ?? null,
        subtitle: null,
        publisher: item.Studios?.[0]?.Name ?? null,
        publishedDate: item.PremiereDate ?? (item.ProductionYear ? String(item.ProductionYear) : null),
        description: item.Overview ?? null,
        language: null,
        series: null,
        seriesPosition: null,
        genres: item.Genres ?? [],
        rawFields: []
      }
    }];
  });
  if (tracks.length === 0) {
    return null;
  }

  let offset = 0;
  const chapters: Chapter[] = [];
  tracks.forEach((track, index) => {
    track.chapters = trackChapters(sorted[index], track, offset);
    chapters.push(...track.chapters);
    offset += track.durationSeconds ?? 0;
  });

  const { progress, allPlayed, effectivePosition, totalDuration } = readItemProgress(
    id,
    sorted,
    tracks
  );
  progressByBook.set(id, progress);

  const author = first.AlbumArtist || first.Artists?.join(", ") || null;
  const coverItemId = first.PrimaryImageItemId || first.AlbumId || first.Id;
  const hasCover = !!(
    first.ImageTags?.Primary ||
    first.AlbumPrimaryImageTag ||
    first.PrimaryImageItemId
  );
  const remaining = totalDuration > 0 ? Math.max(0, totalDuration - effectivePosition) : null;
  const percent = totalDuration > 0 ? Math.min(100, (effectivePosition / totalDuration) * 100) : null;
  const publishedDate = first.PremiereDate ?? (first.ProductionYear ? String(first.ProductionYear) : null);

  return {
    id,
    title: first.Album || first.Name || "Untitled audiobook",
    author,
    narrator: narrator(first),
    durationSeconds: totalDuration || null,
    trackCount: tracks.length,
    coverArtUrl: hasCover && coverItemId
      ? `/Items/${encodeURIComponent(coverItemId)}/Images/Primary?fillHeight=600&quality=90`
      : null,
    coverArtContentType: hasCover ? "image/jpeg" : null,
    description: first.Overview ?? null,
    genres: first.Genres ?? [],
    publishedDate,
    asin: first.ProviderIds?.Audible ?? first.ProviderIds?.ASIN ?? null,
    readingFile: null,
    syncFile: null,
    chapters,
    metadata: {
      album: first.Album ?? null,
      subtitle: null,
      publisher: first.Studios?.[0]?.Name ?? null,
      publishedDate,
      description: first.Overview ?? null,
      language: null,
      series: null,
      seriesPosition: null,
      genres: first.Genres ?? [],
      rawFields: []
    },
    tracks,
    progress: progress
      ? {
          status: allPlayed ? "finished" : "inProgress",
          finishedOverride: allPlayed ? true : null,
          bookPositionSeconds: effectivePosition,
          durationSeconds: totalDuration || null,
          remainingSeconds: remaining,
          percentComplete: percent,
          updatedAt: progress.updatedAt
        }
      : null
  };
}

export async function pingJellyfin(baseUrl: string) {
  const response = await fetchWithTimeout(`${baseUrl}/System/Info/Public`);
  if (!response.ok) {
    throw new Error(`Jellyfin responded ${response.status}.`);
  }
}

export async function loginToJellyfin(baseUrl: string, username: string, password: string) {
  const result = await jellyfinRequest<JellyfinAuthenticationResult>(
    baseUrl,
    "/Users/AuthenticateByName",
    null,
    {
      method: "POST",
      body: JSON.stringify({ Username: username, Pw: password })
    }
  );
  if (!result.AccessToken || !result.User) {
    throw new Error("Jellyfin did not return an access token.");
  }
  return {
    token: result.AccessToken,
    // Jellyfin does not issue a narrower media credential, so its access
    // token remains the credential required by Jellyfin media URLs.
    mediaToken: result.AccessToken,
    user: mapUser(result.User)
  };
}

export async function getJellyfinUser(baseUrl: string, token: string) {
  return mapUser(await jellyfinRequest<JellyfinUser>(baseUrl, "/Users/Me", token));
}

export async function logoutFromJellyfin(baseUrl: string, token: string) {
  await jellyfinRequest<void>(baseUrl, "/Sessions/Logout", token, { method: "POST" });
}

export async function getJellyfinBooks(baseUrl: string, token: string) {
  const user = await jellyfinRequest<JellyfinUser>(baseUrl, "/Users/Me", token);
  if (!user.Id) {
    throw new Error("Jellyfin did not return a user id.");
  }
  const params = new URLSearchParams({
    userId: user.Id,
    recursive: "true",
    includeItemTypes: "AudioBook",
    fields: [
      "Path",
      "Overview",
      "Genres",
      "People",
      "ProviderIds",
      "Studios",
      "Chapters",
      "DateCreated",
      "PrimaryImageAspectRatio"
    ].join(","),
    enableImages: "true",
    enableUserData: "true",
    sortBy: "SortName",
    sortOrder: "Ascending"
  });
  const response = await jellyfinRequest<JellyfinItemsResponse>(
    baseUrl,
    `/Items?${params}`,
    token
  );

  progressByBook.clear();
  const groups = new Map<string, JellyfinItem[]>();
  for (const item of response.Items ?? []) {
    const key = groupKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(mapBook)
    .filter((book): book is Book => !!book);
}

export function getCachedJellyfinProgress(bookId: string) {
  return progressByBook.get(bookId) ?? null;
}

/**
 * The cached map above is only ever refilled by a full library fetch, so a
 * position another Jellyfin client recorded while this app was backgrounded is
 * invisible to a warm resume. Re-read just this book's track items so the
 * foreground adoption path sees the same fresh state an OperaLibre server
 * would have returned. Any failure leaves the cache untouched.
 */
export async function refreshJellyfinProgress(baseUrl: string, token: string, book: Book) {
  if (book.tracks.length === 0) {
    return getCachedJellyfinProgress(book.id);
  }
  const user = await jellyfinRequest<JellyfinUser>(baseUrl, "/Users/Me", token);
  if (!user.Id) {
    throw new Error("Jellyfin did not return a user id.");
  }
  const params = new URLSearchParams({
    userId: user.Id,
    ids: book.tracks.map((track) => track.id).join(","),
    enableUserData: "true"
  });
  const response = await jellyfinRequest<JellyfinItemsResponse>(
    baseUrl,
    `/Items?${params}`,
    token
  );
  const byId = new Map(
    (response.Items ?? []).flatMap((item) => (item.Id ? [[item.Id, item] as const] : []))
  );
  // /Items answers in its own order, and the active-track scan is positional:
  // read the items back in the book's track order. A partial answer says
  // nothing about the tracks it omitted, so keep the cached copy instead.
  const items = book.tracks.map((track) => byId.get(track.id));
  if (items.some((item) => !item)) {
    return getCachedJellyfinProgress(book.id);
  }
  const { progress } = readItemProgress(book.id, items as JellyfinItem[], book.tracks);
  progressByBook.set(book.id, progress);
  return progress;
}

export async function saveJellyfinProgress(
  baseUrl: string,
  token: string,
  bookId: string,
  progress: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">,
  isPaused = false
) {
  await jellyfinRequest<void>(baseUrl, "/Sessions/Playing/Progress", token, {
    method: "POST",
    body: JSON.stringify({
      ItemId: progress.trackId,
      PositionTicks: ticks(progress.positionSeconds),
      IsPaused: isPaused,
      PlayMethod: "DirectPlay",
      CanSeek: true
    })
  });
  const saved: Progress = {
    bookId,
    ...progress,
    updatedAt: new Date().toISOString(),
    finishedOverride: progressByBook.get(bookId)?.finishedOverride ?? null
  };
  progressByBook.set(bookId, saved);
  return saved;
}

export async function setJellyfinBookCompletion(
  baseUrl: string,
  token: string,
  book: Book,
  finished: boolean,
  finalProgress?: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">
) {
  if (!book.tracks.length) {
    throw new Error("This book has no playable tracks.");
  }
  await Promise.all(book.tracks.map((track) =>
    jellyfinRequest<unknown>(
      baseUrl,
      `/UserPlayedItems/${encodeURIComponent(track.id)}`,
      token,
      { method: finished ? "POST" : "DELETE" }
    )
  ));
  const existing = progressByBook.get(book.id);
  const firstTrack = book.tracks[0];
  const progress: Progress = {
    bookId: book.id,
    trackId: finalProgress?.trackId ?? existing?.trackId ?? firstTrack.id,
    positionSeconds: finalProgress?.positionSeconds ?? existing?.positionSeconds ?? 0,
    bookPositionSeconds: finalProgress?.bookPositionSeconds ?? existing?.bookPositionSeconds ?? 0,
    durationSeconds: finalProgress?.durationSeconds ?? existing?.durationSeconds ?? firstTrack.durationSeconds,
    updatedAt: finalProgress ? new Date().toISOString() : existing?.updatedAt ?? new Date().toISOString(),
    finishedOverride: finished
  };
  progressByBook.set(book.id, progress);
  return summarizeBookProgress(book, progress)!;
}

export async function reportJellyfinPlaybackStart(
  baseUrl: string,
  token: string,
  itemId: string,
  positionSeconds: number
) {
  await jellyfinRequest<void>(baseUrl, "/Sessions/Playing", token, {
    method: "POST",
    body: JSON.stringify({
      ItemId: itemId,
      PositionTicks: ticks(positionSeconds),
      IsPaused: false,
      PlayMethod: "DirectPlay",
      CanSeek: true
    })
  });
}

export function jellyfinMediaPath(path: string, token: string | null) {
  if (!token) {
    return path;
  }
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}api_key=${encodeURIComponent(token)}`;
}
