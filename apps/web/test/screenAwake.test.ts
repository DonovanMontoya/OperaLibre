import assert from "node:assert/strict";
import test from "node:test";

import { createScreenAwakeController } from "../src/screenAwake.ts";

function fixture() {
  let visibilityState: DocumentVisibilityState = "visible";
  let visibilityListener: (() => void) | null = null;
  let requests = 0;
  let releases = 0;
  const documentRef = {
    get visibilityState() { return visibilityState; },
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      visibilityListener = listener as () => void;
    },
    removeEventListener() { visibilityListener = null; }
  };
  const wakeLock = {
    async request(type: "screen") {
      assert.equal(type, "screen");
      requests += 1;
      return {
        async release() { releases += 1; },
        addEventListener() {}
      };
    }
  };
  return {
    documentRef,
    wakeLock,
    counts: () => ({ requests, releases }),
    setVisibility(value: DocumentVisibilityState) {
      visibilityState = value;
      visibilityListener?.();
    }
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("holds a screen wake lock only while the ebook reader is open", async () => {
  const state = fixture();
  const controller = createScreenAwakeController(state.documentRef, state.wakeLock);

  controller.setReadingActive(true);
  await settle();
  assert.deepEqual(state.counts(), { requests: 1, releases: 0 });

  controller.setReadingActive(false);
  await settle();
  assert.deepEqual(state.counts(), { requests: 1, releases: 1 });
  controller.dispose();
});

test("waits for a hidden reader to become visible before acquiring", async () => {
  const state = fixture();
  state.setVisibility("hidden");
  const controller = createScreenAwakeController(state.documentRef, state.wakeLock);

  controller.setReadingActive(true);
  await settle();
  assert.equal(state.counts().requests, 0);

  state.setVisibility("visible");
  await settle();
  assert.equal(state.counts().requests, 1);
  controller.dispose();
});

test("releases in the background and reacquires when reading resumes", async () => {
  const state = fixture();
  const controller = createScreenAwakeController(state.documentRef, state.wakeLock);

  controller.setReadingActive(true);
  await settle();
  state.setVisibility("hidden");
  await settle();
  assert.deepEqual(state.counts(), { requests: 1, releases: 1 });

  state.setVisibility("visible");
  await settle();
  assert.deepEqual(state.counts(), { requests: 2, releases: 1 });
  controller.dispose();
});
