import assert from "node:assert/strict";
import { test } from "node:test";
import { jobElapsedMinutes } from "../src/jobTiming.ts";

test("running jobs use their execution start and older servers fall back to creation time", () => {
  const job = { status: "running", startedAt: "60000" };
  assert.equal(jobElapsedMinutes(job, 240000), 3);
  assert.equal(jobElapsedMinutes({ ...job, runningAt: null }, 240000), 3);
  assert.equal(jobElapsedMinutes({ ...job, runningAt: "180000" }, 240000), 1);
});

test("elapsed time rejects invalid timestamps and non-running jobs and clamps future starts", () => {
  for (const startedAt of ["", "0", "invalid", "Infinity", "-1"]) {
    assert.equal(jobElapsedMinutes({ status: "running", startedAt }, 240000), null);
  }
  for (const status of ["queued", "completed", "failed"]) {
    assert.equal(jobElapsedMinutes({ status, startedAt: "60000" }, 240000), null);
  }
  assert.equal(jobElapsedMinutes({ status: "running", startedAt: "300000" }, 240000), 0);
});
