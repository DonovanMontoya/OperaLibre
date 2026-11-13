import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { forgetInterruptedClipPreview, interruptedClipPreviewStart } from "../src/clips.ts";

// The reloaded page finds nothing it can take over (paused, another track or
// file, or a fresh launch): it loads at its restored position as before.
type Listener = (event: Record<string, unknown>) => void;
const bridge = {
  calls: [] as string[],
  loads: [] as Array<{ positionSeconds: number }>,
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
            return { remove: async () => undefined };
          };
          return async (options) => {
            bridge.calls.push(method);
            if (method === "load") bridge.loads.push(options);
            if (method === "getAdoptableSession") return { positionSeconds: 500 };
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

test("an interrupted preview cannot be adopted and stays excluded until the restored native position is ready", async () => {
  const values = new Map([["operalibre.clipPreview:server:reader:book", "1"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  let previewing = false;
  let established = 0;
  const audio = new ControlElement();
  const detach = attachNativeAudioPlayer(
    audio as unknown as HTMLAudioElement,
    () => undefined,
    () => undefined,
    {
      source: "file:///book/track-1.m4b",
      settings: () => ({ rate: 1, volume: 1 }),
      allowAdoption: false,
      clipPreview: () => previewing,
      normalPositionReady: () => {
        established += 1;
        if (!previewing) forgetInterruptedClipPreview(storage, "server", "reader", "book", 1);
      },
      scopeKey: "reader:book",
      trackId: "track-1",
      bookOffsetSeconds: 0,
      queue: () => [],
      pendingPosition: () => 731,
      wantsPlayback: () => false,
      gain: () => 1,
      sleepTimerSeconds: () => 0,
      sleepAtChapterEnd: () => false,
      adopted: () => assert.fail("nothing was playing")
    },
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined
  );
  for (let tick = 0; tick < 50 && bridge.loads.length === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(bridge.loads[0]?.positionSeconds, 731);
  // A stale timer from the discarded page is still cleared before the load.
  assert.ok(bridge.calls.indexOf("setSleepTimer") < bridge.calls.indexOf("load"));
  assert.ok(!bridge.calls.includes("getAdoptableSession"), "a playing preview must not be offered for adoption");
  const emit = (event: Record<string, unknown>) => {
    for (const listener of bridge.listeners.get("state") ?? []) listener(event);
  };
  emit({ trackId: "track-1", positionSeconds: 500, durationSeconds: 7200,
    readyToPlay: true, positionReady: true, clipPreview: true });
  assert.equal(audio.currentTime, 731);
  assert.equal(established, 0);
  assert.equal(interruptedClipPreviewStart(storage, "server", "reader", "book"), 1);
  emit({ trackId: "track-1", positionSeconds: 731, durationSeconds: 7200,
    readyToPlay: false, positionReady: false, clipPreview: false });
  assert.equal(established, 0);
  emit({ trackId: "track-1", positionSeconds: 731, durationSeconds: 7200,
    readyToPlay: true, positionReady: true, clipPreview: false });
  assert.equal(established, 1);
  assert.equal(interruptedClipPreviewStart(storage, "server", "reader", "book"), null);
  // A later native tick cannot remove a newer preview's durable marker.
  storage.setItem("operalibre.clipPreview:server:reader:book", "2");
  previewing = true;
  emit({ trackId: "track-1", positionSeconds: 731, durationSeconds: 7200,
    readyToPlay: true, positionReady: true, clipPreview: false });
  assert.equal(interruptedClipPreviewStart(storage, "server", "reader", "book"), 2);
  detach();
});
