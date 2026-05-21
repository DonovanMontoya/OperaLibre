import type { Book, JobCreated, JobStatus, LibationBook, LibationStatus, Progress } from "./types";

const configuredApiBase = import.meta.env.VITE_API_BASE?.trim();

function defaultApiBase() {
  if (typeof window === "undefined") {
    return "";
  }

  const { hostname, protocol } = window.location;
  return `${protocol}//${hostname}:4000`;
}

const API_BASE = configuredApiBase || defaultApiBase();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    },
    ...init
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function getBooks() {
  return request<Book[]>("/api/books");
}

export async function rescanLibrary() {
  return request<Book[]>("/api/library/rescan", { method: "POST" });
}

export async function getProgress(bookId: string) {
  return request<Progress | null>(`/api/books/${bookId}/progress`);
}

export async function saveProgress(
  bookId: string,
  progress: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">
) {
  return request<Progress>(`/api/books/${bookId}/progress`, {
    method: "PUT",
    body: JSON.stringify(progress)
  });
}

export async function getLibationStatus() {
  return request<LibationStatus>("/api/libation/status");
}

export async function getLibationBooks() {
  return request<LibationBook[]>("/api/libation/books");
}

export async function syncLibationLibrary() {
  return request<JobCreated>("/api/libation/sync", { method: "POST" });
}

export async function liberateLibationBook(asin: string) {
  return request<JobCreated>(`/api/libation/books/${encodeURIComponent(asin)}/liberate`, {
    method: "POST"
  });
}

export async function getJob(jobId: string) {
  return request<JobStatus>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export function mediaUrl(path: string) {
  return `${API_BASE}${path}`;
}

export function bookDownloadUrl(bookId: string) {
  return `${API_BASE}/api/books/${bookId}/download`;
}
