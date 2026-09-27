import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// Stands in for the Capacitor bridge: every NativeAudio.load is recorded and
// listeners are kept so the test can emit AVPlayer state like the plugin does.
type Listener = (event: Record<string, unknown>) => void;
const bridge = {
  loads: [] as Array<{ positionSeconds: number; recoveryTrackId: string }>,
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
          if (method === "load") return async (options) => { bridge.loads.push(options); };
          if (method === "getSleepTimer") return async () => ({ remainingSeconds: 0 });
          return async () => undefined;
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
    // The real clock and startup helpers load too; source imports omit ".ts".
    if (context.parentURL?.includes("/src/") && specifier.startsWith("./") && !specifier.slice(2).includes(".")) {
      return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const { attachNativeAudioPlayer, forgetDetachedNativeClock } = await import("../src/nativeAudio.ts");

/** The iOS control element: it never gets a source, so on its own it reads 0:00. */
class ControlElement extends EventTarget {
  currentTime = 0;
  muted = false;
  volume = 1;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  pause() {}
}

function attach(audio: ControlElement, trackId: string, pending?: number) {
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
      sleepTimerSeconds: () => 0
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

async function loaded() {
  const count = bridge.loads.length;
  for (let tick = 0; tick < 20 && bridge.loads.length === count; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(bridge.loads.length, count + 1, "attachment never loaded AVPlayer");
  return bridge.loads.at(-1)!;
}

test("a queue rebuild after restore reloads AVPlayer where the listener was", async () => {
  const audio = new ControlElement();
  // Restore: the pending seek seeds the first load, then loadedmetadata
  // consumes it, so the next attachment sees no pending seek.
  let detach = attach(audio, "track-1", 1209.75);
  assert.equal((await loaded()).positionSeconds, 1209.75);
  emit("state", { trackId: "track-1", positionSeconds: 1209.75, durationSeconds: 1800, isPlaying: false, readyToPlay: true, positionReady: true });
  // The listener skips ahead before the download scan lands.
  emit("intentionalSeek", { positionSeconds: 1239.75 });
  detach();

  detach = attach(audio, "track-1");
  const reload = await loaded();
  assert.equal(reload.positionSeconds, 1239.75);
  assert.equal(audio.currentTime, 1239.75, "the control clock showed 0:00");
  detach();
});

test("the carried clock yields to a pending seek, another track, and CarPlay", async () => {
  const audio = new ControlElement();
  let detach = attach(audio, "track-1", 600);
  await loaded();
  detach();
  detach = attach(audio, "track-1", 45);
  assert.equal((await loaded()).positionSeconds, 45, "a queued seek must win");
  detach();

  detach = attach(audio, "track-2");
  assert.equal((await loaded()).positionSeconds, 0, "another track inherited this clock");
  detach();

  detach = attach(audio, "track-2", 300);
  await loaded();
  detach();
  forgetDetachedNativeClock(audio as unknown as HTMLAudioElement);
  detach = attach(audio, "track-2");
  assert.equal((await loaded()).positionSeconds, 0, "the car's checkpoint owns the resume");
  detach();
});
