import assert from "node:assert/strict";
import test from "node:test";
import { NativeAudioControlClock } from "../src/nativeAudioClock.ts";
import { NativeAudioStateSynchronizer } from "../src/nativeAudioState.ts";

function element() {
  let webSeeks = 0;
  const events: Array<{name: string; position: number}> = [];
  const audio = Object.create({
    get currentTime() { return 0; },
    set currentTime(_value: number) { webSeeks++; },
    get duration() { return NaN; },
    get currentSrc() { return ""; },
    get seeking() { return false; },
    get readyState() { return 0; }
  }) as HTMLAudioElement;
  audio.dispatchEvent = (event: Event) => {
    events.push({name: event.type, position: audio.currentTime});
    return true;
  };
  return { audio, events, seeks: () => webSeeks };
}

test("native metadata and resume need no web metadata or browser seek", () => {
  const {audio, seeks, events} = element();
  const clock = new NativeAudioControlClock(audio, "https://server/audio", 3600);
  assert.equal(audio.readyState, 0);
  assert.equal(audio.currentTime, 3600);
  assert.equal(clock.updateMetadata(7200), true);
  assert.equal(audio.readyState, 1);
  assert.equal(audio.duration, 7200);
  assert.equal(audio.currentSrc, "https://server/audio");
  const sync = new NativeAudioStateSynchronizer(audio);
  sync.receive({positionSeconds: 3602, isPlaying: true}, false);
  assert.deepEqual(events[0], {name: "play", position: 3602});
  audio.currentTime = 3700;
  assert.equal(seeks(), 0);
  assert.equal(clock.updateMetadata(7200), false);
  clock.destroy();
});

test("fallback restores the real element instead of keeping stale native metadata", () => {
  const {audio, seeks} = element();
  const clock = new NativeAudioControlClock(audio, "https://server/audio", 600);
  clock.updateMetadata(7200);
  clock.destroy();
  clock.destroy();
  assert.equal(audio.readyState, 0);
  assert.equal(audio.currentSrc, "");
  assert.equal(Number.isNaN(audio.duration), true);
  audio.currentTime = 600;
  assert.equal(seeks(), 1);
});

test("late duration does not reset a resumed clock or announce readiness twice", () => {
  const { audio, seeks } = element();
  const clock = new NativeAudioControlClock(audio, "https://server/audio", 3600);
  assert.equal(clock.updateMetadata(0), true);
  assert.equal(audio.readyState, 1);
  assert.ok(Number.isNaN(audio.duration));
  audio.currentTime = 3602;
  assert.equal(clock.updateMetadata(7200), false);
  assert.equal(audio.duration, 7200);
  assert.equal(audio.currentTime, 3602);
  assert.equal(seeks(), 0);
  clock.destroy();
});

test("a failure-time position replaces the suspended clock without announcing readiness", () => {
  const { audio, events, seeks } = element();
  const clock = new NativeAudioControlClock(audio, "https://server/audio", 600);
  clock.synchronizePosition(7800, true);
  assert.equal(audio.currentTime, 7800);
  assert.equal(audio.readyState, 0);
  assert.deepEqual(events, [{ name: "timeupdate", position: 7800 }]);
  assert.equal(seeks(), 0);
  clock.destroy();
});

test("unfinished seeks and invalid failure positions preserve the pending resume", () => {
  const { audio, events } = element();
  const clock = new NativeAudioControlClock(audio, "https://server/audio", 600);
  clock.synchronizePosition(0, false);
  clock.synchronizePosition(NaN, true);
  clock.synchronizePosition(-1, true);
  assert.equal(audio.currentTime, 600);
  assert.deepEqual(events, []);
  clock.destroy();
});

test("successive attachments discard the old clock and keep the new pending seek", () => {
  const {audio} = element();
  const old = new NativeAudioControlClock(audio, "https://server/first", 600);
  old.updateMetadata(7200);
  old.destroy();
  const next = new NativeAudioControlClock(audio, "https://server/next", 1200);
  assert.equal(audio.currentSrc, "https://server/next");
  assert.equal(audio.currentTime, 1200);
  assert.equal(audio.readyState, 0);
  next.destroy();
});
