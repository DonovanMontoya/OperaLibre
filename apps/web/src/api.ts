import type {
  AuthStatus,
  AuthUser,
  Book,
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

function defaultApiBase() {
  if (typeof window === "undefined") {
    return "";
  }

  const { hostname, protocol } = window.location;
  return `${protocol}//${hostname}:4000`;
}

const API_BASE = configuredApiBase || defaultApiBase();

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

  const response = await fetch(`${API_BASE}${path}`, {
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

function appendToken(path: string) {
  const token = getStoredToken();
  if (!token) {
    return path;
  }
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}token=${encodeURIComponent(token)}`;
}

export function mediaUrl(path: string) {
  return `${API_BASE}${appendToken(path)}`;
}

export function bookDownloadUrl(bookId: string) {
  return `${API_BASE}${appendToken(`/api/books/${bookId}/download`)}`;
}

export function readalongUrl(path: string) {
  return `${API_BASE}${appendToken(path)}`;
}
