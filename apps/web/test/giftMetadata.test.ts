import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildGiftDeviceBook, recoverGiftExtraction, stageGiftImport, type NativeGiftAsset } from "../src/giftDeviceImport.ts";
import { MAX_GIFT_METADATA_BYTES, parseGiftMetadata, parseGiftPreviewMetadata } from "../src/giftMetadata.ts";
import { readBoundedGiftResponse } from "../src/giftLocalAssets.ts";

const giftId = "gift____________", libraryKey = "operalibre.deviceLibrary.v1", journalKey = "operalibre.giftExtractionJournal.v1";
const hash = async (bytes: Uint8Array) => Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))).toString("hex");
function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
export function metadata() {
  return { version: 1, title: "The gift", author: "Author", narrator: "Narrator", description: "A description", genres: ["Fiction"], tags: [{ name: "Series", position: "2" }], publishedDate: "2024", asin: "ASIN", metadata: { album: "Album", subtitle: "Subtitle", publisher: "Publisher", publishedDate: "2024", description: "A description", language: "en", series: "Series", seriesPosition: "2", genres: ["Fiction"] }, tracks: [
    { fileName: "first.wav", index: 0, title: "Opening", durationSeconds: 10, chapters: [{ title: "Part one", startSeconds: 0, endSeconds: 10 }] },
    { fileName: "last.wav", index: 1, title: "Ending", durationSeconds: 20, chapters: [{ title: "Part two", startSeconds: 0, endSeconds: 12 }, { title: "Finale", startSeconds: 12, endSeconds: 20 }] },
  ] };
}
export async function fixture(value: unknown = metadata()) {
  const metadataJson = JSON.stringify(value);
  const bytes = new TextEncoder().encode(metadataJson);
  const assets: NativeGiftAsset[] = [
    { name: "last.wav", kind: "audio", size: 20, sha256: "b".repeat(64) },
    { name: "first.wav", kind: "audio", size: 10, sha256: "a".repeat(64) },
    { name: "book.epub", kind: "ebook", size: 30, sha256: "c".repeat(64) },
    { name: "metadata.json", kind: "metadata", size: bytes.length, sha256: await hash(bytes) },
  ];
  return { metadataJson, assets, preview: { title: "The gift", author: "Author", description: "A description" }, extract: async () => ({ directory: `device-library/gift-${giftId}`, metadataJson }) };
}

test("post-accept verified native metadata indexes all bibliographic fields and ordered track-local chapters", async () => {
  const f = await fixture(), shelf = storage();
  assert.equal(await stageGiftImport(shelf, giftId, f.assets, f.preview, f.extract), "imported");
  const book = JSON.parse(shelf.getItem(libraryKey)!)[0];
  assert.equal(book.title, "The gift"); assert.equal(book.narrator, "Narrator");
  assert.deepEqual(book.genres, ["Fiction"]); assert.deepEqual(book.tags, [{ name: "Series", position: "2" }]);
  assert.equal(book.publishedDate, "2024"); assert.equal(book.asin, "ASIN");
  assert.equal(book.metadata.publisher, "Publisher"); assert.equal(book.metadata.language, "en");
  assert.equal(book.metadata.seriesPosition, "2"); assert.deepEqual(book.metadata.rawFields, []);
  assert.deepEqual(book.tracks.map((track: any) => [track.fileName, track.index, track.durationSeconds]), [["first.wav", 0, 10], ["last.wav", 1, 20]]);
  assert.equal(book.durationSeconds, 30);
  assert.deepEqual(book.chapters.map((chapter: any) => [chapter.title, chapter.startSeconds, chapter.endSeconds]), [["Part one", 0, 10], ["Part two", 10, 22], ["Finale", 22, 30]]);
  assert.equal(book.tracks[1].chapters[1].startSeconds, 12, "track chapters retain their local time");
  assert.equal(book.syncFile, null); assert.equal(book.progress, null);
  assert.equal(shelf.getItem(journalKey), null);
});

test("metadata is not read before extraction commit; read/hash/parse failure retains recovery journal without publishing", async () => {
  const f = await fixture(), shelf = storage();
  let reads = 0;
  await assert.rejects(stageGiftImport(shelf, giftId, f.assets, f.preview, async () => { throw new Error("not committed"); }, async () => { reads++; return new Uint8Array(); }), /not committed/);
  assert.equal(reads, 0); assert.ok(shelf.getItem(journalKey)); assert.equal(shelf.getItem(libraryKey), null);
  await assert.rejects(recoverGiftExtraction(shelf, async () => ({ directory: `device-library/gift-${giftId}`, metadataJson: f.metadataJson.replace("Narrator", "Tampered") })), /changed/);
  assert.equal(shelf.getItem(libraryKey), null); assert.ok(shelf.getItem(journalKey));
  await assert.rejects(recoverGiftExtraction(shelf, async () => ({ directory: `device-library/gift-${giftId}` })), /unavailable/);
  assert.equal(shelf.getItem(libraryKey), null);
  assert.equal(await recoverGiftExtraction(shelf, f.extract), "imported");
});

test("valid receipt with conflicting preview metadata or private fields fails closed", async () => {
  for (const bad of [ { ...metadata(), title: "Another book" }, { ...metadata(), progress: { positionSeconds: 0 } }, { ...metadata(), metadata: { rawFields: [{ key: "path", value: "/private" }] } }, { ...metadata(), tracks: [{ ...metadata().tracks[0], fileName: "absent.wav" }] } ]) {
    const f = await fixture(bad), shelf = storage();
    await assert.rejects(stageGiftImport(shelf, giftId, f.assets, f.preview, f.extract));
    assert.equal(shelf.getItem(libraryKey), null); assert.ok(shelf.getItem(journalKey));
  }
});

