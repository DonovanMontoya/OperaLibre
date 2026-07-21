import type { AuthUser, Book, MetadataSummary, ProfileStats, Progress } from "./types";

const DEMO_MODE_STORAGE_KEY = "operalibre.demoMode";
const DEMO_PROGRESS_STORAGE_PREFIX = "operalibre.demoProgress";
const DEMO_MEDIA_PREFIX = "/demo/";

export const DEMO_USER: AuthUser = {
  id: "operalibre-on-device-demo",
  username: "Demo Reader",
  isAdmin: false,
  isOwner: false,
  canApproveLibationRequests: false,
  allowedBookIds: null,
  libationAccess: "approval",
  createdAt: "1735689600"
};

const metadata = (
  album: string,
  publisher: string,
  description: string,
  genres: string[]
): MetadataSummary => ({
  album,
  subtitle: null,
  publisher,
  publishedDate: "2026",
  description,
  language: "en",
  genres,
  rawFields: []
});

const lanternDescription =
  "An original OperaLibre demonstration about a cartographer following a chain of lanterns through an imaginary midnight archive. The accompanying audio is a procedural soundscape generated entirely on this device.";
const weatherDescription =
  "An original field-note collection from a fictional island observatory, paired with an on-device procedural listening track.";

const DEMO_BOOKS: Book[] = [
  {
    id: "demo-lantern-atlas",
    title: "The Lantern Atlas",
    author: "OperaLibre Studio",
    narrator: "OperaLibre Procedural Audio",
    durationSeconds: 48,
    trackCount: 2,
    coverArtUrl: "/demo/covers/lantern-atlas.svg",
    coverArtContentType: "image/svg+xml",
    description: lanternDescription,
    genres: ["Fiction", "Adventure"],
    publishedDate: "2026",
    asin: null,
    readingFile: {
      id: "demo-lantern-notes",
      fileName: "The Lantern Atlas — Field Notes.html",
      extension: "html",
      contentType: "text/html",
      url: "/demo/readalong/lantern-atlas.html"
    },
    syncFile: null,
    chapters: [
      { id: "demo-lantern-c1", title: "The Brass Door", trackId: "demo-lantern-t1", trackIndex: 0, startSeconds: 0, endSeconds: 12, source: "demo" },
      { id: "demo-lantern-c2", title: "A Map of Light", trackId: "demo-lantern-t1", trackIndex: 0, startSeconds: 12, endSeconds: 24, source: "demo" },
      { id: "demo-lantern-c3", title: "The Midnight Stacks", trackId: "demo-lantern-t2", trackIndex: 1, startSeconds: 24, endSeconds: 36, source: "demo" },
      { id: "demo-lantern-c4", title: "Home by Morning", trackId: "demo-lantern-t2", trackIndex: 1, startSeconds: 36, endSeconds: 48, source: "demo" }
    ],
    metadata: metadata("The Lantern Atlas", "OperaLibre Studio", lanternDescription, ["Fiction", "Adventure"]),
    tracks: [
      {
        id: "demo-lantern-t1",
        title: "Part One — The Brass Door",
        fileName: "lantern-atlas-part-one.wav",
        index: 0,
        durationSeconds: 24,
        streamUrl: "/demo/audio/lantern-one.wav",
        chapters: [],
        metadata: metadata("The Lantern Atlas", "OperaLibre Studio", lanternDescription, ["Fiction", "Adventure"])
      },
      {
        id: "demo-lantern-t2",
        title: "Part Two — The Midnight Stacks",
        fileName: "lantern-atlas-part-two.wav",
        index: 1,
        durationSeconds: 24,
        streamUrl: "/demo/audio/lantern-two.wav",
        chapters: [],
        metadata: metadata("The Lantern Atlas", "OperaLibre Studio", lanternDescription, ["Fiction", "Adventure"])
      }
    ],
    progress: null
  },
  {
    id: "demo-small-weather",
    title: "A Small Weather",
    author: "OperaLibre Studio",
    narrator: "OperaLibre Procedural Audio",
    durationSeconds: 30,
    trackCount: 1,
    coverArtUrl: "/demo/covers/small-weather.svg",
    coverArtContentType: "image/svg+xml",
    description: weatherDescription,
    genres: ["Nature", "Essays"],
    publishedDate: "2026",
    asin: null,
    readingFile: null,
    syncFile: null,
    chapters: [
      { id: "demo-weather-c1", title: "Barometer", trackId: "demo-weather-t1", trackIndex: 0, startSeconds: 0, endSeconds: 10, source: "demo" },
      { id: "demo-weather-c2", title: "Rain Glass", trackId: "demo-weather-t1", trackIndex: 0, startSeconds: 10, endSeconds: 20, source: "demo" },
      { id: "demo-weather-c3", title: "Clear Sky", trackId: "demo-weather-t1", trackIndex: 0, startSeconds: 20, endSeconds: 30, source: "demo" }
    ],
    metadata: metadata("A Small Weather", "OperaLibre Studio", weatherDescription, ["Nature", "Essays"]),
    tracks: [
      {
        id: "demo-weather-t1",
        title: "Observatory Notes",
        fileName: "a-small-weather.wav",
        index: 0,
        durationSeconds: 30,
        streamUrl: "/demo/audio/small-weather.wav",
        chapters: [],
        metadata: metadata("A Small Weather", "OperaLibre Studio", weatherDescription, ["Nature", "Essays"])
      }
    ],
    progress: null
  }
];

