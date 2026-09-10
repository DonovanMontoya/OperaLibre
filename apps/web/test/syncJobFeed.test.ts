import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVE_SYNC_POLL_MS,
  IDLE_SYNC_POLL_MS,
  hasActiveSyncJob,
  sortSyncJobs,
  syncFeedChanged,
  syncJobPercent,
  syncJobPollDelay
} from "../src/syncJobFeed.ts";

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "a",
    kind: "sync-generate",
    targetId: "book",
    status: "running",
    startedAt: "1000",
    runningAt: "1000",
    finishedAt: null,
    exitCode: null,
    output: "",
    error: null,
    progress: { step: "Aligning", fraction: 0.5, completed: null, total: null },
    ...overrides
  } as never;
}

test("running jobs sort first, then the queue oldest first, then results newest first", () => {
  const order = sortSyncJobs([
    { id: "old-result", status: "completed", startedAt: "100" },
    { id: "queued-late", status: "queued", startedAt: "500" },
    { id: "new-result", status: "failed", startedAt: "400" },
    { id: "queued-early", status: "queued", startedAt: "300" },
    { id: "active", status: "running", startedAt: "200" }
  ]).map((entry) => entry.id);
  assert.deepEqual(order, ["active", "queued-early", "queued-late", "new-result", "old-result"]);
});

test("sorting leaves the caller's array alone", () => {
  const input = [
    { id: "done", status: "completed", startedAt: "100" },
    { id: "active", status: "running", startedAt: "200" }
  ];
  sortSyncJobs(input);
  assert.deepEqual(input.map((entry) => entry.id), ["done", "active"]);
});

test("polling stays tight only while a job is actually moving", () => {
  assert.equal(hasActiveSyncJob(null), false);
  assert.equal(hasActiveSyncJob([]), false);
  assert.equal(hasActiveSyncJob([{ status: "completed" }, { status: "failed" }]), false);
  assert.equal(hasActiveSyncJob([{ status: "completed" }, { status: "queued" }]), true);

  assert.equal(syncJobPollDelay([{ status: "running" }]), ACTIVE_SYNC_POLL_MS);
  assert.equal(syncJobPollDelay([{ status: "queued" }]), ACTIVE_SYNC_POLL_MS);
  assert.equal(syncJobPollDelay([{ status: "completed" }]), IDLE_SYNC_POLL_MS);
  assert.equal(syncJobPollDelay(null), IDLE_SYNC_POLL_MS);
});

test("a percentage is only shown where the job reported a usable fraction", () => {
  assert.equal(syncJobPercent({ progress: { step: "s", fraction: 0.456, completed: null, total: null } }), 46);
  assert.equal(syncJobPercent({ progress: { step: "s", fraction: 2, completed: null, total: null } }), 100);
  assert.equal(syncJobPercent({ progress: { step: "s", fraction: -1, completed: null, total: null } }), 0);
  assert.equal(syncJobPercent({ progress: { step: "s", fraction: Number.NaN, completed: null, total: null } }), null);
  assert.equal(syncJobPercent({ progress: { step: "s", fraction: null, completed: null, total: null } }), null);
  assert.equal(syncJobPercent({ progress: null }), null);
  assert.equal(syncJobPercent({}), null);
});

test("an identical poll within the same displayed minute is not a change", () => {
  const previous = { jobs: [job()], now: 100_000 };
  assert.equal(syncFeedChanged(previous, [job()], 115_000), false);
});

test("a poll is a change when the payload moves, the list resizes, or a minute ticks over", () => {
  const previous = { jobs: [job()], now: 100_000 };
  assert.equal(syncFeedChanged(null, [job()], 100_000), true);
  assert.equal(syncFeedChanged(previous, [], 100_000), true);
  assert.equal(syncFeedChanged(previous, [job(), job({ id: "b" })], 100_000), true);
  assert.equal(syncFeedChanged(previous, [job({ status: "completed" })], 100_000), true);
  assert.equal(syncFeedChanged(previous, [job({ error: "boom" })], 100_000), true);
  assert.equal(syncFeedChanged(previous, [job({ finishedAt: "9000" })], 100_000), true);
  assert.equal(
    syncFeedChanged(previous, [job({ progress: { step: "Saving", fraction: 0.5, completed: null, total: null } })], 100_000),
    true
  );
  assert.equal(
    syncFeedChanged(previous, [job({ progress: { step: "Aligning", fraction: 0.6, completed: null, total: null } })], 100_000),
    true
  );
  // previous.now reads as "1 min" elapsed; this poll reads as "3 min".
  assert.equal(syncFeedChanged(previous, [job()], 181_000), true);
});

test("a settled job stops counting, so time alone never forces a redraw", () => {
  const done = job({ status: "completed", finishedAt: "5000" });
  assert.equal(syncFeedChanged({ jobs: [done], now: 100_000 }, [done], 9_000_000), false);
});
