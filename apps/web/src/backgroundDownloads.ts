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

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export function getBackgroundBookDownloadStatus(jobId: string) {
  return BackgroundDownloads.getStatus({ jobId });
}

export async function runBackgroundBookDownload(
  jobId: string,
  title: string,
  files: BackgroundDownloadFile[],
  onProgress: (fraction: number, state: BackgroundDownloadStatus["state"]) => void
) {
  await BackgroundDownloads.enqueueBook({ jobId, title, files });

  while (true) {
    const status = await BackgroundDownloads.getStatus({ jobId });
    onProgress(Math.max(0, Math.min(1, status.fraction)), status.state);
    if (status.state === "completed") return;
    if (status.state === "failed") throw new Error(status.error || "The background download failed.");
    await wait(500);
  }
}