const fallbackProgress = new Map<string, Progress>();
const audioUrls = new Map<string, string>();

function storageAvailable() {
  return typeof window !== "undefined" && !!window.localStorage;
}

export function isDemoMode() {
  return storageAvailable() && window.localStorage.getItem(DEMO_MODE_STORAGE_KEY) === "true";
}

export function enterDemoMode() {
  if (storageAvailable()) window.localStorage.setItem(DEMO_MODE_STORAGE_KEY, "true");
}

export function exitDemoMode() {
  if (storageAvailable()) window.localStorage.removeItem(DEMO_MODE_STORAGE_KEY);
}

function progressKey(bookId: string) {
  return `${DEMO_PROGRESS_STORAGE_PREFIX}.${bookId}`;
}

export function getDemoProgress(bookId: string): Progress | null {
  if (storageAvailable()) {
    try {
      return JSON.parse(window.localStorage.getItem(progressKey(bookId)) ?? "null") as Progress | null;
    } catch {
      return null;
    }
  }
  return fallbackProgress.get(bookId) ?? null;
}

export function saveDemoProgress(
  bookId: string,
  progress: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">
    & Partial<Pick<Progress, "updatedAt">>
): Progress {
  const saved: Progress = {
    bookId,
    trackId: progress.trackId,
    positionSeconds: progress.positionSeconds,
    bookPositionSeconds: progress.bookPositionSeconds,
    durationSeconds: progress.durationSeconds,
    updatedAt: progress.updatedAt ?? new Date().toISOString()
  };
  fallbackProgress.set(bookId, saved);
  if (storageAvailable()) window.localStorage.setItem(progressKey(bookId), JSON.stringify(saved));
  return saved;
}

function bookProgress(book: Book, progress: Progress | null): Book["progress"] {
  if (!progress) return null;
  const duration = book.durationSeconds ?? 0;
  const remaining = Math.max(0, duration - progress.bookPositionSeconds);
  const percent = duration > 0 ? Math.min(100, (progress.bookPositionSeconds / duration) * 100) : null;
  return {
    status: remaining <= 1 ? "finished" : progress.bookPositionSeconds > 0 ? "inProgress" : "notStarted",
    bookPositionSeconds: progress.bookPositionSeconds,
    durationSeconds: book.durationSeconds,
    remainingSeconds: remaining,
    percentComplete: percent,
    updatedAt: progress.updatedAt
  };
}

