import test from "node:test";
import assert from "node:assert/strict";
import { buildGiftDeviceBook, type NativeGiftAsset } from "../src/giftDeviceImport.ts";
import { bindGiftLocalSyncMap, loadGiftLocalSyncMap, parseGiftSyncMap } from "../src/giftLocalSync.ts";
import { parseGiftMetadata } from "../src/giftMetadata.ts";
import { findActiveFragmentIndex, readAlongMode } from "../src/readalong.ts";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { stageGiftImport, recoverGiftExtraction } from "../src/giftDeviceImport.ts";

const id = "gift____________";
const map = { version: 2, precision: "sentence", fragments: [
  { startSeconds: 0, endSeconds: 5, href: "Text/one.xhtml", text: "First sentence.", words: [[0, 2, 0, 5], [2, 5, 6, 9]] },
  { startSeconds: 10, endSeconds: 18, href: "Text/two.xhtml", text: "Second sentence." },
  { startSeconds: 20, endSeconds: 30, href: "Text/two.xhtml", text: "Last sentence." },
], recoveryGaps: [{ startSeconds: 5, endSeconds: 10 }] };
async function fixture() {
  const bytes = new TextEncoder().encode(JSON.stringify(map));
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  const assets: NativeGiftAsset[] = [
    { name: "one.wav", kind: "audio", size: 10, sha256: "a".repeat(64) },
    { name: "two.wav", kind: "audio", size: 20, sha256: "b".repeat(64) },
    { name: "book.epub", kind: "ebook", size: 30, sha256: "c".repeat(64) },
    { name: "alignment.sync.json", kind: "alignment", size: bytes.length, sha256 },
  ];
  const metadata = parseGiftMetadata({ version: 1, title: "Gift", tracks: [
    { fileName: "one.wav", index: 0, title: "One", durationSeconds: 10, chapters: [] },
    { fileName: "two.wav", index: 1, title: "Two", durationSeconds: 20, chapters: [] },
  ], alignment: { assetName: "alignment.sync.json", ebookAssetName: "book.epub", audioAssetNames: ["one.wav", "two.wav"], timeline: "book", precision: "sentence" } }, assets);
  const { alignment: _alignment, ...base } = metadata;
  const book = buildGiftDeviceBook(id, assets.filter(asset => asset.kind !== "alignment"), base);
  const reads: string[] = [];
  const read = async (path: string, maximum: number) => { assert.equal(maximum, bytes.length); reads.push(path); return bytes; };
  return { assets, metadata, book, read, reads };
}

test("receipt-bound map survives shelf serialization and drives the real reader timeline without server access", async t => {
  const f = await fixture();
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("a standalone map must not contact a server"); });
  assert.equal(f.book.syncFile, null);
  const imported = await bindGiftLocalSyncMap(f.book, f.assets, f.metadata, f.read);
  const restarted = JSON.parse(JSON.stringify(imported));
  const loaded = await loadGiftLocalSyncMap(restarted, f.read);
  assert.ok(loaded);
  assert.equal(readAlongMode(restarted, loaded), "sentence");
  assert.equal(findActiveFragmentIndex(loaded.fragments, 2, 0, loaded.recoveryGaps), 0);
  assert.equal(findActiveFragmentIndex(loaded.fragments, 7, 0, loaded.recoveryGaps), -1);
  assert.equal(findActiveFragmentIndex(loaded.fragments, 12, 0, loaded.recoveryGaps), 1);
  assert.equal(findActiveFragmentIndex(loaded.fragments, 25, 0, loaded.recoveryGaps), 2);
  assert.equal(loaded.fragments[1].href, "Text/two.xhtml");
  assert.deepEqual(f.reads, [`device-library/gift-${id}/alignment.sync.json`, `device-library/gift-${id}/alignment.sync.json`]);
  assert.equal(fetch.mock.callCount(), 0);
});

test("changed map bytes or local EPUB/audio dependency order never produce a followable map", async () => {
  const f = await fixture();
  const book = await bindGiftLocalSyncMap(f.book, f.assets, f.metadata, f.read);
  await assert.rejects(loadGiftLocalSyncMap(book, async () => new Uint8Array(book.localSyncMap!.asset.size)), /changed/);
  for (const change of [
    (b: typeof book) => b.tracks.reverse(),
    (b: typeof book) => { b.tracks[0].durationSeconds = 11; },
    (b: typeof book) => { b.companions![0].localFilePath = "device-library/another.epub"; },
    (b: typeof book) => { b.localSyncMap!.asset.name = "../map.json"; },
  ]) { const changed = structuredClone(book); change(changed); await assert.rejects(loadGiftLocalSyncMap(changed, f.read)); }
  const missing = { ...f.metadata, tracks: f.metadata.tracks!.slice(0, 1) };
  await assert.rejects(bindGiftLocalSyncMap(f.book, f.assets, missing, f.read));
});

