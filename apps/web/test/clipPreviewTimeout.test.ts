import assert from "node:assert/strict";
import test from "node:test";
import { loadHook } from "./hookHarness.ts";
import * as clips from "../src/clips.ts";

test("a preview seek that times out is superseded by a return to the listener's place", () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const noop = () => {};
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); } };
    Object.assign(globalThis, { window: { localStorage: storage, addEventListener: noop,
      removeEventListener: noop, setTimeout, clearTimeout } });
    const slots: unknown[] = [];
    let cursor = 0;
    const effects: Array<() => unknown> = [];
    const react = {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
        return [slots[index], (next: unknown) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
      },
      useRef(current: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = { current };
        return slots[index];
      },
      useMemo(fn: () => unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = fn();
        return slots[index];
      },
      useEffect(effect: () => unknown) { effects.push(effect); }
    };
    const hook = loadHook("useClips", { react, "./clips": clips,
      "./api": { getServerStorageKey: () => "server", getStoredToken: () => "token",
        listClips: async () => ({ clips: [], canExportAudio: true }) },
      "./clipShare": {}, "./formatting": { errorMessage: String }, "./native": { haptic: noop } });
    const preview = clips.clipPreviewFlag(storage, () => ({ serverKey: "server", userId: "reader" }));
    const seeks: unknown[][] = [];
    let pauses = 0;
    const options = { clipPreviewBookIdRef: preview, audioRef: { current: null }, book: { id: "book" },
      bookDuration: 7200, bookPosition: 1000, enabled: true, nativeAudio: true, userId: "reader",
      pausePlayback: () => { pauses += 1; }, persistProgress: async () => {},
      seekBookPosition: (...args: unknown[]) => { seeks.push(args); } };
    hook(options).playClip({ id: "clip", bookId: "book", startSeconds: 500, endSeconds: 540 });
    assert.deepEqual(seeks, [[500, true, true]]);
    now += 16_000;
    cursor = 0;
    effects.length = 0;
    hook(options);
    for (const effect of effects) effect();
    assert.deepEqual(seeks, [[500, true, true], [1000, false, true, false]]);
    assert.equal(pauses, 1);
    // An optimistic render at the return target does not acknowledge native playback.
    cursor = 0;
    effects.length = 0;
    hook(options);
    for (const effect of effects) effect();
    assert.equal(preview.returningBookId, "book");
    assert.equal(preview.current, "book", "progress stays guarded while the return seek is pending");
    assert.notEqual(clips.interruptedClipPreviewStart(storage, "server", "reader", "book"), null);
  } finally {
    Date.now = originalNow;
  }
});
