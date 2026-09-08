import assert from "node:assert/strict";
import { test } from "node:test";
import { createAlignmentStatusUpdater, readAlignmentPreference, writeAlignmentPreference } from "../src/alignmentPreference.ts";

(globalThis as unknown as { window: unknown }).window = undefined;

test("an offline cold start retains the server flag, including a later disable", (t) => {
  const stored = new Map<string, string>();
  t.mock.property(globalThis, "window", { localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); }
  } });
  assert.equal(readAlignmentPreference("server-a"), null);
  writeAlignmentPreference("server-a", { enabled: true, cliPath: "/private/aligner" });

  // A new reader session can load the downloaded map before any network reply.
  assert.deepEqual(readAlignmentPreference("server-a"), { enabled: true, cliPath: null });
  assert.equal(readAlignmentPreference("server-b"), null);
  assert.ok(!JSON.stringify([...stored.values()]).includes("/private/aligner"));

  writeAlignmentPreference("server-a", { enabled: false, cliPath: null });
  assert.deepEqual(readAlignmentPreference("server-a"), { enabled: false, cliPath: null });
  writeAlignmentPreference("server-b", { enabled: true, cliPath: null });
  assert.deepEqual(readAlignmentPreference("server-a"), { enabled: false, cliPath: null });
});

test("unreadable or invalid cached settings do not enable following", (t) => {
  t.mock.property(globalThis, "window", { localStorage: {
    getItem: () => "invalid",
    setItem: () => { throw new Error("storage blocked"); }
  } });
  assert.equal(readAlignmentPreference("server"), null);
  assert.doesNotThrow(() => writeAlignmentPreference("server", { enabled: true, cliPath: null }));
  t.mock.method(window.localStorage, "getItem", () => { throw new Error("storage blocked"); });
  assert.equal(readAlignmentPreference("server"), null);
});


function deferredStatus() {
  let resolve!: (status: { enabled: boolean; cliPath: null }) => void;
  const promise = new Promise<{ enabled: boolean; cliPath: null }>((done) => { resolve = done; });
  return { promise, resolve };
}

test("an older poll cannot undo an admin disable or persist stale offline availability", async (t) => {
  const stored = new Map<string, string>();
  t.mock.property(globalThis, "window", { localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); }
  } });
  const applied: boolean[] = [];
  const updater = createAlignmentStatusUpdater((status) => {
    applied.push(status.enabled);
    writeAlignmentPreference("server", status);
  });
  const old = deferredStatus();
  const pending = updater.refresh(() => old.promise);
  updater.update({ enabled: false, cliPath: null });
  old.resolve({ enabled: true, cliPath: null });
  await pending;
  assert.deepEqual(applied, [false]);
  assert.equal(readAlignmentPreference("server")?.enabled, false);
});

test("only the latest poll applies, and cleanup invalidates pending reads", async () => {
  const applied: boolean[] = [];
  const updater = createAlignmentStatusUpdater((status) => applied.push(status.enabled));
  const old = deferredStatus();
  const pending = updater.refresh(() => old.promise);
  await updater.refresh(async () => ({ enabled: false, cliPath: null }));
  old.resolve({ enabled: true, cliPath: null });
  await pending;
  assert.deepEqual(applied, [false]);

  const closing = deferredStatus();
  const closingPending = updater.refresh(() => closing.promise);
  updater.invalidate();
  closing.resolve({ enabled: true, cliPath: null });
  await closingPending;
  assert.deepEqual(applied, [false]);
});

test("rejected status requests preserve the confirmed setting instead of enabling following", async () => {
  const applied: boolean[] = [];
  const updater = createAlignmentStatusUpdater((status) => applied.push(status.enabled));
  updater.update({ enabled: false, cliPath: null });
  await updater.refresh(async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); });
  await updater.refresh(async () => { throw new TypeError("Failed to fetch"); });
  assert.deepEqual(applied, [false]);
});
