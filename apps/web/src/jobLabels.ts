import type { JobStatus } from "./types";

export function jobTitle(job: JobStatus) {
  if (job.kind === "libation-sync") {
    return "Checking Audible library";
  }
  if (job.kind === "libation-liberate") {
    return "Audible download";
  }
  if (job.kind === "libation-liberate-all") {
    return "Audible download all";
  }
  return job.kind;
}

export function isPendingJob(job: JobStatus) {
  return job.status === "queued" || job.status === "running";
}

export function reconcileLibationJobs(jobs: JobStatus[], previousJobs: JobStatus[]) {
  const previousById = new Map(previousJobs.map((job) => [job.id, job]));
  return jobs
    .filter((job) => job.kind.startsWith("libation-"))
    .map((job) => ({
      ...job,
      // Servers from before queued downloads were introduced do not return a
      // targetId. Keep the optimistic association so the title's button stays
      // attached to its job while that server is being upgraded.
      targetId: job.targetId ?? previousById.get(job.id)?.targetId ?? null
    }));
}

export function jobStateLabel(job: JobStatus) {
  if (job.status === "queued") {
    return "Queued";
  }
  if (job.status !== "running") {
    return job.status;
  }
  if (job.kind === "libation-sync") {
    return "Syncing";
  }
  if (job.kind === "libation-liberate" || job.kind === "libation-liberate-all") {
    return "Downloading";
  }
  return "Running";
}

export function jobDetailLines(job: JobStatus) {
  const text = [job.error, job.output].filter(Boolean).join("\n");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12);
}

export function jobSummary(job: JobStatus) {
  if (job.error) {
    return job.error;
  }
  if (job.status === "queued") {
    return "Waiting for the current Libation operation to finish.";
  }
  const lines = job.output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const latest = lines[lines.length - 1];
  if (latest) {
    return latest;
  }
  return job.status === "running" ? "Waiting for Libation output..." : "No output captured.";
}
