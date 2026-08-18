import assert from "node:assert/strict";
import test from "node:test";
import { streamCanBeBoosted } from "../src/playbackGain.ts";

/**
 * `streamCanBeBoosted` decides whether the player may route an element through
 * Web Audio, and a wrong "yes" is not a cosmetic failure: tapping a stream the
 * page loaded opaquely outputs silence rather than sound, leaving a listener
 * with a book that looks like it is playing and cannot be heard.
 */
function onPage(href: string, options: { webAudio?: boolean } = {}) {
  const { origin } = new URL(href);
  (globalThis as unknown as { window: unknown }).window = {
    location: { href, origin },
    ...(options.webAudio === false ? {} : { AudioContext: class {} })
  };
}

test("a stream served by the same origin as the app can be boosted", () => {
  onPage("http://books.local:4000/app/");
  assert.equal(streamCanBeBoosted("http://books.local:4000/api/books/x/tracks/1/stream?token=t"), true);
  assert.equal(streamCanBeBoosted("/api/books/x/tracks/1/stream?token=t"), true);
});

test("a separately hosted frontend cannot tap the server's audio", () => {
  onPage("http://localhost:5173/");
  assert.equal(streamCanBeBoosted("http://localhost:4000/api/books/x/tracks/1/stream"), false);
  assert.equal(streamCanBeBoosted("https://books.example.com/stream.m4b"), false);
});

test("offline downloads and imported device files are always tappable", () => {
  onPage("https://localhost/");
  assert.equal(streamCanBeBoosted("blob:https://localhost/9f0c-abc"), true);
  assert.equal(streamCanBeBoosted("file:///var/mobile/Containers/book.m4b"), true);
});

test("a scheme or port that differs is still a different origin", () => {
  onPage("http://books.local:4000/");
  assert.equal(streamCanBeBoosted("https://books.local:4000/stream"), false);
  assert.equal(streamCanBeBoosted("http://books.local:4001/stream"), false);
});

test("nothing is boostable without a stream or without Web Audio", () => {
  onPage("http://books.local:4000/");
  assert.equal(streamCanBeBoosted(null), false);
  assert.equal(streamCanBeBoosted(undefined), false);
  assert.equal(streamCanBeBoosted(""), false);

  onPage("http://books.local:4000/", { webAudio: false });
  assert.equal(streamCanBeBoosted("http://books.local:4000/stream"), false);
});
