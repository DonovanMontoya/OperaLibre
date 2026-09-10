import { jobElapsedMinutes } from "./jobTiming.ts";
import type { JobStatus } from "./types";

/** Running first, then queued, then whatever has already finished. */
function jobOrder(job: Pick<JobStatus, "status">) {
  return job.status === "running" ? 0 : job.status === "queued" ? 1 : 2;
}

/**
 * Active jobs read oldest first, so the queue reads in the order it will run.
 * Finished ones read newest first, because the last result is the interesting
 * one.
 */
export function sortSyncJobs<T extends Pick<JobStatus, "status" | "startedAt">>(jobs: T[]): T[] {
  return [...jobs].sort((a, b) =>
    jobOrder(a) - jobOrder(b)
    || (jobOrder(a) === 2 ? Number(b.startedAt) - Number(a.startedAt) : Number(a.startedAt) - Number(b.startedAt))
  );
}

export function hasActiveSyncJob(jobs: Pick<JobStatus, "status">[] | null): boolean {
  return jobs?.some((job) => job.status === "running" || job.status === "queued") ?? false;
}

/** A job in hand moves; a settled list only has to notice the next one queued. */
export const ACTIVE_SYNC_POLL_MS = 2_000;
export const IDLE_SYNC_POLL_MS = 15_000;

export function syncJobPollDelay(jobs: Pick<JobStatus, "status">[] | null): number {
  return hasActiveSyncJob(jobs) ? ACTIVE_SYNC_POLL_MS : IDLE_SYNC_POLL_MS;
}

/** 0-100 for the bar, or null where the job cannot estimate a position. */
export function syncJobPercent(job: Pick<JobStatus, "progress">): number | null {
  const fraction = job.progress?.fraction;
  return typeof fraction === "number" && Number.isFinite(fraction)
    ? Math.round(Math.max(0, Math.min(1, fraction)) * 100)
    : null;
}

type SyncJobView = Pick<
  JobStatus,
  "id" | "status" | "targetId" | "startedAt" | "finishedAt" | "error" | "progress"
> & Partial<Pick<JobStatus, "runningAt">>;

function sameJob(a: SyncJobView, b: SyncJobView): boolean {
  return a.id === b.id
    && a.status === b.status
    && a.targetId === b.targetId
    && a.startedAt === b.startedAt
    && (a.runningAt ?? null) === (b.runningAt ?? null)
    && a.finishedAt === b.finishedAt
    && a.error === b.error
    && (a.progress?.step ?? null) === (b.progress?.step ?? null)
    && (a.progress?.fraction ?? null) === (b.progress?.fraction ?? null);
}

/**
 * Whether a poll changed anything the monitor draws — the job payloads, or the
 * whole minutes of elapsed time shown beside a running one. Where it did not,
 * the caller holds its previous state, which keeps React from re-rendering and
 * the device from re-laying out the whole list every couple of seconds. That
 * idle redraw is what makes the panel stutter under a finger on iOS.
 */
export function syncFeedChanged(
  previous: { jobs: SyncJobView[]; now: number } | null,
  next: SyncJobView[],
  now: number
): boolean {
  if (previous === null || previous.jobs.length !== next.length) return true;
  return previous.jobs.some((job, index) =>
    !sameJob(job, next[index])
    || jobElapsedMinutes(job, previous.now) !== jobElapsedMinutes(job, now)
  );
}