export function getDemoBooks(): Book[] {
  return DEMO_BOOKS.map((book) => ({
    ...book,
    metadata: { ...book.metadata, genres: [...book.metadata.genres], rawFields: [] },
    genres: [...book.genres],
    chapters: book.chapters.map((chapter) => ({ ...chapter })),
    tracks: book.tracks.map((track) => ({
      ...track,
      chapters: track.chapters.map((chapter) => ({ ...chapter })),
      metadata: { ...track.metadata, genres: [...track.metadata.genres], rawFields: [] }
    })),
    progress: bookProgress(book, getDemoProgress(book.id))
  }));
}

function svgDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function coverSvg(title: string, subtitle: string, colors: [string, string, string], motif: "lantern" | "weather") {
  const art = motif === "lantern"
    ? `<g fill="none" stroke="#f6df9b" stroke-width="4"><path d="M256 95v55M205 171h102l-14 145h-74z"/><path d="M224 171q32-53 64 0"/></g><circle cx="256" cy="236" r="36" fill="#f1b94b" opacity=".82"/>`
    : `<g fill="none" stroke="#eef5ef" stroke-width="5" stroke-linecap="round"><path d="M130 190c42-52 85-12 91 14 18-45 85-34 94 14 50-15 79 65 18 78H142c-68-10-66-89-12-106z"/><path d="M182 326l-14 31M252 326l-14 31M322 326l-14 31"/></g>`;
  return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors[0]}"/><stop offset=".62" stop-color="${colors[1]}"/><stop offset="1" stop-color="${colors[2]}"/></linearGradient></defs>
    <rect width="512" height="512" rx="26" fill="url(#g)"/><path d="M46 48h420v416H46z" fill="none" stroke="rgba(255,255,255,.2)" stroke-width="2"/>${art}
    <text x="256" y="408" text-anchor="middle" fill="#fff8e8" font-family="Georgia,serif" font-size="34">${title}</text>
    <text x="256" y="441" text-anchor="middle" fill="rgba(255,248,232,.72)" font-family="Georgia,serif" font-size="16" letter-spacing="3">${subtitle}</text>
  </svg>`);
}

const covers: Record<string, string> = {
  "/demo/covers/lantern-atlas.svg": coverSvg("The Lantern Atlas", "AN ORIGINAL DEMO", ["#17152b", "#57233b", "#aa6035"], "lantern"),
  "/demo/covers/small-weather.svg": coverSvg("A Small Weather", "AN ORIGINAL DEMO", ["#15323b", "#315c63", "#9b7653"], "weather")
};

const readalongHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  body{margin:0;padding:2.2rem;background:#fffaf0;color:#261d18;font:18px/1.75 Georgia,serif}main{max-width:42rem;margin:auto}h1{font-size:2.2rem;font-weight:400;margin:.2rem 0}h2{margin-top:2rem;color:#7b3429}.note{padding:1rem;border:1px solid #d8c8a5;background:#f6edda;font:14px/1.5 system-ui,sans-serif}
  </style></head><body><main><p class="note"><strong>Rights notice:</strong> This demo content was created specifically for OperaLibre. No third-party media is included.</p><h1>The Lantern Atlas</h1><p><em>Field notes from an imaginary midnight archive</em></p><h2>The Brass Door</h2><p>At twelve, the brass door opened onto a corridor that was not on any plan. Elia lifted the first lantern and drew a careful line where the dark had been.</p><h2>A Map of Light</h2><p>Each lamp revealed another shelf, another small country of paper. Her atlas grew by glow rather than distance: amber for questions, gold for discoveries, blue for the way home.</p><h2>The Midnight Stacks</h2><p>The archive breathed like a sleeping house. Elia listened, marked the quiet turns, and left a lantern wherever the path divided.</p><h2>Home by Morning</h2><p>At dawn she closed the atlas. The corridor vanished, but the drawn lights remained, waiting for the next reader.</p></main></body></html>`;

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

