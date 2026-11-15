import assert from "node:assert/strict";
import test from "node:test";
import { loadHook } from "./hookHarness.ts";
import { library } from "./performance/fixtures.ts";
import type { Book } from "../src/types.ts";

function deferred() {
  let resolve!: (value: string | null) => void;
  const promise = new Promise<string | null>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(native = true) {
  const slots: unknown[] = [];
  let index = 0;
  let previousDependencies: unknown[] | undefined;
  let cleanup: (() => void) | undefined;
  const requests: { book: Book; legacy: boolean; result: ReturnType<typeof deferred> }[] = [];
  const released: string[] = [];
  const hook = loadHook("useOfflineCover", {
    "@capacitor/core": { Capacitor: { isNativePlatform: () => native } },
    react: {
      useRef(initial: unknown) {
        const slot = index++;
        if (!(slot in slots)) slots[slot] = { current: initial };
        return slots[slot];
      },
      useState(initial: unknown) {
        const slot = index++;
        if (!(slot in slots)) slots[slot] = initial;
        return [slots[slot], (value: unknown) => { slots[slot] = value; }];
      },
      useEffect(effect: () => (() => void) | undefined, dependencies: unknown[]) {
        if (!previousDependencies || dependencies.some((value, i) => value !== previousDependencies![i])) {
          cleanup?.();
          previousDependencies = dependencies;
          cleanup = effect();
        }
      }
    },
    "./offline": {
      getOfflineCoverUrl(book: Book, legacy: boolean) {
        const result = deferred();
        requests.push({ book, legacy, result });
        return result.promise;
      },
      releaseOfflineMediaUrl: (url: string) => released.push(url)
    }
  });
  const render = (book: Book, key: string) => { index = 0; return Reflect.apply(hook, undefined, [book, key]); };
  return { render, requests, released, unmount: () => cleanup?.() };
}

// Drain the promise chain without relying on elapsed time or timers.
async function settle() {
  await new Promise<void>(resolve => setImmediate(resolve));
}
const book = { ...library(1)[0], coverArtUrl: "/cover?v=one" };

test("native covers wait for disk and reuse the current image across progress updates", async () => {
  const f = fixture();
  assert.equal(f.render(book, "one").pending, true);
  assert.equal(f.requests.length, 1);
  f.requests[0].result.resolve("file://saved-cover.png");
  await settle();
  assert.equal(f.render(book, "one").local.current, "file://saved-cover.png");
  assert.equal(f.render({ ...book, progress: {
    status: "inProgress", bookPositionSeconds: 180, durationSeconds: 240,
    remainingSeconds: 60, percentComplete: 75, updatedAt: "2026-11-14T13:00:00Z"
  } }, "one").pending, false);
  assert.equal(f.requests.length, 1, "book object changes must not repeat filesystem lookups");
  f.unmount();
  assert.deepEqual(f.released, ["file://saved-cover.png"]);
});

test("a cache miss allows the remote cover before the legacy fallback finishes", async () => {
  const f = fixture();
  f.render(book, "one");
  f.requests[0].result.resolve(null);
  await settle();
  assert.equal(f.render(book, "one").pending, false);
  assert.equal(f.render(book, "one").local.current, null);
  assert.equal(f.requests[1].legacy, true);
  f.requests[1].result.resolve("file://older.png");
  await settle();
  assert.equal(f.render(book, "one").local.fallback, "file://older.png");
  f.unmount();
});

test("a replacement never exposes the previous lookup's result", async () => {
  const f = fixture();
  f.render(book, "one");
  const replacement = { ...book, coverArtUrl: "/cover?v=two" };
  assert.equal(f.render(replacement, "two").pending, true);
  f.requests[0].result.resolve("file://stale.png");
  await settle();
  assert.equal(f.render(replacement, "two").local, null);
  assert.deepEqual(f.released, ["file://stale.png"]);
  f.requests[1].result.resolve("file://replacement.png");
  await settle();
  assert.equal(f.render(replacement, "two").local.current, "file://replacement.png");
  f.unmount();
});

test("web covers do not wait for native storage", () => {
  const f = fixture(false);
  assert.equal(f.render(book, "one").pending, false);
  assert.equal(f.requests.length, 0);
});
