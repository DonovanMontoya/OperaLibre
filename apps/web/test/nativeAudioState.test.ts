import assert from "node:assert/strict";
import test from "node:test";

import {
  NativeForegroundSyncGate,
  NativeAudioStateSynchronizer,
  reflectNativeAudioState,
  refreshDeclinedTrackChange
} from "../src/nativeAudioState.ts";

test("a foreground server refresh waits for the deferred native clock", () => {
  const gate = new NativeForegroundSyncGate();

  gate.backgrounded();
  assert.equal(gate.shouldDeferServerAdoption(), true);
  gate.foregrounded();

  // The old server checkpoint must not be adopted in the gap between the
  // WebView becoming visible and AVPlayer delivering its foreground state.
  assert.equal(gate.shouldDeferServerAdoption(), true);
  assert.equal(gate.nativeStateReceived(), true);
  assert.equal(gate.shouldDeferServerAdoption(), false);
  assert.equal(gate.nativeStateReceived(), false);
});

test("a web seek alone cannot acknowledge the foreground native clock", () => {
  const gate = new NativeForegroundSyncGate();
  const audio = { currentTime: 120, seeking: false, dispatchEvent: () => true };
  const synchronizer = new NativeAudioStateSynchronizer(audio, () => gate.nativeStateReceived());
  gate.backgrounded();
  gate.foregrounded();

  synchronizer.afterSeek(false);
  assert.equal(gate.shouldDeferServerAdoption(), true);
  audio.seeking = true;
  synchronizer.receive({ positionSeconds: 90, isPlaying: false }, false);
  synchronizer.afterSeek(false);
  assert.equal(gate.shouldDeferServerAdoption(), true);
  audio.seeking = false;
  synchronizer.afterSeek(false);
  assert.equal(audio.currentTime, 90);
  assert.equal(gate.shouldDeferServerAdoption(), false);
});

test("a cleared buffered state cannot acknowledge the handoff", () => {
  let acknowledgements = 0;
  const audio = { currentTime: 120, seeking: true, dispatchEvent: () => true };
  const synchronizer = new NativeAudioStateSynchronizer(audio, () => { acknowledgements += 1; });
  synchronizer.receive({ positionSeconds: 90, isPlaying: false }, false);
  synchronizer.clear();
  audio.seeking = false;
  synchronizer.afterSeek(false);
  assert.equal(acknowledgements, 0);
});

test("native acknowledgement follows the corrected clock and pause persistence", () => {
  const events: string[] = [];
  const audio = {
    currentTime: 120,
    seeking: false,
    dispatchEvent(event: Event) {
      events.push(`${event.type}:${this.currentTime}`);
      return true;
    }
  };
  const synchronizer = new NativeAudioStateSynchronizer(audio, () => { events.push("acknowledged"); });
  synchronizer.receive({ positionSeconds: 90, isPlaying: false }, true);
  assert.deepEqual(events, ["pause:90", "timeupdate:90", "acknowledged"]);
});

test("hidden native ticks cannot release the next foreground wait", () => {
  const gate = new NativeForegroundSyncGate();
  const generation = gate.generation;
  gate.backgrounded();
  assert.notEqual(gate.generation, generation);
  assert.equal(gate.nativeStateReceived(), false);
  gate.foregrounded();
  assert.equal(gate.shouldDeferServerAdoption(), true);
});

test("a silent native player stops deferring once the wait expires", () => {
  let now = 1000;
  const gate = new NativeForegroundSyncGate(() => now, 5000);

  gate.backgrounded();
  gate.foregrounded();
  assert.equal(gate.msUntilDeadline(), 5000);

  // A paused or idle AVPlayer may never emit a foreground state, and an
  // aborted seek can swallow the release its "seeked" handler owed.
  now += 5000;
  assert.equal(gate.shouldDeferServerAdoption(), false);
  assert.equal(gate.msUntilDeadline(), 0);
  assert.equal(gate.nativeStateReceived(), false);
});

test("the grace period covers the resume, not the length of the background stay", () => {
  let now = 1000;
  const gate = new NativeForegroundSyncGate(() => now, 5000);

  gate.backgrounded();
  // Hours on the lock screen must not burn the window the WebView needs to
  // hear AVPlayer's foreground state.
  now += 60 * 60 * 1000;
  assert.equal(gate.shouldDeferServerAdoption(), true);

  gate.foregrounded();
  assert.equal(gate.shouldDeferServerAdoption(), true);
  assert.equal(gate.msUntilDeadline(), 5000);
  assert.equal(gate.nativeStateReceived(), true);
});

