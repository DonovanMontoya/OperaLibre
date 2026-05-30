import type {
  AuthStatus,
  AuthUser,
  Book,
  BookMetadataUpdate,
  JobCreated,
  JobStatus,
  LibationBook,
  LibationStatus,
  LoginResponse,
  ProfileStats,
  Progress
} from "./types";

const configuredApiBase = import.meta.env.VITE_API_BASE?.trim();
const TOKEN_STORAGE_KEY = "operalibre.authToken";
const SERVER_URL_STORAGE_KEY = "operalibre.serverUrl";

function defaultApiBase() {
  if (typeof window === "undefined") {
    return "";
  }

  const { hostname, protocol } = window.location;
  return `${protocol}//${hostname}:4000`;
}

function normalizeServerUrl(value: string): string {
  let trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `http://${trimmed}`;
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

let storedServerUrl: string | null = null;

function readStoredServerUrl(): string | null {
  if (storedServerUrl !== null) {
    return storedServerUrl || null;
  }
  if (typeof window === "undefined") {
    return null;
  }
  storedServerUrl = window.localStorage.getItem(SERVER_URL_STORAGE_KEY) ?? "";
  return storedServerUrl || null;
}

export function getServerUrl(): string {
  return readStoredServerUrl() ?? configuredApiBase ?? defaultApiBase();
}

export function hasUserConfiguredServer(): boolean {
  return !!readStoredServerUrl();
}

export function setServerUrl(rawValue: string) {
  const value = normalizeServerUrl(rawValue);
  storedServerUrl = value;
  if (typeof window === "undefined") {
    return;
  }
  if (value) {
    window.localStorage.setItem(SERVER_URL_STORAGE_KEY, value);
  } else {
    window.localStorage.removeItem(SERVER_URL_STORAGE_KEY);
  }
}

export function clearServerUrl() {
  setServerUrl("");
}

function currentApiBase(): string {
  return getServerUrl();
}

export async function pingServer(rawValue: string): Promise<boolean> {
  const base = normalizeServerUrl(rawValue);
  if (!base) {
    throw new Error("Server URL is required.");
  }
  const response = await fetch(`${base}/api/health`, {
    method: "GET",
    credentials: "include"
  });
  if (!response.ok) {
    throw new Error(`Server responded ${response.status}.`);
  }
  return true;
}

let cachedToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

export function getStoredToken(): string | null {
  if (cachedToken !== null) {
    return cachedToken;
  }
  if (typeof window === "undefined") {
    return null;
  }
  cachedToken = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  return cachedToken;
}

export function setStoredToken(token: string | null) {
  cachedToken = token;
  if (typeof window === "undefined") {
    return;
  }
  if (token) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  const token = getStoredToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${currentApiBase()}${path}`, {
    ...init,
    headers,
    credentials: "include"
  });

  if (response.status === 401 && unauthorizedHandler) {
    unauthorizedHandler();
  }

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const body = await response.json();
      if (body && typeof body.message === "string") {
        message = body.message;
      }
    } catch {
      // ignore
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function getAuthStatus() {
  return request<AuthStatus>("/api/auth/status");
}

export async function setupAdmin(username: string, password: string) {
  return request<LoginResponse>("/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
}

export async function login(username: string, password: string) {
  return request<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
}

export async function logout() {
  return request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}

export async function getMe() {
  return request<AuthUser>("/api/auth/me");
}

export async function getProfileStats() {
  return request<ProfileStats>("/api/profile/stats");
}

export async function listUsers() {
  return request<AuthUser[]>("/api/users");
}

export async function createUser(username: string, password: string, isAdmin: boolean) {
  return request<AuthUser>("/api/users", {
    method: "POST",
    body: JSON.stringify({ username, password, isAdmin })
  });
}

export async function deleteUser(userId: string) {
  return request<{ ok: boolean }>(`/api/users/${encodeURIComponent(userId)}`, {
    method: "DELETE"
  });
}

export async function changePassword(
  userId: string,
  newPassword: string,
  currentPassword?: string
) {
  return request<{ ok: boolean }>(`/api/users/${encodeURIComponent(userId)}/password`, {
    method: "POST",
    body: JSON.stringify({ newPassword, currentPassword })
  });
}

export async function getBooks() {
  return request<Book[]>("/api/books");
}

export async function updateBookMetadata(bookId: string, metadata: BookMetadataUpdate) {
  return request<Book>(`/api/books/${encodeURIComponent(bookId)}/metadata`, {
    method: "PUT",
    body: JSON.stringify(metadata)
  });
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

export async function liberateAllLibationBooks() {
  return request<JobCreated>("/api/libation/liberate-all", { method: "POST" });
}

export async function getJob(jobId: string) {
  return request<JobStatus>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

function appendToken(path: string) {
  const token = getStoredToken();
  if (!token) {
    return path;
  }
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}token=${encodeURIComponent(token)}`;
}

export function mediaUrl(path: string) {
  return `${currentApiBase()}${appendToken(path)}`;
}

export function bookDownloadUrl(bookId: string) {
  return `${currentApiBase()}${appendToken(`/api/books/${bookId}/download`)}`;
}

export function readalongUrl(path: string) {
  return `${currentApiBase()}${appendToken(path)}`;
}
