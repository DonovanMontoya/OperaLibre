import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

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
            if (method === "getAdoptableSession") return {};
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

test("with nothing to take over, the first attachment loads the restored position", async () => {
  const audio = new ControlElement();
  const detach = attachNativeAudioPlayer(
    audio as unknown as HTMLAudioElement,
    () => undefined,
    () => undefined,
    {
      source: "file:///book/track-1.m4b",
      settings: () => ({ rate: 1, volume: 1 }),
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
  detach();
});