test("only real compatible sentence formats, bounded times/hrefs and valid UTF-16 words are followed", () => {
  for (const change of [
    (v: any) => { v.precision = "estimated"; }, (v: any) => { delete v.precision; },
    (v: any) => { v.version = 3; }, (v: any) => { v.fragments = []; },
    (v: any) => { v.fragments[0].startSeconds = -1; }, (v: any) => { v.fragments[2].endSeconds = 31; },
    (v: any) => { v.fragments.reverse(); }, (v: any) => { v.fragments[0].href = "https://outside.invalid/chapter"; },
    (v: any) => { v.fragments[0].href = "%2e%2e/private.xhtml"; },
    (v: any) => { v.fragments[0].words[0] = [0, 2, 0, 1000]; },
    (v: any) => { v.fragments[0].text = "🎁gift"; v.fragments[0].words = [[0, 1, 1, 1]]; },
  ]) { const value = structuredClone(map); change(value); assert.throws(() => parseGiftSyncMap(value, 30)); }
  assert.equal(parseGiftSyncMap({ version: 1, fragments: map.fragments }, 30).precision, "sentence", "legacy forced sentence maps stay usable");
  assert.equal(readAlongMode({ readingFile: { extension: "epub" } as any, syncFile: null }, null, false), "unsynced");
});

test("aligned import validates the map after native commit, and a failed read recovers without publishing or resetting history", async () => {
  const f = await fixture(), data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const metadataJson = JSON.stringify(f.metadata), bytes = new TextEncoder().encode(metadataJson);
  const assets: NativeGiftAsset[] = [...f.assets, { kind: "metadata", name: "metadata.json", size: bytes.length, sha256: Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex") }];
  const extract = async () => ({ directory: `device-library/gift-${id}`, metadataJson });
  storage.setItem("operalibre.deviceProgress.v1", "existing listening history");
  await assert.rejects(stageGiftImport(storage, id, assets, { title: "Gift" }, extract, async () => { throw new Error("map unavailable"); }), /unavailable/);
  assert.equal(storage.getItem("operalibre.deviceLibrary.v1"), null);
  assert.ok(storage.getItem("operalibre.giftExtractionJournal.v1"));
  assert.equal(await recoverGiftExtraction(storage, extract, f.read), "imported");
  const book = JSON.parse(storage.getItem("operalibre.deviceLibrary.v1")!)[0];
  assert.ok(book.localSyncMap); assert.equal((await loadGiftLocalSyncMap(book, f.read))!.fragments.length, 3);
  assert.equal(storage.getItem("operalibre.deviceProgress.v1"), "existing listening history");
});

test("actual Rust selected alignment ZIP imports and reloads into the local reader without a server/account", { skip: !process.env.OPERALIBRE_GIFT_ALIGNMENT_ARCHIVE_FIXTURE }, async () => {
  const fixture = JSON.parse(readFileSync(process.env.OPERALIBRE_GIFT_ALIGNMENT_ARCHIVE_FIXTURE!, "utf8"));
  const zip = await JSZip.loadAsync(Buffer.from(fixture.archiveBase64, "base64"));
  const assets = fixture.assets as NativeGiftAsset[], files = new Map<string, Uint8Array>(), data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const metadataAsset = assets.find(asset => asset.kind === "metadata")!;
  const metadataJson = await zip.file(metadataAsset.name)!.async("string");
  const metadata = JSON.parse(metadataJson);
  const extract = async () => {
    assert.equal(Object.values(zip.files).filter(file => !file.dir).length, assets.length);
    for (const asset of assets) {
      const bytes = await zip.file(asset.name)!.async("uint8array");
      assert.equal(bytes.length, asset.size);
      assert.equal(Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))).toString("hex"), asset.sha256);
      files.set(`device-library/gift-${id}/${asset.name}`, bytes);
    }
    return { directory: `device-library/gift-${id}`, metadataJson };
  };
  const read = async (path: string, maximum: number) => { const bytes = files.get(path); assert.ok(bytes); assert.ok(bytes.length <= maximum); return bytes; };
  assert.equal(await stageGiftImport(storage, id, assets, { title: metadata.title, author: metadata.author, description: metadata.description }, extract, read), "imported");
  const restarted = JSON.parse(storage.getItem("operalibre.deviceLibrary.v1")!)[0];
  const map = await loadGiftLocalSyncMap(restarted, read);
  assert.ok(map?.fragments.length);
  assert.equal(readAlongMode(restarted, map), "sentence");
  assert.equal(restarted.durationSeconds, metadata.tracks.reduce((sum: number, track: { durationSeconds: number }) => sum + track.durationSeconds, 0));
  const first = map.fragments[0];
  assert.equal(findActiveFragmentIndex(map.fragments, (first.startSeconds + first.endSeconds) / 2), 0);
  assert.deepEqual(restarted.tracks.map((track: { fileName: string }) => track.fileName), metadata.tracks.map((track: { fileName: string }) => track.fileName));
  assert.equal(restarted.source, "device"); assert.equal(restarted.progress, null);
});
