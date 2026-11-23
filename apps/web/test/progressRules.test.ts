import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isSuspectProgressReset, summarizeBookProgress } from "../src/reliability.ts";
import type { Progress } from "../src/types.ts";

// The server's progress_rules_match_the_shared_fixture test applies the same
// cases, so the two copies of these rules cannot drift apart.
const rules = JSON.parse(
  readFileSync(new URL("../../server/fixtures/progress-rules.json", import.meta.url), "utf8")
);

function progressAt(bookPositionSeconds: number, finishedOverride?: boolean): Progress {
  return {
    bookId: "book",
    trackId: "t0",
    positionSeconds: bookPositionSeconds,
    bookPositionSeconds,
    durationSeconds: null,
    updatedAt: "1",
    ...(finishedOverride === undefined ? {} : { finishedOverride })
  };
}

function assertClose(actual: number | null, expected: number | null, label: string) {
  if (expected === null) return assert.equal(actual, null, label);
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
}

for (const rule of rules.summary) {
  test(`shared progress summary: ${rule.name}`, () => {
    const book = {
      durationSeconds: rule.bookDuration,
      tracks: rule.tracks.map((durationSeconds: number | null) => ({ durationSeconds }))
    };
    const summary = summarizeBookProgress(book, progressAt(rule.bookPosition, rule.finishedOverride))!;
    assert.equal(summary.status, rule.expect.status);
    assertClose(summary.bookPositionSeconds, rule.expect.bookPosition, "position");
    assertClose(summary.durationSeconds, rule.expect.duration, "duration");
    assertClose(summary.remainingSeconds, rule.expect.remaining, "remaining");
    assertClose(summary.percentComplete, rule.expect.percent, "percent");
  });
}

for (const rule of rules.suspectReset) {
  test(`shared suspect reset: ${rule.name}`, () => {
    assert.equal(
      isSuspectProgressReset(progressAt(rule.incoming), progressAt(rule.previous)),
      rule.expect
    );
  });
}
