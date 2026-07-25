import { registerPlugin } from "@capacitor/core";

export type BackgroundDownloadFile = {
  url: string;
  path: string;
  label: string;
  required: boolean;
};

export type BackgroundDownloadStatus = {
  state: "queued" | "running" | "completed" | "failed";
  fraction: number;
  error?: string;
};

interface BackgroundDownloadsPlugin {
  enqueueBook(options: {
    jobId: string;
    title: string;
    files: BackgroundDownloadFile[];
  }): Promise<void>;
  getStatus(options: { jobId: string }): Promise<BackgroundDownloadStatus>;
}

const BackgroundDownloads = registerPlugin<BackgroundDownloadsPlugin>("BackgroundDownloads");

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("The download was cancelled.", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(
      signal.reason ?? new DOMException("The download was cancelled.", "AbortError")
    );
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The download was cancelled.", "AbortError"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = window.setTimeout(finish, milliseconds);
    const abort = () => {
      window.clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The download was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function getBackgroundBookDownloadStatus(jobId: string) {
  return BackgroundDownloads.getStatus({ jobId });
}

export async function runBackgroundBookDownload(
  jobId: string,
  title: string,
  files: BackgroundDownloadFile[],
  onProgress: (fraction: number, state: BackgroundDownloadStatus["state"]) => void,
  signal?: AbortSignal
) {
  await abortable(BackgroundDownloads.enqueueBook({ jobId, title, files }), signal);

  let pollDelay = 500;
  while (true) {
    signal?.throwIfAborted();
    const status = await abortable(BackgroundDownloads.getStatus({ jobId }), signal);
    signal?.throwIfAborted();
    onProgress(Math.max(0, Math.min(1, status.fraction)), status.state);
    if (status.state === "completed") return;
    if (status.state === "failed") throw new Error(status.error || "The background download failed.");
    await wait(pollDelay, signal);
    pollDelay = Math.min(5_000, Math.round(pollDelay * 1.5));
  }
}