// The demo audio is synthesized from scratch as PCM. It contains no recording,
// sampled instrument, melody, voice, or other third-party media.
function proceduralWav(durationSeconds: number, seed: number): Blob {
  const sampleRate = 8_000;
  const sampleCount = Math.floor(durationSeconds * sampleRate);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);

  let noiseState = seed || 1;
  const base = 92 + (seed % 31);
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    noiseState ^= noiseState << 13;
    noiseState ^= noiseState >>> 17;
    noiseState ^= noiseState << 5;
    const noise = ((noiseState >>> 0) / 0xffffffff) * 2 - 1;
    const pulsePhase = time % 4;
    const pulseEnvelope = pulsePhase < 1.35 ? Math.sin(Math.PI * pulsePhase / 1.35) ** 2 : 0;
    const slowEnvelope = Math.min(1, time / 1.5, (durationSeconds - time) / 1.5);
    const tone =
      Math.sin(2 * Math.PI * base * time + Math.sin(time * 0.19)) * 0.14 +
      Math.sin(2 * Math.PI * (base * 1.503) * time) * 0.06 +
      Math.sin(2 * Math.PI * (base * 2.017) * time) * 0.035;
    const chime = Math.sin(2 * Math.PI * (420 + seed % 80) * time) * pulseEnvelope * 0.13;
    const sample = Math.max(-1, Math.min(1, (tone + chime + noise * 0.012) * slowEnvelope));
    view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function isDemoMediaPath(path: string) {
  return path.startsWith(DEMO_MEDIA_PREFIX);
}

export function demoMediaUrl(path: string): string {
  if (covers[path]) return covers[path];
  if (path === "/demo/readalong/lantern-atlas.html") {
    return `data:text/html;charset=utf-8,${encodeURIComponent(readalongHtml)}`;
  }
  if (path.startsWith("/demo/audio/")) {
    const existing = audioUrls.get(path);
    if (existing) return existing;
    const duration = path.includes("small-weather") ? 30 : 24;
    const seed = [...path].reduce((value, character) => (value * 31 + character.charCodeAt(0)) | 0, 17);
    const url = URL.createObjectURL(proceduralWav(duration, seed));
    audioUrls.set(path, url);
    return url;
  }
  return path;
}

export function getDemoProfileStats(): ProfileStats {
  const books = getDemoBooks();
  const listenedSeconds = books.reduce((total, book) => total + (book.progress?.bookPositionSeconds ?? 0), 0);
  const today = new Date();
  const streakCalendar = Array.from({ length: 56 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (55 - index));
    return { date: date.toISOString().slice(0, 10), minutes: index > 48 && index % 2 === 0 ? 12 : 0 };
  });
  return {
    totalHoursRead: listenedSeconds / 3600,
    booksFinished: books.filter((book) => book.progress?.status === "finished").length,
    totalTracksCompleted: 0,
    currentStreakDays: 1,
    longestStreakDays: 3,
    avgDailyMinutes: 12,
    lastListenedAt: String(Math.floor(Date.now() / 1000)),
    favoriteNarrator: "OperaLibre Procedural Audio",
    favoriteGenre: "Fiction",
    daysActive: 4,
    memberSince: DEMO_USER.createdAt,
    streakCalendar,
    recentBooks: books.map((book) => ({
      id: book.id,
      title: book.title,
      coverArtUrl: book.coverArtUrl,
      hoursRead: (book.progress?.bookPositionSeconds ?? 0) / 3600,
      finished: book.progress?.status === "finished",
      updatedAt: book.progress?.updatedAt ?? String(Math.floor(Date.now() / 1000))
    }))
  };
}

export function demoContentIsSelfContained() {
  return DEMO_BOOKS.every((book) =>
    book.coverArtUrl?.startsWith(DEMO_MEDIA_PREFIX) &&
    book.tracks.every((track) => track.streamUrl.startsWith(DEMO_MEDIA_PREFIX)) &&
    (!book.readingFile || book.readingFile.url.startsWith(DEMO_MEDIA_PREFIX)) &&
    !book.asin
  );
}
