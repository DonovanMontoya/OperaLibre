import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { loadHook } from "./hookHarness.ts";
import { library } from "./performance/fixtures.ts";
import * as bookCover from "../src/bookCover.ts";
import type { Book } from "../src/types.ts";

const files = new Map<string, string>();
const state = { server: "server-a", failWrites: false, files };
Reflect.set(globalThis, "__editedCoverCache", state);
const mocks: Record<string, string> = {
  "@capacitor/core": "export const Capacitor = { isNativePlatform: () => true, convertFileSrc: value => value };",
  "@capacitor/filesystem": `const state = globalThis.__editedCoverCache;
    export const Directory = { Data: "DATA" };
    export const Filesystem = {
      mkdir: async () => {},
      stat: async ({path}) => { if (!state.files.has(path)) throw new Error('missing'); },
      getUri: async ({path}) => ({uri:'file://' + path}),
      writeFile: async ({path,data}) => { if (state.failWrites) throw new Error('full'); state.files.set(path,data); },
      readFile: async ({path}) => { if (!state.files.has(path)) throw new Error('missing'); return {data:state.files.get(path)}; },
      readdir: async ({path}) => ({files: [...state.files.keys()].filter(file => file.startsWith(path + '/'))
        .map(file => ({name:file.slice(path.length + 1)}))})
    };`,
  "./api": "export const getServerStorageKey = () => globalThis.__editedCoverCache.server; export const getServerUrl = () => '';",
  "./backgroundDownloads": "export const cancelBackgroundBookDownload = null, getBackgroundBookDownloadStatus = null, runBackgroundBookDownload = null;",
  "./mediaFiles": "export const fileExtension = () => ''; export const storedMediaExtension = value => value;",
  "./companionCache": "export const revalidatedCompanion = null;",
  "./offlineDownload": "export const downloadWebBook = null;"
};
register(`data:text/javascript,${encodeURIComponent(`
  const mocks = ${JSON.stringify(mocks)};
  export function resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/src/offline.ts') && specifier in mocks) {
      return {url:'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit:true};
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const offline = await import("../src/offline.ts");

function fixture() {
  files.clear();
  state.server = "server-a";
  state.failWrites = false;
  let books: Book[] = library(2).map(book => ({ ...book, source: "server", hasCoverOverride: true,
    coverArtUrl: `/api/books/${book.id}/cover?v=old`, coverArtContentType: "image/png" }));
  books.push({ ...library(1)[0], id: "device-book", source: "device" });
  let userId = "owner";
  const slots: any[] = [];
  let index = 0;
  const useState = (initial: any) => {
    const slot = index++;
    if (!(slot in slots)) slots[slot] = initial;
    return [slots[slot], (value: any) => { slots[slot] = typeof value === "function" ? value(slots[slot]) : value; }];
  };
  const writes: string[] = [];
  const api = {
    getServerStorageKey: () => state.server,
    updateBookMetadata: async (_id: string, update: object) => ({ ...books[0], ...update }),
    uploadBookCover: async () => { writes.push("upload"); return { ...books[0], coverArtUrl: "/cover?v=new" }; },
    removeBookCover: async () => { writes.push("remove"); return { ...books[0], hasCoverOverride: false, coverArtUrl: null, coverArtContentType: null }; }
  };
  const hook = loadHook("useMetadataEditor", {
    react: { useState, useRef: (value: unknown) => useState({current:value})[0], useEffect: () => {} },
    "./metadataEditor": { metadataEditorFromBook: (book: Book) => ({title:book.title}), metadataUpdateFromEditor: (form: unknown) => form },
    "./api": Object.fromEntries(Object.keys(api).map(key => [key, (...args: any[]) => (api as any)[key](...args)])),
    "./bookCover": bookCover, "./offline": offline,
    "./formatting": { errorMessage: (error: Error) => error.message }
  });
  const render = () => { index = 0; return hook({books, currentUserId:userId, selectedBook:books[0],
    setBooks: (update: (books: Book[]) => Book[]) => { books = update(books); }}); };
  render().openMetadataEditor(books[0]);
  const audioPath = `offline-media/server-a/${books[0].id}/track.wav`;
  files.set(audioPath, "original audio");
  files.set(`offline-media/server-a/${books[0].id}/cover-old.png`, "old artwork");
  return {render, api, writes, audioPath, books: () => books,
    changeUser: () => { userId = "other-owner"; render(); },
    advance: () => { books = books.map(book => ({...book, progress:{...book.progress!, bookPositionSeconds:180}})); render(); }};
}

for (const operation of ["replace", "restore"] as const) {
  test(`${operation} survives offline catalogue reload without changing downloaded audio or live progress`, async () => {
    const f = fixture();
    await offline.cacheLibrary("owner", f.books().filter(book => book.source !== "device"));
    if (operation === "restore") f.render().removeCover();
    else f.render().chooseCover(new File(["cover"], "cover.png", {type:"image/png"}));
    f.api.updateBookMetadata = async () => {
      const stale = {...f.books()[0]};
      f.advance();
      return stale;
    };
    await f.render().saveMetadata({preventDefault() {}});
    const reloaded = await offline.getCachedLibrary("owner");
    assert.equal(reloaded.length, 2, "device-only books stay in their own catalogue");
    assert.equal(reloaded[0].coverArtUrl, operation === "restore" ? null : "/cover?v=new");
    assert.equal(reloaded[0].hasCoverOverride, operation !== "restore");
    assert.equal(reloaded[0].progress?.bookPositionSeconds, 180);
    if (operation === "restore") assert.equal(await offline.getOfflineCoverUrl(reloaded[0], true), null);
    assert.equal(files.get(f.audioPath), "original audio");
    assert.equal(f.render().metadataEditOpen, false);
  });
}

test("a failed offline catalogue write leaves a retryable warning after the server saves", async () => {
  const f = fixture();
  f.render().removeCover();
  state.failWrites = true;
  await f.render().saveMetadata({preventDefault() {}});
  assert.deepEqual(f.writes, ["remove"]);
  assert.equal(f.books()[0].coverArtUrl, null);
  assert.match(f.render().metadataError, /saved on the server.*offline library/);
  state.failWrites = false;
  await f.render().saveMetadata({preventDefault() {}});
  assert.equal((await offline.getCachedLibrary("owner"))[0].coverArtUrl, null);
  assert.equal(f.render().metadataEditOpen, false);
});

for (const boundary of ["server", "user"] as const) {
  test(`switching ${boundary} during Save Info cannot write the next scope or send its cover`, async () => {
    const f = fixture();
    f.render().removeCover();
    f.api.updateBookMetadata = async () => {
      if (boundary === "server") state.server = "server-b";
      else f.changeUser();
      return f.books()[0];
    };
    await f.render().saveMetadata({preventDefault() {}});
    assert.deepEqual(f.writes, []);
    assert.equal([...files.keys()].some(path => path.endsWith(".json")), false);
  });
}
