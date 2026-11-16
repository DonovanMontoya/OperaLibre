import assert from "node:assert/strict";
import test from "node:test";
import { loadHook } from "./hookHarness.ts";
import * as clips from "../src/clips.ts";

for (const stop of ["unmount", "effect restart", "account", "server", "none"] as const) {
  for (const followup of ["next clip", "trim", "delete"] as const) {
    test(`clip delivery preserves the original queue after ${stop} during a save before ${followup}`, async () => {
      const values = new Map<string, string>();
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); }
      };
      const makeClip = (id: string): clips.Clip => ({ id, bookId: "book", startSeconds: 10,
        endSeconds: 20, title: null, note: "private note", createdAt: "2026-11-13", updatedAt: "2026-11-13" });
      const key = clips.pendingClipStorageKey("server-a", "alice");
      clips.writePendingClips(storage, key, [makeClip("a"), makeClip("b")]);
      const originalQueue = storage.getItem(key);
      let server = "server-a", token = "alice-token";
      let release!: () => void;
      const response = new Promise<void>(resolve => { release = resolve; });
      const requests: string[] = [];
      let requestSignal: AbortSignal | undefined;
      const effects: Array<() => void | (() => void)> = [];
      const noop = () => {};
      Object.assign(globalThis, { window: { localStorage: storage, addEventListener: noop,
        removeEventListener: noop, setTimeout, clearTimeout } });
      const hook = loadHook("useClips", {
        react: { useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, noop],
          useMemo: (fn: () => unknown) => fn(), useRef: (current: unknown) => ({ current }),
          useEffect: (fn: () => void | (() => void)) => effects.push(fn) },
        "./api": {
          getServerStorageKey: () => server, getStoredToken: () => token,
          listClips: async () => ({ clips: [], canExportAudio: true }),
          saveClip: async (clip: clips.Clip, signal: AbortSignal) => {
            requestSignal = signal;
            requests.push(`save:${clip.id}`);
            await response;
            return followup === "trim" ? { ...clip, note: "earlier content" } : clip;
          },
          updateClip: async () => { requests.push("trim"); },
          deleteClip: async () => { requests.push("delete"); },
          isNetworkError: () => false, ApiError: class extends Error {}
        },
        "./clips": clips, "./clipShare": {}, "./formatting": { errorMessage: String },
        "./native": { haptic: noop }
      })({ clipPreviewBookIdRef: { current: null }, audioRef: { current: null }, book: { id: "book" },
        bookDuration: 7200, bookPosition: 1000, enabled: true, pausePlayback: noop,
        persistProgress: async () => {}, seekBookPosition: noop, userId: "alice" });
      const cleanups = effects.map(effect => effect()).filter((fn): fn is () => void => typeof fn === "function");
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(requests, ["save:a"]);
      if (followup === "delete") await hook.remove(makeClip("a"));
      const queuedBeforeSwitch = followup === "delete" ? storage.getItem(key) : originalQueue;
      if (stop === "unmount" || stop === "effect restart") {
        cleanups.forEach(cleanup => cleanup());
        assert.equal(requestSignal?.aborted, true);
        if (stop === "effect restart") effects[0]();
      }
      if (stop === "account") token = "bob-token";
      if (stop === "server") server = "server-b";
      release();
      await new Promise(resolve => setImmediate(resolve));
      if (stop === "none") {
        const followups = followup === "next clip" ? [] : [followup];
        assert.deepEqual(requests, ["save:a", ...followups, "save:b", ...(followup === "trim" ? ["trim"] : [])]);
        assert.equal(storage.getItem(key), null);
      } else {
        assert.deepEqual(requests, ["save:a"]);
        assert.equal(storage.getItem(key), queuedBeforeSwitch, "the original account retains undelivered clips");
      }
      cleanups.forEach(cleanup => cleanup());
    });
  }
}
