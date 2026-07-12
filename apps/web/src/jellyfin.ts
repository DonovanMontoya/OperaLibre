import type { AuthUser, Book, Chapter, Progress, Track } from "./types";

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
    allowedBookIds: null,
    createdAt: user.LastLoginDate ?? new Date(0).toISOString()
  };
}

function fileName(item: JellyfinItem) {
  const path = item.Path?.replace(/\\/g, "/");
  return path?.split("/").pop() || item.Name || "Audiobook";
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

  const totalDuration = tracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
  const firstUnplayedIndex = sorted.findIndex((item) => !item.UserData?.Played);
  const positionedIndex = sorted.reduce(
    (found, item, index) => (item.UserData?.PlaybackPositionTicks ?? 0) > 0 ? index : found,
    -1
  );
  const activeIndex = positionedIndex >= 0
    ? positionedIndex
    : firstUnplayedIndex >= 0
      ? firstUnplayedIndex
      : Math.max(0, tracks.length - 1);
  const activeTrack = tracks[activeIndex];
  const activePosition = seconds(sorted[activeIndex]?.UserData?.PlaybackPositionTicks) ?? 0;
  const bookPosition = tracks
    .slice(0, activeIndex)
    .reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0) + activePosition;
  const allPlayed = sorted.every((item) => item.UserData?.Played);
  const playedDates = sorted
    .map((item) => item.UserData?.LastPlayedDate)
    .filter((value): value is string => !!value)
    .sort();
  const lastPlayedAt = playedDates[playedDates.length - 1] ?? new Date(0).toISOString();
  const effectivePosition = allPlayed && totalDuration > 0 ? totalDuration : bookPosition;

  const progress: Progress | null = effectivePosition > 0 || allPlayed
    ? {
        bookId: id,
        trackId: activeTrack.id,
        positionSeconds: allPlayed ? activeTrack.durationSeconds ?? 0 : activePosition,
        bookPositionSeconds: effectivePosition,
        durationSeconds: totalDuration || null,
        updatedAt: lastPlayedAt
      }
    : null;
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
      genres: first.Genres ?? [],
      rawFields: []
    },
    tracks,
    progress: progress
      ? {
          status: allPlayed ? "finished" : "inProgress",
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
  return { token: result.AccessToken, user: mapUser(result.User) };
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
    updatedAt: new Date().toISOString()
  };
  progressByBook.set(bookId, saved);
  return saved;
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
