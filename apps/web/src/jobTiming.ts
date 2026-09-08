import type { JobStatus } from "./types";

export function jobElapsedMinutes(job: Pick<JobStatus, "status" | "runningAt" | "startedAt">, now: number): number | null {
  if (job.status !== "running") return null;
  const started = Number(job.runningAt ?? job.startedAt);
  return Number.isFinite(started) && started > 0
    ? Math.max(0, Math.floor((now - started) / 60000))
    : null;
}
