import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSleepTimerMinutes,
  mergeCustomSleepTimer,
  normalizeSleepTimerMinutes,
  readCustomSleepTimers,
  SLEEP_TIMER_CUSTOM_LIMIT,
  SLEEP_TIMER_STORAGE_KEY,
  sleepTimerChoices,
  writeCustomSleepTimers
} from "../src/sleepTimer.ts";

function memoryStorage(initialValue: string | null = null) {
  const values = new Map<string, string>();
  if (initialValue !== null) values.set(SLEEP_TIMER_STORAGE_KEY, initialValue);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
}

test("custom durations are whole minutes inside the supported range", () => {
  assert.equal(normalizeSleepTimerMinutes("22"), 22);
  assert.equal(normalizeSleepTimerMinutes(" 90 "), 90);
  assert.equal(normalizeSleepTimerMinutes(12.6), 13);
  assert.equal(normalizeSleepTimerMinutes(1), 1);
  assert.equal(normalizeSleepTimerMinutes(600), 600);
});

test("unusable custom durations are rejected rather than clamped", () => {
  assert.equal(normalizeSleepTimerMinutes(""), null);
  assert.equal(normalizeSleepTimerMinutes("   "), null);
  assert.equal(normalizeSleepTimerMinutes("soon"), null);
  assert.equal(normalizeSleepTimerMinutes(0), null);
  assert.equal(normalizeSleepTimerMinutes(-15), null);
  assert.equal(normalizeSleepTimerMinutes(601), null);
  assert.equal(normalizeSleepTimerMinutes(Number.NaN), null);
  assert.equal(normalizeSleepTimerMinutes(null), null);
});

test("durations read as minutes and hours", () => {
  assert.equal(formatSleepTimerMinutes(1), "1 minute");
  assert.equal(formatSleepTimerMinutes(45), "45 minutes");
  assert.equal(formatSleepTimerMinutes(60), "1 hour");
  assert.equal(formatSleepTimerMinutes(90), "1 hour 30 min");
  assert.equal(formatSleepTimerMinutes(120), "2 hours");
});

test("remembered durations keep the newest first and drop the stalest", () => {
  let custom = mergeCustomSleepTimer([], 22);
  custom = mergeCustomSleepTimer(custom, 7);
  custom = mergeCustomSleepTimer(custom, 100);
  assert.deepEqual(custom, [100, 7, 22]);

  custom = mergeCustomSleepTimer(custom, 3);
  assert.equal(custom.length, SLEEP_TIMER_CUSTOM_LIMIT);
  assert.deepEqual(custom, [3, 100, 7]);
});

test("re-using a remembered duration promotes it instead of duplicating it", () => {
  const custom = mergeCustomSleepTimer(mergeCustomSleepTimer([22, 7], 7), 7);
  assert.deepEqual(custom, [7, 22]);
});

test("presets are never remembered as customs", () => {
  assert.deepEqual(mergeCustomSleepTimer([], 30), []);
  assert.deepEqual(sleepTimerChoices([30]), [5, 15, 30, 45, 60]);
});

test("the menu merges presets and customs in ascending order", () => {
  assert.deepEqual(sleepTimerChoices([100, 7, 22]), [5, 7, 15, 22, 30, 45, 60, 100]);
});

test("remembered durations survive a round trip", () => {
  const storage = memoryStorage();
  writeCustomSleepTimers(storage, [22, 7]);
  assert.deepEqual(readCustomSleepTimers(storage), [22, 7]);
});

test("corrupt stored durations fall back to the presets alone", () => {
  assert.deepEqual(readCustomSleepTimers(memoryStorage(null)), []);
  assert.deepEqual(readCustomSleepTimers(memoryStorage("not json")), []);
  assert.deepEqual(readCustomSleepTimers(memoryStorage('{"minutes":22}')), []);
  assert.deepEqual(readCustomSleepTimers(memoryStorage('[22,"nope",0,900,7]')), [22, 7]);
});
