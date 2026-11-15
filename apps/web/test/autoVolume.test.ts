import assert from "node:assert/strict";
import test from "node:test";
import {
  audioIssues,
  autoVolumeStatus,
  createKeyedQueue,
  describeAutoVolume,
  resolveBookGain,
  withAutoVolume
} from "../src/autoVolume.ts";
import { mergeServerBookGains } from "../src/bookVolume.ts";
import type { AudioAnalysis, Book } from "../src/types.ts";

const QUIET: AudioAnalysis = {
  integratedLufs: -30,
  truePeakDbtp: -20,
  flags: ["quiet"],
  suggestedGain: 10 ** (12 / 20)
};

function book(fields: Partial<Book>): Book {
  return { id: "book-1", audioAnalysis: QUIET, ...fields } as Book;
}

test("the listener's own level overrides the suggested gain", () => {
  const suggestedGain = QUIET.suggestedGain;
  assert.deepEqual(resolveBookGain({ manualGain: 1, autoVolume: true, suggestedGain }), {
    volumeGain: 1,
    volumeGainSource: "manual",
    autoVolume: true
  });
  assert.equal(resolveBookGain({ manualGain: 2, autoVolume: false, suggestedGain }).volumeGain, 2);
  assert.deepEqual(resolveBookGain({ manualGain: null, autoVolume: true, suggestedGain }), {
    volumeGain: suggestedGain,
    volumeGainSource: "auto",
    autoVolume: true
  });

  const overridden = book({ volumeGain: 1, volumeGainSource: "manual", autoVolume: true });
  assert.equal(autoVolumeStatus(overridden).kind, "overridden");
  assert.match(describeAutoVolume(autoVolumeStatus(overridden)) ?? "", /Your own level/);
});

/**
 * A slider move the server has not echoed yet must not be undone by a library
 * payload that still carries the suggested gain.
 */
test("a library payload carrying the suggested gain does not undo a manual level in flight", () => {
  const pending = new Map([["book-1", 1.5]]);
  const merged = mergeServerBookGains(
    { "book-1": 1.5 },
    [{ id: "book-1", volumeGain: QUIET.suggestedGain }],
    pending
  );
  assert.equal(merged, null);
  assert.equal(pending.get("book-1"), 1.5);
});

test("the off switch plays the file's own level and turning it on restores the suggestion", () => {
  const adjusted = book({
    volumeGain: QUIET.suggestedGain,
    volumeGainSource: "auto",
    autoVolume: true
  });
  assert.equal(autoVolumeStatus(adjusted).kind, "adjusted");
  assert.match(describeAutoVolume(autoVolumeStatus(adjusted)) ?? "", /\+12 dB/);

  const off = withAutoVolume(adjusted, false);
  assert.deepEqual(off, { volumeGain: 1, volumeGainSource: "default", autoVolume: false });
  assert.equal(autoVolumeStatus({ ...adjusted, ...off }).kind, "off");

  const on = withAutoVolume({ ...adjusted, ...off }, true);
  assert.deepEqual(on, {
    volumeGain: QUIET.suggestedGain,
    volumeGainSource: "auto",
    autoVolume: true
  });

  // Turning it on from the listener's own level clears that level.
  const manual = book({ volumeGain: 2, volumeGainSource: "manual", autoVolume: true });
  assert.equal(withAutoVolume(manual, true).volumeGainSource, "auto");
  // Turning it off keeps a level they set.
  assert.deepEqual(withAutoVolume(manual, false), {
    volumeGain: 2,
    volumeGainSource: "manual",
    autoVolume: false
  });
});

test("books that were never measured or need nothing show no notice", () => {
  assert.equal(autoVolumeStatus(book({ audioAnalysis: undefined })).kind, "none");
  const fine = book({ audioAnalysis: { ...QUIET, flags: [], suggestedGain: 1 } });
  assert.equal(autoVolumeStatus(fine).kind, "none");
  assert.equal(describeAutoVolume(autoVolumeStatus(fine)), null);
  assert.deepEqual(audioIssues(fine.audioAnalysis), []);
});

test("channel and track problems are reported, not corrected", () => {
  const issues = audioIssues({
    ...QUIET,
    flags: ["inconsistent", "lopsided"],
    trackSpreadLu: 7.2,
    channelImbalanceDb: 60,
    louderChannel: "left",
    suggestedGain: 1
  });
  assert.deepEqual(issues, [
    "Loudness varies by 7 dB between tracks.",
    "The audio is on the left channel only."
  ]);
  assert.deepEqual(
    audioIssues({ ...QUIET, flags: ["lopsided"], channelImbalanceDb: 4.4, louderChannel: "right" }),
    ["The right channel is 4 dB louder."]
  );
});

/**
 * Switching automatic on and then moving the slider must reach the server in
 * that order, even when the first request is slow, or the switch would delete
 * the newer level.
 */
test("volume writes for one book reach the server in the order they were made", async () => {
  const run = createKeyedQueue();
  const order: string[] = [];
  let releaseSwitch!: () => void;
  const slowSwitch = run("book-1", () => new Promise<void>((resolve) => {
    releaseSwitch = () => {
      order.push("auto-volume");
      resolve();
    };
  }));
  const manual = run("book-1", async () => {
    order.push("volume");
  });
  const otherBook = run("book-2", async () => {
    order.push("other book");
  });
  await otherBook;
  assert.deepEqual(order, ["other book"]);
  releaseSwitch();
  await Promise.all([slowSwitch, manual]);
  assert.deepEqual(order, ["other book", "auto-volume", "volume"]);
});

test("a failed volume write does not hold up the next one", async () => {
  const run = createKeyedQueue();
  const failed = run("book-1", async () => {
    throw new Error("offline");
  });
  const next = run("book-1", async () => "sent");
  await assert.rejects(failed, /offline/);
  assert.equal(await next, "sent");
});