test("a second foreground without a new background stay does not rearm the wait", () => {
  let now = 1000;
  const gate = new NativeForegroundSyncGate(() => now, 5000);

  gate.backgrounded();
  gate.foregrounded();
  assert.equal(gate.nativeStateReceived(), true);

  gate.foregrounded();
  assert.equal(gate.shouldDeferServerAdoption(), false);
});

test("foreground pause persists the newer native clock", () => {
  const events: Array<{ type: string; position: number }> = [];
  const audio = {
    currentTime: 120,
    seeking: false,
    dispatchEvent(event: Event) {
      events.push({ type: event.type, position: this.currentTime });
      return true;
    }
  };

  const isPlaying = reflectNativeAudioState(
    audio,
    { positionSeconds: 480, isPlaying: false },
    true
  );

  assert.equal(isPlaying, false);
  assert.equal(audio.currentTime, 480);
  assert.deepEqual(events, [
    { type: "pause", position: 480 },
    { type: "timeupdate", position: 480 }
  ]);
});

test("foreground pause waits for an in-flight web seek", () => {
  const events: Array<{ type: string; position: number }> = [];
  const audio = {
    currentTime: 120,
    seeking: true,
    dispatchEvent(event: Event) {
      events.push({ type: event.type, position: this.currentTime });
      return true;
    }
  };
  const synchronizer = new NativeAudioStateSynchronizer(audio);

  let isPlaying = synchronizer.receive(
    { positionSeconds: 480, isPlaying: false },
    true
  );

  assert.equal(isPlaying, true);
  assert.equal(audio.currentTime, 120);
  assert.deepEqual(events, []);

  audio.seeking = false;
  isPlaying = synchronizer.afterSeek(isPlaying);

  assert.equal(isPlaying, false);
  assert.equal(audio.currentTime, 480);
  assert.deepEqual(events, [
    { type: "pause", position: 480 },
    { type: "timeupdate", position: 480 }
  ]);
});

test("only the newest native update survives a slow web seek", () => {
  const events: Array<{ type: string; position: number }> = [];
  const audio = {
    currentTime: 120,
    seeking: true,
    dispatchEvent(event: Event) {
      events.push({ type: event.type, position: this.currentTime });
      return true;
    }
  };
  const synchronizer = new NativeAudioStateSynchronizer(audio);

  synchronizer.receive({ positionSeconds: 470, isPlaying: true }, true);
  synchronizer.receive({ positionSeconds: 480, isPlaying: false }, true);
  audio.seeking = false;
  const isPlaying = synchronizer.afterSeek(true);

  assert.equal(isPlaying, false);
  assert.equal(audio.currentTime, 480);
  assert.deepEqual(events, [
    { type: "pause", position: 480 },
    { type: "timeupdate", position: 480 }
  ]);
});

test("harmless sub-second drift does not seek the control element", () => {
  const events: string[] = [];
  const audio = {
    currentTime: 480,
    seeking: false,
    dispatchEvent(event: Event) {
      events.push(event.type);
      return true;
    }
  };

  reflectNativeAudioState(audio, { positionSeconds: 480.5, isPlaying: true }, true);

  assert.equal(audio.currentTime, 480);
  assert.deepEqual(events, ["timeupdate"]);
});

test("a declined track change is re-offered with the tick's live clock", () => {
  const declined = {
    trackId: "track-2",
    positionSeconds: 4,
    bookPositionSeconds: 3604,
    isPlaying: false
  };

  const refreshed = refreshDeclinedTrackChange(declined, { positionSeconds: 94, isPlaying: true });

  assert.deepEqual(refreshed, {
    trackId: "track-2",
    positionSeconds: 94,
    bookPositionSeconds: 3694,
    isPlaying: true
  });
  // The stored offer is not mutated; it stays available for the next tick.
  assert.equal(declined.positionSeconds, 4);
  // A tick without a usable clock only refreshes the transport state.
  assert.deepEqual(
    refreshDeclinedTrackChange(declined, { positionSeconds: Number.NaN, isPlaying: true }),
    { ...declined, isPlaying: true }
  );
});
