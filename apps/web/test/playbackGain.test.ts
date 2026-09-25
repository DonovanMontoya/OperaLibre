import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackGainChain, streamCanBeBoosted, webAudioBoostSupported } from "../src/playbackGain.ts";

/**
 * `streamCanBeBoosted` decides whether the player may route an element through
 * Web Audio, and a wrong "yes" is not a cosmetic failure: tapping a stream the
 * page loaded opaquely outputs silence rather than sound, leaving a listener
 * with a book that looks like it is playing and cannot be heard.
 */
function onPage(href: string, options: { webAudio?: boolean; userAgent?: string } = {}) {
  const { origin } = new URL(href);
  (globalThis as unknown as { window: unknown }).window = {
    location: { href, origin },
    navigator: { userAgent: options.userAgent ?? "" },
    ...(options.webAudio === false ? {} : { AudioContext: class {} })
  };
}

test("a stream served by the same origin as the app can be boosted", () => {
  onPage("http://books.local:4000/app/");
  assert.equal(streamCanBeBoosted("http://books.local:4000/api/books/x/tracks/1/stream?token=t"), true);
  assert.equal(streamCanBeBoosted("/api/books/x/tracks/1/stream?token=t"), true);
});

test("WebKit never routes saved boosts, including offline and imported books", () => {
  const webkitAgents = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
  ];
  for (const userAgent of webkitAgents) {
    onPage("https://books.local/", { userAgent });
    let contextsCreated = 0;
    Object.assign(window, { AudioContext: class { constructor() { contextsCreated++; } } });
    assert.equal(webAudioBoostSupported(), false, userAgent);
    for (const stream of ["/track.m4b", "blob:https://books.local/book", "file:///book.m4b", "data:audio/wav;base64,AAAA"]) {
      assert.equal(streamCanBeBoosted(stream), false, stream);
    }
    const chain = new PlaybackGainChain();
    const element = fakeElement() as unknown as HTMLAudioElement;
    for (const gain of [10 ** (2 / 20), 1, 0.5]) {
      chain.setGain(gain);
      assert.equal(chain.attach(element), false);
      assert.equal(chain.isAttachedTo(element), false);
    }
    assert.equal(contextsCreated, 0, "do not tap the media element or create a context");
  }
});

test("Chromium and Firefox keep same-origin Web Audio boost", () => {
  for (const userAgent of [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
    "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) Gecko/20100101 Firefox/140.0"
  ]) {
    onPage("https://books.local/", { userAgent });
    assert.equal(webAudioBoostSupported(), true, userAgent);
    assert.equal(streamCanBeBoosted("/track.m4b"), true);
    assert.equal(streamCanBeBoosted("blob:https://books.local/book"), true);
    assert.equal(streamCanBeBoosted("https://other.local/track.m4b"), false);
  }
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
