import assert from "node:assert/strict";
import test from "node:test";

(globalThis as Record<string, unknown>).window = {
  setTimeout, clearTimeout,
  localStorage: { getItem: () => "test-device", setItem: () => {} }
};
const { getJellyfinUser, getJellyfinBooks, reportJellyfinPlaybackStop, saveJellyfinProgress, setJellyfinBookCompletion, getCachedJellyfinProgress } = await import("../src/jellyfin.ts");
const base = "https://jellyfin.example";
const originalFetch = globalThis.fetch;

test("download policy is mapped for non-admins and admins without granting missing permissions", async () => {
  try {
    for (const admin of [false, true]) {
      for (const enabled of [false, true, undefined]) {
        globalThis.fetch = async () => Response.json({ Id: "reader", Name: "Reader", Policy: { IsAdministrator: admin, EnableContentDownloading: enabled } });
        const user = await getJellyfinUser(base, "token");
        assert.equal(user.isAdmin, admin);
        assert.equal(user.canDownload, enabled === true);
      }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("a non-admin M4B keeps a usable filename and track-specific download URL", async () => {
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/Users/Me") return Response.json({ Id: "reader", Name: "Reader" });
      assert.ok(url.searchParams.get("fields")?.includes("MediaSources"));
      return Response.json({ Items: [{ Id: "track", Name: "Book", MediaSources: [{ Container: "m4b" }], RunTimeTicks: 100000000 }] });
    };
    const [book] = await getJellyfinBooks(base, "token");
    assert.equal(book.tracks[0].fileName, "Book.m4b");
    assert.equal(book.tracks[0].downloadUrl, "/Items/track/Download");
  } finally { globalThis.fetch = originalFetch; }
});

test("stopping at zero still sends an explicit position, and progress forwards cancellation", async () => {
  try {
    const controller = new AbortController();
    globalThis.fetch = async (input, init) => {
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.PositionTicks, 0);
      assert.equal(payload.ItemId, "track");
      if (String(input).endsWith("/Progress")) {
        assert.equal(init?.signal?.aborted, true);
        throw new DOMException("Aborted", "AbortError");
      }
      assert.ok(String(input).endsWith("/Stopped"));
      return new Response(null, { status: 204 });
    };
    await reportJellyfinPlaybackStop(base, "token", "track", 0);
    controller.abort();
    await assert.rejects(saveJellyfinProgress(base, "token", "book", {
      trackId: "track", positionSeconds: 0, bookPositionSeconds: 0, durationSeconds: 100
    }, true, controller.signal), { name: "AbortError" });
  } finally { globalThis.fetch = originalFetch; }
});

test("multi-track completion and deliberate reset update every item", async () => {
  try {
    const writes: string[] = [];
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/Users/Me") return Response.json({ Id: "reader", Name: "Reader" });
      if (path === "/Items") return Response.json({ Items: [1, 2].map((n) => ({ Id: `track${n}`, Name: `Track ${n}`, AlbumId: "book", IndexNumber: n, RunTimeTicks: 1000000000 })) });
      writes.push(`${init?.method}:${path}`);
      return Response.json({});
    };
    const [book] = await getJellyfinBooks(base, "token");
    assert.equal((await setJellyfinBookCompletion(base, "token", book, true)).status, "finished");
    await setJellyfinBookCompletion(base, "token", book, false, {
      trackId: "track1", positionSeconds: 0, bookPositionSeconds: 0, durationSeconds: 100
    });
    assert.deepEqual(writes, ["POST:/UserPlayedItems/track1", "POST:/UserPlayedItems/track2", "DELETE:/UserPlayedItems/track1", "DELETE:/UserPlayedItems/track2"]);
    assert.equal(getCachedJellyfinProgress(book.id)?.bookPositionSeconds, 0);
    assert.equal(getCachedJellyfinProgress(book.id)?.finishedOverride, false);
  } finally { globalThis.fetch = originalFetch; }
});


test("an invalid stop clock cannot become a null position and mark the whole track played", async () => {
  try {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response(null, { status: 204 }); };
    for (const position of [NaN, Infinity, -Infinity]) {
      await assert.rejects(reportJellyfinPlaybackStop(base, "token", "track", position), /finite/);
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});
