import assert from "node:assert/strict";
import test from "node:test";

import {
  NativeAudioStateSynchronizer,
  reflectNativeAudioState
} from "../src/nativeAudioState.ts";

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
