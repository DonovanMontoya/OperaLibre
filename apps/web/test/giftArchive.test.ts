import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { importGiftArchive, inspectGiftArchive, type GiftImportStore, type GiftManifest } from "../src/giftArchive.ts";

async function fixture() {
  const ebook = new TextEncoder().encode("ebook contents");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ebook));
  const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  const zip = new JSZip();
  zip.file("book.epub", ebook);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
  const manifest: GiftManifest = { giftId: "gift____________", entries: [{ name: "book.epub", kind: "ebook", size: ebook.length, sha256 }] };
  return { bytes, manifest };
}

function fakeStore() {
  const books = new Map<string, Uint8Array>();
  const staging = new Map<string, Uint8Array>();
  let rollbacks = 0;
  const store: GiftImportStore = {
    async has(id) { return books.has(id); },
    async begin(id) { return id; },
    async write(_id, _entry, bytes) { staging.set("ebook", bytes.slice()); },
    async commit(id) { books.set(id, staging.get("ebook")!); staging.clear(); },
    async rollback() { rollbacks++; staging.clear(); }
  };
  return { store, books, get rollbacks() { return rollbacks; } };
}

test("offline import persists verified ebook and ignores duplicate replay", async () => {
  const { bytes, manifest } = await fixture();
  const local = fakeStore();
  assert.equal(await importGiftArchive(bytes, manifest, local.store), "imported");
  assert.equal(new TextDecoder().decode(local.books.get(manifest.giftId)), "ebook contents");
  assert.equal(await importGiftArchive(bytes, manifest, local.store), "duplicate");
  assert.equal(local.books.size, 1);
});

test("rejects traversal, unselected files and corrupted bytes before storage", async () => {
  const { bytes, manifest } = await fixture();
  const local = fakeStore();
  assert.throws(() => inspectGiftArchive(bytes, { ...manifest, entries: [{ ...manifest.entries[0], name: "../book.epub" }] }));
  assert.throws(() => inspectGiftArchive(bytes, { ...manifest, entries: [{ ...manifest.entries[0], name: "other.epub" }] }));
  const corrupt = bytes.slice();
  const dataOffset = 30 + "book.epub".length;
  corrupt[dataOffset] ^= 1;
  await assert.rejects(importGiftArchive(corrupt, manifest, local.store), /integrity/);
  assert.equal(local.books.size, 0);
});

test("rolls back staged data when commit fails", async () => {
  const { bytes, manifest } = await fixture();
  const local = fakeStore();
  local.store.commit = async () => { throw new Error("storage full"); };
  await assert.rejects(importGiftArchive(bytes, manifest, local.store), /storage full/);
  assert.equal(local.rollbacks, 1);
  assert.equal(local.books.size, 0);
});
