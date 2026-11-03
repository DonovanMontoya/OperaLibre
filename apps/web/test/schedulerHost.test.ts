import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { installTimerSchedulerHost } from "../src/schedulerHost.ts";

const require = createRequire(import.meta.url);

type Globals = Parameters<typeof installTimerSchedulerHost>[1];
const timers = (): Globals => ({ setTimeout, clearTimeout });

test("React still renders on iOS when a scheduler message is lost", { timeout: 5000 }, async () => {
  const globals = globalThis as unknown as Globals;
  const { setImmediate: nativeSetImmediate, clearImmediate: nativeClearImmediate } = globals;
  const nativeMessageChannel = globalThis.MessageChannel;
  delete globals.setImmediate;
  delete globals.clearImmediate;
  // A channel that never delivers. The real one would also hold the test
  // process open if this ever regressed, so it could not fail cleanly.
  globalThis.MessageChannel = class {
    port1 = {};
    port2 = { postMessage() {} };
  } as unknown as typeof MessageChannel;
  try {
    installTimerSchedulerHost("ios", globals);
    const scheduler = require("scheduler") as {
      unstable_NormalPriority: number;
      unstable_scheduleCallback(priority: number, callback: () => void): unknown;
    };
    await new Promise<void>((resolve) => {
      scheduler.unstable_scheduleCallback(scheduler.unstable_NormalPriority, resolve);
    });
  } finally {
    globalThis.MessageChannel = nativeMessageChannel;
    globals.setImmediate = nativeSetImmediate;
    globals.clearImmediate = nativeClearImmediate;
  }
});

test("other platforms keep the scheduler's own host", () => {
  for (const platform of ["android", "web"]) {
    const globals = timers();
    installTimerSchedulerHost(platform, globals);
    assert.equal(globals.setImmediate, undefined);
  }
});

test("an existing setImmediate is left alone", () => {
  const existing = () => {};
  const globals = { ...timers(), setImmediate: existing };
  installTimerSchedulerHost("ios", globals);
  assert.equal(globals.setImmediate, existing);
});

test("the host is installed before React loads", () => {
  const firstImport = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8").split("\n")[0];
  assert.equal(firstImport, 'import "./schedulerHost";');
});
