import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { parseGiftCoverPreview, giftCoverPreviewDataUrl } from "../src/giftCoverPreview.ts";

// Generated from a 17x23 RGB raster by the Rust helper's image JPEG encoder.
const jpeg = {
  mimeType: "image/jpeg", width: 17, height: 23,
  dataBase64: "/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAAXABEDAREAAhEBAxEB/9sAQwAJBgcIBwYJCAcICgoJCw0WDw0MDA0bFBUQFiAdIiIgHR8fJCg0LCQmMScfHy09LTE1Nzo6OiMrP0Q/OEM0OTo3/9sAQwEKCgoNDA0aDw8aNyUfJTc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDzix07p8tenVrlYHEbHQWOndPlrz6tc+wwOI2NL+zv9muX257f1gjsdO6fLVVa5+L4HEbHQWOndPlrz6tc+wwOI2NL+zv9mub257f1gisbAccCqq1j8XwOI2OgsdPHHArz6tY+wwOI2NL+zx6Cub2x7f1g/9k=",
};

function chunk(kind: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(kind), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

function pngBytes(width = 17, height = 23): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * (1 + width * 3) + 1 + x * 3;
    pixels[index] = x % 8; pixels[index + 1] = y % 8; pixels[index + 2] = 90;
  }
  const compressed = deflateSync(pixels);
  assert.deepEqual(inflateSync(compressed), pixels, "fixture contains real compressed pixels");
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
}
function png(bytes = pngBytes(), width = 17, height = 23) {
  return { mimeType: "image/png", dataBase64: bytes.toString("base64"), width, height };
}
function changedJpeg(change: (bytes: Buffer) => Buffer) {
  return { ...jpeg, dataBase64: change(Buffer.from(jpeg.dataBase64, "base64")).toString("base64") };
}

test("accepts genuine PNG/JPEG raster bytes without paths or extensions", () => {
  for (const cover of [png(), jpeg, png(pngBytes(256, 256), 256, 256)]) {
    assert.deepEqual(parseGiftCoverPreview(cover), cover);
    assert.equal(giftCoverPreviewDataUrl(cover), `data:${cover.mimeType};base64,${cover.dataBase64}`);
    assert.ok(JSON.stringify(cover).length < 48 * 1024);
  }
  assert.equal(parseGiftCoverPreview(undefined), null);
  assert.equal(giftCoverPreviewDataUrl(null), null);
});

test("rejects URLs, SVG, MIME confusion, unknown fields and noncanonical base64", () => {
  for (const input of [
    "https://outside.invalid/cover.png", "data:image/png;base64,AA==", [], {},
    { ...jpeg, uri: "https://outside.invalid/cover.jpg" },
    { ...jpeg, mimeType: "image/svg+xml" }, { ...jpeg, mimeType: "image/png" },
    { ...jpeg, dataBase64: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64") },
    { ...jpeg, dataBase64: ` ${jpeg.dataBase64}` },
    { ...jpeg, dataBase64: jpeg.dataBase64.slice(0, -1) },
    { ...jpeg, dataBase64: jpeg.dataBase64.replaceAll("/", "_") },
    { ...jpeg, dataBase64: `data:image/jpeg;base64,${jpeg.dataBase64}` },
  ]) assert.throws(() => parseGiftCoverPreview(input), /Invalid gift cover preview/);
});

test("bounds bytes, declared dimensions and header dimensions before rendering", () => {
  for (const input of [
    { ...jpeg, dataBase64: "A".repeat(48 * 1024) },
    { ...jpeg, dataBase64: Buffer.alloc(32 * 1024 + 1).toString("base64") },
    { ...jpeg, width: 0 }, { ...jpeg, height: 257 }, { ...jpeg, width: 17.5 },
    { ...jpeg, width: "17" }, { ...jpeg, height: Infinity }, { ...jpeg, width: 18 },
    png(pngBytes(257, 1), 256, 1),
    changedJpeg(bytes => { const sof = bytes.indexOf(Buffer.from([0xff, 0xc0])); bytes.writeUInt16BE(65535, sof + 5); return bytes; }),
  ]) assert.throws(() => parseGiftCoverPreview(input));
});

test("PNG rejects corrupt CRCs, truncation, animation, metadata and trailing bytes", () => {
  const valid = pngBytes();
  const corrupted = Buffer.from(valid); corrupted[29] ^= 1;
  for (const bytes of [
    valid.subarray(0, 25), valid.subarray(0, -1), corrupted,
    Buffer.concat([valid, Buffer.from("<svg/>")]),
    Buffer.concat([valid.subarray(0, 33), chunk("acTL", Buffer.alloc(8)), valid.subarray(33)]),
    Buffer.concat([valid.subarray(0, 33), chunk("tEXt", Buffer.from("url\0https://outside.invalid")), valid.subarray(33)]),
    Buffer.concat([valid.subarray(0, 33), valid.subarray(8, 33), valid.subarray(33)]),
  ]) assert.throws(() => parseGiftCoverPreview(png(bytes)));
});

test("JPEG rejects truncation, missing scan/tables, metadata, and trailing polyglots", () => {
  for (const change of [
    (bytes: Buffer) => bytes.subarray(0, -1),
    (bytes: Buffer) => Buffer.concat([bytes, Buffer.from("<svg/>")]),
    (bytes: Buffer) => { bytes[3] = 0xe1; return bytes; },
    (bytes: Buffer) => bytes.subarray(0, bytes.indexOf(Buffer.from([0xff, 0xda]))),
    (bytes: Buffer) => { const sof = bytes.indexOf(Buffer.from([0xff, 0xc0])); bytes[sof + 4] = 12; return bytes; },
    (bytes: Buffer) => { const table = bytes.indexOf(Buffer.from([0xff, 0xdb])); bytes[table + 2] = 0xff; return bytes; },
  ]) assert.throws(() => parseGiftCoverPreview(changedJpeg(change)));
});

test("thumbnail rendering never fetches a URI", t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected fetch"); });
  giftCoverPreviewDataUrl(jpeg);
  assert.throws(() => giftCoverPreviewDataUrl({ ...jpeg, url: "https://outside.invalid" }));
  assert.equal(fetch.mock.callCount(), 0);
});

test("accepts this run's actual Rust thumbnail fixture", { skip: !process.env.OPERALIBRE_COVER_PREVIEW_FIXTURE }, () => {
  const cover = JSON.parse(readFileSync(process.env.OPERALIBRE_COVER_PREVIEW_FIXTURE!, "utf8"));
  assert.deepEqual(parseGiftCoverPreview(cover), cover);
  assert.equal(cover.mimeType, "image/jpeg");
  assert.equal(cover.width, 17); assert.equal(cover.height, 23);
});
