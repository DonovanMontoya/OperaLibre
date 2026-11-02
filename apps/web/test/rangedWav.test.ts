import assert from "node:assert/strict";
import test from "node:test";
import { rangedWav, wav } from "./performance/fixtures.ts";

const audio = wav(1);

test("a request without Range is the whole file", () => {
  const response = rangedWav(audio);
  assert.equal(response.status, 200);
  assert.equal(response.body.length, audio.length);
  assert.equal(response.headers["Accept-Ranges"], "bytes");
  assert.equal(response.headers["Content-Length"], String(audio.length));
  assert.equal(response.headers["Content-Range"], undefined);
});

test("an open range is a partial body", () => {
  const response = rangedWav(audio, "bytes=44-");
  assert.equal(response.status, 206);
  assert.equal(response.body.length, audio.length - 44);
  assert.equal(response.headers["Accept-Ranges"], "bytes");
  assert.equal(response.headers["Content-Length"], String(audio.length - 44));
  assert.equal(response.headers["Content-Range"], `bytes 44-${audio.length - 1}/${audio.length}`);
  assert.equal(response.body[0], audio[44]);
});

test("a range that starts past the file is rejected", () => {
  const response = rangedWav(audio, `bytes=${audio.length}-`);
  assert.equal(response.status, 416);
  assert.equal(response.body.length, 0);
  assert.equal(response.headers["Content-Length"], "0");
  assert.equal(response.headers["Content-Range"], `bytes */${audio.length}`);
});
