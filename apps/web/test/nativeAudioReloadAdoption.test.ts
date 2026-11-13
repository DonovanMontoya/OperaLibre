import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// Stands in for the Capacitor bridge after iOS discarded the WebView: AVPlayer
// is still playing the book when the reloaded page attaches.
type Listener = (event: Record<string, unknown>) => void;
const bridge = {
  calls: [] as string[],
  loads: [] as Array<{ positionSeconds: number }>,
  sleepTimers: [] as number[],
  adoptable: null as Record<string, unknown> | null,
  listeners: new Map<string, Listener[]>()
};
Reflect.set(globalThis, "__nativeAudioBridge", bridge);

const mocks: Record<string, string> = {
  "@capacitor/core": `
    const bridge = globalThis.__nativeAudioBridge;
    export const Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios" };
    export function registerPlugin() {
      return new Proxy({}, {
        get: (_target, method) => {
          if (method === "then") return undefined;
          if (method === "addListener") return async (name, listener) => {
            const list = bridge.listeners.get(name) ?? [];
            list.push(listener);
            bridge.listeners.set(name, list);
            return { remove: async () => bridge.listeners.set(name, (bridge.listeners.get(name) ?? []).filter((l) => l !== listener)) };
          };
          return async (options) => {
            bridge.calls.push(method);
            if (method === "load") bridge.loads.push(options);
            if (method === "setSleepTimer") bridge.sleepTimers.push(options.seconds);
            if (method === "getAdoptableSession") return bridge.adoptable ?? {};
            return undefined;
          };
        }
      });
    }`,
  "./carPlay": "export const carPlaybackOwnsEngine = () => false;"
};
register(`data:text/javascript,${encodeURIComponent(`
  const mocks = ${JSON.stringify(mocks)};
  export function resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/src/nativeAudio.ts") && specifier in mocks) {
      return { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true };
    }
    if (context.parentURL?.includes("/src/") && specifier.startsWith("./") && !specifier.slice(2).includes(".")) {
      return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const { attachNativeAudioPlayer } = await import("../src/nativeAudio.ts");

class ControlElement extends EventTarget {
  currentTime = 0;
  muted = false;
  volume = 1;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  pause() {}
}

function attach(audio: ControlElement, pending: number, adopted: (session: unknown) => void, trackId = "track-3") {
  return attachNativeAudioPlayer(
    audio as unknown as HTMLAudioElement,
    () => undefined,
    () => undefined,
    {
      source: `file:///book/${trackId}.m4b`,
      settings: () => ({ rate: 1, volume: 1 }),
      scopeKey: "reader:book",
      trackId,
      bookOffsetSeconds: 0,
      queue: () => [],
      pendingPosition: () => pending,
      wantsPlayback: () => false,
      gain: () => 1,
      sleepTimerSeconds: () => 0,
      sleepAtChapterEnd: () => false,
      adopted
    },
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined
  );
}

const emit = (name: string, event: Record<string, unknown>) => {
  for (const listener of bridge.listeners.get(name) ?? []) listener(event);
};

async function settle(done: () => boolean) {
  for (let tick = 0; tick < 50 && !done(); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(done(), "the attachment never settled");
}

test("a reloaded page takes over the playing book instead of loading it again", async () => {
  bridge.adoptable = { positionSeconds: 2412.5, sleepTimerSeconds: 900, sleepAtChapterEnd: false };
  const audio = new ControlElement();
  const events: string[] = [];
  for (const name of ["play", "pause", "loadedmetadata"]) {
    audio.addEventListener(name, () => events.push(name));
  }
  const adoptions: unknown[] = [];
  // The restored pending seek is the checkpoint from before the reload.
  const detach = attach(audio, 2405, (session) => adoptions.push(session));
  // A tick from the live player lands before the page has decided.
  emit("state", { trackId: "track-3", positionSeconds: 2411, durationSeconds: 3600, isPlaying: true, readyToPlay: true, positionReady: true });
  await settle(() => adoptions.length === 1);

  assert.deepEqual(adoptions[0], { positionSeconds: 2412.5, sleepTimerSeconds: 900, sleepAtChapterEnd: false });
  assert.equal(bridge.loads.length, 0, "load() would have torn the live player down");
  assert.deepEqual(bridge.sleepTimers, [], "the running sleep timer was disarmed");
  assert.deepEqual(events, [], "a tick from before the takeover reached React");

  emit("state", { trackId: "track-3", positionSeconds: 2413, durationSeconds: 3600, isPlaying: true, readyToPlay: true, positionReady: true });
  assert.equal(audio.currentTime, 2413);
  assert.deepEqual(events, ["play", "loadedmetadata"]);

  // A later track change reattaches normally: it loads, and resyncs the timer.
  detach();
  assert.ok(bridge.calls.includes("stop"), "the adopted player is this page's to stop");
  const next = attach(audio, 0, () => assert.fail("only the page's first attachment may take over"), "track-4");
  await settle(() => bridge.loads.length === 1);
  assert.deepEqual(bridge.sleepTimers, [0]);
  next();
});
