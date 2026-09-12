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

/**
 * WebKit replays a routed element's last buffer while it sits paused, so the
 * chain parks its context on pause. Parking must never leave a playing book
 * silent: not after a quick pause-then-play, and not when the outgoing track's
 * element pauses after the next one is already routed.
 */
function fakeWebAudio() {
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1, setTargetAtTime() {} } });
  const param = () => ({ value: 0 });
  const contexts: FakeContext[] = [];
  class FakeContext {
    state: "running" | "suspended" = "running";
    currentTime = 0;
    destination = {};
    pendingSuspend: (() => void) | null = null;
    constructor() {
      contexts.push(this);
    }
    createMediaElementSource() { return node(); }
    createGain() { return node(); }
    createDynamicsCompressor() {
      return { ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() };
    }
    suspend() {
      return new Promise<void>((resolve) => {
        this.pendingSuspend = () => {
          this.state = "suspended";
          resolve();
        };
      });
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
  }
  (globalThis as unknown as { window: unknown }).window = {
    location: { href: "http://books.local/", origin: "http://books.local" },
    AudioContext: FakeContext
  };
  return contexts;
}

function fakeElement() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    paused: true,
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    emit(type: string) {
      if (type === "play") this.paused = false;
      if (type === "pause" || type === "ended") this.paused = true;
      for (const listener of listeners.get(type) ?? []) listener();
    }
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("pausing a routed element parks the context and playing wakes it", async () => {
  const contexts = fakeWebAudio();
  const { PlaybackGainChain } = await import("../src/playbackGain.ts");
  const chain = new PlaybackGainChain();
  const element = fakeElement();
  assert.equal(chain.attach(element as unknown as HTMLAudioElement), true);
  const context = contexts[0];

  element.emit("play");
  element.emit("pause");
  context.pendingSuspend?.();
  await settle();
  assert.equal(context.state, "suspended");

  element.emit("play");
  assert.equal(context.state, "running");
});

test("a quick pause-then-play does not leave the book silent", async () => {
  const contexts = fakeWebAudio();
  const { PlaybackGainChain } = await import("../src/playbackGain.ts");
  const chain = new PlaybackGainChain();
  const element = fakeElement();
  chain.attach(element as unknown as HTMLAudioElement);
  const context = contexts[0];

  element.emit("play");
  element.emit("pause");
  element.emit("play");
  context.pendingSuspend?.();
  await settle();
  assert.equal(context.state, "running");
});

test("the outgoing track's pause cannot park the next track's context", async () => {
  const contexts = fakeWebAudio();
  const { PlaybackGainChain } = await import("../src/playbackGain.ts");
  const chain = new PlaybackGainChain();
  const outgoing = fakeElement();
  const incoming = fakeElement();
  chain.attach(outgoing as unknown as HTMLAudioElement);
  outgoing.emit("play");
  chain.attach(incoming as unknown as HTMLAudioElement);
  incoming.emit("play");

  outgoing.emit("pause");
  assert.equal(contexts[0].pendingSuspend, null);
  assert.equal(contexts[0].state, "running");
});

test("the next track starting while the ended track's suspend is in flight still plays", async () => {
  const contexts = fakeWebAudio();
  const { PlaybackGainChain } = await import("../src/playbackGain.ts");
  const chain = new PlaybackGainChain();
  const outgoing = fakeElement();
  const incoming = fakeElement();
  chain.attach(outgoing as unknown as HTMLAudioElement);
  outgoing.emit("play");
  outgoing.emit("ended");
  const context = contexts[0];

  chain.attach(incoming as unknown as HTMLAudioElement);
  incoming.emit("play");
  context.pendingSuspend?.();
  await settle();
  assert.equal(context.state, "running");
});