test("legacy eight-field descriptors remain readable and duplicate imports preserve the shelf/history", async () => {
  const legacy = { title: "The gift", author: "Author", narrator: "Narrator", description: "A description", genres: ["Fiction"], tags: [], publishedDate: null, asin: null };
  const f = await fixture(legacy), shelf = storage();
  assert.equal(await stageGiftImport(shelf, giftId, f.assets, f.preview, f.extract), "imported");
  const original = shelf.getItem(libraryKey)!;
  shelf.setItem("operalibre.deviceProgress.v1", "saved history");
  assert.equal(await stageGiftImport(shelf, giftId, f.assets, f.preview, f.extract), "duplicate");
  assert.equal(shelf.getItem(libraryKey), original); assert.equal(shelf.getItem("operalibre.deviceProgress.v1"), "saved history");
  assert.equal(JSON.parse(original)[0].narrator, "Narrator");
  assert.equal(JSON.parse(original)[0].durationSeconds, null, "legacy durations are unknown, not fabricated");
});

test("a large description is indexed at book level, not multiplied across 254 selected audio tracks", async () => {
  const value = metadata(), description = "D".repeat(32000);
  value.description = description; value.metadata.description = description;
  value.tracks = Array.from({ length: 254 }, (_, index) => ({ fileName: `track-${index}.wav`, index, title: `Track ${index}`, durationSeconds: 1, chapters: [] }));
  const metadataJson = JSON.stringify(value), bytes = new TextEncoder().encode(metadataJson);
  assert.ok(bytes.length < MAX_GIFT_METADATA_BYTES);
  const assets: NativeGiftAsset[] = [
    ...value.tracks.map(track => ({ name: track.fileName, kind: "audio" as const, size: 1, sha256: "a".repeat(64) })),
    { name: "book.epub", kind: "ebook", size: 1, sha256: "b".repeat(64) },
    { name: "metadata.json", kind: "metadata", size: bytes.length, sha256: await hash(bytes) },
  ];
  const shelf = storage();
  assert.equal(await stageGiftImport(shelf, giftId, assets, { title: value.title, author: value.author, description }, async () => ({ directory: `device-library/gift-${giftId}`, metadataJson })), "imported");
  const serialized = shelf.getItem(libraryKey)!;
  assert.ok(serialized.length < 512 * 1024, `unexpected gift index expansion: ${serialized.length}`);
  const book = JSON.parse(serialized)[0];
  assert.equal(book.metadata.description, description); assert.equal(book.metadata.publisher, "Publisher");
  assert.ok(book.tracks.every((track: any) => track.metadata.description === null && track.metadata.publisher === null));
  assert.equal(serialized.split(description).length - 1, 2, "only Book.description and Book.metadata.description retain the text");
});

test("descriptor track identities, order, finite times, chapter bounds and budgets are strict", () => {
  for (const change of [
    (v: any) => { v.tracks[1].index = 0; }, (v: any) => { v.tracks[1].fileName = v.tracks[0].fileName; },
    (v: any) => { v.tracks[0].durationSeconds = Infinity; }, (v: any) => { v.tracks[0].chapters[0].endSeconds = 11; },
    (v: any) => { v.tracks[1].chapters.reverse(); }, (v: any) => { v.genres = Array(65).fill("Genre"); },
    (v: any) => { v.tracks[0].title = " "; }, (v: any) => { v.metadata.publisher = "bad\x01field"; },
    (v: any) => { v.tracks[0].streamUrl = "https://outside.invalid"; }, (v: any) => { v.version = 2; },
  ]) { const value = metadata(); change(value); assert.throws(() => parseGiftMetadata(value)); }
  assert.throws(() => parseGiftMetadata({ title: "x".repeat(MAX_GIFT_METADATA_BYTES + 1) }));
  assert.throws(() => parseGiftPreviewMetadata(metadata(), { title: "The gift" }), "full tracks never enter the small signed projection");
});

test("bounded native response reads cancel oversized streams even with misleading headers", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(10)); controller.enqueue(new Uint8Array(10)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedGiftResponse(new Response(stream, { headers: { "content-length": "1" } }), 15));
  assert.equal(cancelled, true);
  assert.deepEqual(await readBoundedGiftResponse(new Response(new Uint8Array([1, 2])), 2), new Uint8Array([1, 2]));
});

test("aborting a stalled bounded body read cancels the stream rather than leaving it pending", async () => {
  let started!: () => void, cancelled = false;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const stream = new ReadableStream<Uint8Array>({ pull() { started(); }, cancel() { cancelled = true; } });
  const controller = new AbortController();
  const pending = readBoundedGiftResponse(new Response(stream), 100, controller.signal);
  await reading;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(cancelled, true);
});

test("actual Rust selected metadata v1 is accepted and indexed without a second schema", { skip: !process.env.OPERALIBRE_GIFT_METADATA_FIXTURE }, () => {
  const value = JSON.parse(readFileSync(process.env.OPERALIBRE_GIFT_METADATA_FIXTURE!, "utf8"));
  const parsed = parseGiftMetadata(value);
  const assets: NativeGiftAsset[] = parsed.tracks!.map(track => ({ name: track.fileName, kind: "audio", size: 1, sha256: "a".repeat(64) }));
  const book = buildGiftDeviceBook(giftId, assets, parsed);
  assert.equal(book.metadata.publisher, "Publisher"); assert.equal(book.narrator, "Narrator");
  assert.equal(book.tracks[0].title, "Selected track"); assert.equal(book.durationSeconds, 10);
});
