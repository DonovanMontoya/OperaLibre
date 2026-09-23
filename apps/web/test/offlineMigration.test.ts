import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import type { Book, Progress } from "../src/types.ts";

// The legacy records these migrations read live in IndexedDB, which Node does
// not have. This stand-in keeps one "data" store in memory, runs callbacks on
// a later tick like the real thing, and fails writes to chosen keys.
const records = new Map<string, unknown>();
const failingWrites = new Set<string>();
const later = (callback: () => void) => setTimeout(callback, 0);

function transaction() {
  const tx = {
    oncomplete: null as null | (() => void),
    onerror: null as null | (() => void),
    error: null as Error | null,
    objectStore: () => ({
      get(key: string) {
        const request = {
          result: undefined as unknown,
          onsuccess: null as null | (() => void),
          onerror: null as null | (() => void)
        };
        later(() => {
          request.result = records.get(key);
          request.onsuccess?.();
        });
        return request;
      },
      put(value: unknown, key: string) {
        later(() => {
          if (failingWrites.has(key)) {
            tx.error = new Error("QuotaExceededError");
            tx.onerror?.();
            return;
          }
          records.set(key, value);
          tx.oncomplete?.();
        });
      },
      delete(key: string) {
        later(() => {
          records.delete(key);
          tx.oncomplete?.();
        });
      }
    })
  };
  return tx;
}

Reflect.set(globalThis, "indexedDB", {
  open() {
    const database = {
      objectStoreNames: { contains: () => true },
      transaction,
      onversionchange: null
    };
    const request = {
      result: database,
      onupgradeneeded: null,
      onsuccess: null as null | (() => void),
      onerror: null
    };
    later(() => request.onsuccess?.());
    return request;
  }
});

const mocks: Record<string, string> = {
  "@capacitor/core": "export const Capacitor = { isNativePlatform: () => false, convertFileSrc: (value) => value };",
  "@capacitor/filesystem": "export const Directory = { Data: \"DATA\" }; export const Filesystem = {};",
  "./api": "export const getServerStorageKey = () => \"server-a\"; export const getServerUrl = () => \"\";",
  "./backgroundDownloads": "export const cancelBackgroundBookDownload = null, getBackgroundBookDownloadStatus = null, runBackgroundBookDownload = null;",
  "./mediaFiles": "export const fileExtension = () => \"\"; export const storedMediaExtension = (value) => value;",
  "./companionCache": "export const revalidatedCompanion = null;",
  "./offlineDownload": "export const downloadWebBook = null;"
};
register(`data:text/javascript,${encodeURIComponent(`
  const mocks = ${JSON.stringify(mocks)};
  export function resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/src/offline.ts") && specifier in mocks) {
      return { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const { getCachedLibrary, getCachedProgress } = await import("../src/offline.ts");

const quietly = async <T>(run: () => Promise<T>) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.warn = warn;
  }
};

test("a failed library migration keeps the legacy snapshot", async () => {
  records.clear();
  failingWrites.clear();
  const books = [{ id: "book", title: "Book", tracks: [] }] as unknown as Book[];
  records.set("library:reader", { cachedAt: 1, books });
  failingWrites.add("server-a:library:reader");

  assert.deepEqual(await quietly(() => getCachedLibrary("reader")), books);
  assert.ok(records.has("library:reader"), "the only copy of the library was deleted");

  // Once the current store accepts it, the legacy record is retired.
  failingWrites.clear();
  assert.deepEqual(await getCachedLibrary("reader"), books);
  assert.ok(!records.has("library:reader"));
  assert.ok(records.has("server-a:library:reader"));
});

test("a failed progress migration still returns the position it read", async () => {
  records.clear();
  failingWrites.clear();
  const progress = {
    bookId: "book",
    trackId: "track",
    positionSeconds: 42,
    bookPositionSeconds: 42,
    durationSeconds: 100,
    updatedAt: "2026-09-22T00:00:00.000Z"
  } as Progress;
  records.set("progress:reader:book", progress);
  failingWrites.add("server-a:progress:reader:book");

  assert.deepEqual(await quietly(() => getCachedProgress("reader", "book")), progress);
  assert.ok(records.has("progress:reader:book"), "the legacy position was dropped");
});
