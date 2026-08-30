// Jellyfin keeps playback position on each track item and OperaLibre caches
// what a library fetch saw. Foreground adoption reads that cache, so without a
// per-book refresh a position another Jellyfin client recorded while this app
// was backgrounded stays invisible and the warm resume keeps the stale spot.

import assert from "node:assert/strict";
import test from "node:test";

const TICKS_PER_SECOND = 10_000_000;

const store = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms),
  clearTimeout: (id: number) => clearTimeout(id),
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
};

const {
  getCachedJellyfinProgress,
  getJellyfinBooks,
  refreshJellyfinProgress
} = await import("../src/jellyfin.ts");

type ItemState = { positionSeconds: number; played: boolean; lastPlayedAt: string | null };

/** One book, two 3600s tracks, with the user data a Jellyfin server would hold. */
const state: ItemState[] = [
  { positionSeconds: 1000, played: false, lastPlayedAt: "2026-08-27T08:16:40.000Z" },
  { positionSeconds: 0, played: false, lastPlayedAt: null }
];

function item(index: number) {
  return {
    Id: `t${index + 1}`,
    Name: `Track ${index + 1}`,
    Album: "The Book",
    AlbumId: "book-1",
    AlbumArtist: "A Writer",
    IndexNumber: index + 1,
    RunTimeTicks: 3600 * TICKS_PER_SECOND,
    UserData: {
      PlaybackPositionTicks: state[index].positionSeconds * TICKS_PER_SECOND,
      Played: state[index].played,
      LastPlayedDate: state[index].lastPlayedAt
    }
  };
}

const requested: string[] = [];

(globalThis as Record<string, unknown>).fetch = async (url: string) => {
  requested.push(url);
  const path = url.replace("https://jellyfin.example", "");
  const body = path.startsWith("/Users/Me")
    ? { Id: "user-1", Name: "listener" }
    : {
        Items: (() => {
          const ids = new URL(url).searchParams.get("ids");
          const indexes = ids
            ? ids.split(",").map((id) => Number(id.replace("t", "")) - 1)
            : [0, 1];
          // Answer in Jellyfin's own order, not the book's track order.
          return indexes.map(item).reverse();
        })()
      };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};

test("a per-book refresh sees the position another Jellyfin client recorded", async () => {
  const books = await getJellyfinBooks("https://jellyfin.example", "token");
  const book = books[0];
  assert.equal(book.tracks.length, 2);
  assert.equal(getCachedJellyfinProgress(book.id)?.bookPositionSeconds, 1000);

  // Another client listens on into the second track while this app sleeps.
  state[0] = { positionSeconds: 3600, played: true, lastPlayedAt: "2026-08-27T09:00:00.000Z" };
  state[1] = { positionSeconds: 1400, played: false, lastPlayedAt: "2026-08-27T09:23:20.000Z" };

  // The library-fetch cache alone still reports the pre-background position.
  assert.equal(getCachedJellyfinProgress(book.id)?.bookPositionSeconds, 1000);

  const refreshed = await refreshJellyfinProgress("https://jellyfin.example", "token", book);
  assert.equal(refreshed?.trackId, "t2");
  assert.equal(refreshed?.bookPositionSeconds, 5000);
  assert.equal(refreshed?.positionSeconds, 1400);
  assert.equal(refreshed?.updatedAt, "2026-08-27T09:23:20.000Z");
  assert.equal(
    getCachedJellyfinProgress(book.id)?.bookPositionSeconds,
    5000,
    "the refresh also heals the cache the rest of the app reads"
  );
  assert.ok(
    requested.some((url) => url.includes("ids=t1%2Ct2") || url.includes("ids=t1,t2")),
    "the refresh asks for only this book's tracks"
  );
});

test("a partial answer leaves the cached position alone", async () => {
  const books = await getJellyfinBooks("https://jellyfin.example", "token");
  const book = books[0];
  const cached = getCachedJellyfinProgress(book.id);

  const previousFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async (url: string) => {
    const body = url.includes("/Users/Me")
      ? { Id: "user-1", Name: "listener" }
      : { Items: [item(0)] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const refreshed = await refreshJellyfinProgress("https://jellyfin.example", "token", book);
    assert.deepEqual(refreshed, cached);
  } finally {
    (globalThis as Record<string, unknown>).fetch = previousFetch;
  }
});
