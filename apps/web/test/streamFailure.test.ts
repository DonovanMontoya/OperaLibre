import assert from "node:assert/strict";
import test from "node:test";
import {
  STREAM_FORMAT_UNSUPPORTED,
  STREAM_LOAD_FAILED,
  streamFailureMessage
} from "../src/streamFailure.ts";

const URL = "http://books.local/api/books/b/tracks/t/stream?token=m";

function answering(status: number): typeof fetch {
  return async () => new Response(status === 206 ? "a" : null, { status });
}

test("a stream the server does send is a format the device cannot play", async () => {
  assert.equal(await streamFailureMessage(URL, answering(206)), STREAM_FORMAT_UNSUPPORTED);
  assert.equal(await streamFailureMessage(URL, answering(200)), STREAM_FORMAT_UNSUPPORTED);
});

test("a refused or missing stream is not reported as an unsupported format", async () => {
  for (const status of [401, 403, 404, 500]) {
    const message = await streamFailureMessage(URL, answering(status));
    assert.notEqual(message, STREAM_FORMAT_UNSUPPORTED, `status ${status}`);
    assert.notEqual(message, STREAM_LOAD_FAILED, `status ${status}`);
  }
  assert.match(await streamFailureMessage(URL, answering(401)), /sign in again/);
  assert.match(await streamFailureMessage(URL, answering(404)), /no longer has this audio file/);
  assert.match(await streamFailureMessage(URL, answering(500)), /error 500/);
});

test("a probe that cannot reach the server stays generic", async () => {
  const unreachable: typeof fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  assert.equal(await streamFailureMessage(URL, unreachable), STREAM_LOAD_FAILED);
});

test("the probe asks for one byte with the media request's credentials, bypassing the cache", async () => {
  let seen: RequestInit | undefined;
  const recording: typeof fetch = async (_input, init) => {
    seen = init;
    return new Response("a", { status: 206 });
  };
  await streamFailureMessage(URL, recording);
  assert.deepEqual(seen?.headers, { Range: "bytes=0-0" });
  assert.equal(seen?.credentials, "include");
  assert.equal(seen?.cache, "no-store");
});
