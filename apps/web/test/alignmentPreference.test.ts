import assert from "node:assert/strict";
import { test } from "node:test";
import { readAlignmentPreference, writeAlignmentPreference } from "../src/alignmentPreference.ts";

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
