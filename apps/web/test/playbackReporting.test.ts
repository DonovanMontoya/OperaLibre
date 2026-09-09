import assert from "node:assert/strict";
import test from "node:test";
import { createPlaybackReporter, playbackReportPosition } from "../src/playbackReporting.ts";

test("a delayed start finishes before stop and the next track starts", async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reporter = createPlaybackReporter(async (event, id, position) => {
    if (event === "start" && id === "first") await gate;
    events.push(`${event}:${id}:${position}`);
  });
  const first = reporter.start("first", 120);
  const stop = reporter.stop("first", 180);
  const next = reporter.start("second", 0);
  await Promise.resolve();
  assert.deepEqual(events, []);
  release();
  await Promise.all([first, stop, next]);
  assert.deepEqual(events, ["start:first:120", "stop:first:180", "start:second:0"]);
});

test("resume does not duplicate start, and teardown after an explicit stop cannot rewrite progress", async () => {
  const events: string[] = [];
  const reporter = createPlaybackReporter(async (event, id, position) => { events.push(`${event}:${id}:${position}`); });
  await reporter.stop("first", 0); // Loading a book without playing is not a session.
  await reporter.start("first", 100);
  await reporter.start("first", 110); // Pause/resume.
  await reporter.stop("first", 120); // Before deliberate completion/reset.
  await reporter.stop("first", 0); // Element teardown.
  await reporter.start("second", 20);
  await reporter.stop("first", 120); // Late old-element callback.
  assert.deepEqual(events, ["start:first:100", "stop:first:120", "start:second:20"]);
});

test("a failed report does not poison subsequent sessions", async () => {
  let fail = true;
  const events: string[] = [];
  const reporter = createPlaybackReporter(async (event, id) => {
    if (fail) { fail = false; throw new Error("offline"); }
    events.push(`${event}:${id}`);
  });
  await assert.rejects(reporter.start("first", 10), /offline/);
  await reporter.start("first", 20);
  await reporter.stop("first", 30);
  assert.deepEqual(events, ["start:first", "stop:first"]);
});

test("progress and reset writes share session ordering", async () => {
  const events: string[] = [];
  const reporter = createPlaybackReporter(async (event) => { events.push(event); });
  const start = reporter.start("first", 100);
  const progress = reporter.write(async () => { events.push("progress"); return 120; });
  const stop = reporter.stop("first", 120);
  const reset = reporter.write(async () => { events.push("reset"); });
  await Promise.all([start, progress, stop, reset]);
  assert.equal(await progress, 120);
  assert.deepEqual(events, ["start", "progress", "stop", "reset"]);
});


test("stop reporting preserves a queued seek instead of the stale media clock", () => {
  assert.equal(playbackReportPosition("track", { trackId: "track", positionSeconds: 750 }, 0), 750);
  assert.equal(playbackReportPosition("track", { trackId: "track", positionSeconds: 0 }, 750), 0);
  assert.equal(playbackReportPosition("old", { trackId: "next", positionSeconds: 0 }, 750), 750);
  assert.equal(playbackReportPosition("track", null, NaN), null);
});
