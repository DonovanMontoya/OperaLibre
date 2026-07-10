import { Capacitor } from "@capacitor/core";
import type {
  AlignmentStatus,
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
  Progress,
  ServerType,
  SyncMap
} from "./types";
import {
  getCachedJellyfinProgress,
  getJellyfinBooks,
  getJellyfinUser,
  jellyfinMediaPath,
  loginToJellyfin,
  logoutFromJellyfin,
  pingJellyfin,
  reportJellyfinPlaybackStart,
  saveJellyfinProgress
} from "./jellyfin";
import { serverStorageKey } from "./reliability";

const configuredApiBase = import.meta.env.VITE_API_BASE?.trim();
const TOKEN_STORAGE_KEY = "operalibre.authToken";
const SERVER_URL_STORAGE_KEY = "operalibre.serverUrl";
const SERVER_TYPE_STORAGE_KEY = "operalibre.serverType";
const STARTUP_TIMEOUT_MS = 8_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = STARTUP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

export function defaultServerUrl(serverType: ServerType) {
  if (typeof window === "undefined") {
    return "";
  }

  if (Capacitor.isNativePlatform()) {
    return "";
  }

  const { hostname, protocol } = window.location;
  const host = hostname || "localhost";
  const scheme = protocol === "https:" ? "https:" : "http:";
  const port = serverType === "jellyfin"
    ? scheme === "https:" ? 8920 : 8096
    : 4000;
  return `${scheme}//${host}:${port}`;
}

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

function isLoopbackServerUrl(value: string): boolean {
  try {
    const hostname = new URL(normalizeServerUrl(value)).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
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
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${path}`;
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
  return readStoredServerUrl() ?? configuredApiBase ?? defaultServerUrl(getServerType());
}

export function getServerType(): ServerType {
  if (typeof window === "undefined") {
    return "operalibre";
  }
  return window.localStorage.getItem(SERVER_TYPE_STORAGE_KEY) === "jellyfin"
    ? "jellyfin"
    : "operalibre";
}

export function getServerStorageKey(): string {
  return serverStorageKey(getServerType(), getServerUrl());
}

export function setServerType(serverType: ServerType) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SERVER_TYPE_STORAGE_KEY, serverType);
  }
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

export function setServerConnection(serverType: ServerType, rawValue: string) {
  const changed = getServerType() !== serverType || getServerUrl() !== normalizeServerUrl(rawValue);
  setServerType(serverType);
  setServerUrl(rawValue);
  if (changed) {
    setStoredToken(null);
  }
}

export function clearServerUrl() {
  setServerUrl("");
}

function currentApiBase(): string {
  return getServerUrl();
}

export async function pingServer(serverType: ServerType, rawValue: string): Promise<boolean> {
  const base = normalizeServerUrl(rawValue);
  if (!base) {
    throw new Error("Server URL is required.");
  }
  if (Capacitor.isNativePlatform() && isLoopbackServerUrl(base)) {
    const port = serverType === "jellyfin" ? 8096 : 4000;
    throw new Error(
      `localhost points to this iPhone. Use the server computer's LAN address, for example http://My-Mac.local:${port}.`
    );
  }
  if (serverType === "jellyfin") {
    await pingJellyfin(base);
    return true;
  }
  const response = await fetchWithTimeout(`${base}/api/health`, {
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

// fetch rejects with a TypeError when the server is unreachable; anything the
// server actually answered comes back as ApiError (or a plain Error from the
// Jellyfin client). Callers use this to tell "offline" apart from "rejected".
export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError");
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  const token = getStoredToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetchWithTimeout(`${currentApiBase()}${path}`, {
    ...init,
    headers,
    credentials: "include"
  }, timeoutMs);

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
  if (getServerType() === "jellyfin") {
    const token = getStoredToken();
    if (!token) {
      return { setupRequired: false, user: null };
    }
    try {
      return { setupRequired: false, user: await getJellyfinUser(currentApiBase(), token) };
    } catch (error) {
      // Only treat an answered request as "not signed in"; when the server is
      // unreachable, let the caller fall back to the cached offline session.
      if (isNetworkError(error)) {
        throw error;
      }
      return { setupRequired: false, user: null };
    }
  }
  return request<AuthStatus>("/api/auth/status", undefined, STARTUP_TIMEOUT_MS);
}

export async function setupAdmin(username: string, password: string) {
  return request<LoginResponse>("/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
}

export async function login(username: string, password: string) {
  if (getServerType() === "jellyfin") {
    return loginToJellyfin(currentApiBase(), username, password);
  }
  return request<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
}

export async function logout() {
  if (getServerType() === "jellyfin") {
    const token = getStoredToken();
    if (token) {
      await logoutFromJellyfin(currentApiBase(), token);
    }
    return { ok: true };
  }
  return request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}

export async function getMe() {
  if (getServerType() === "jellyfin") {
    const token = getStoredToken();
    if (!token) {
      throw new ApiError("Not signed in.", 401);
    }
    return getJellyfinUser(currentApiBase(), token);
  }
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
  if (getServerType() === "jellyfin") {
    const token = getStoredToken();
    if (!token) {
      throw new ApiError("Not signed in.", 401);
    }
    return getJellyfinBooks(currentApiBase(), token);
  }
  // Library loading is part of native startup. Fail promptly so MainApp can
  // show its cached library instead of waiting on an unreachable VPN route.
  return request<Book[]>("/api/books", undefined, STARTUP_TIMEOUT_MS);
}

export async function updateBookMetadata(bookId: string, metadata: BookMetadataUpdate) {
  return request<Book>(`/api/books/${encodeURIComponent(bookId)}/metadata`, {
    method: "PUT",
    body: JSON.stringify(metadata)
  });
}

export async function rescanLibrary() {
  if (getServerType() === "jellyfin") {
    return getBooks();
  }
  return request<Book[]>("/api/library/rescan", { method: "POST" });
}

export async function getProgress(bookId: string) {
  if (getServerType() === "jellyfin") {
    return getCachedJellyfinProgress(bookId);
  }
  return request<Progress | null>(`/api/books/${bookId}/progress`);
}

export async function saveProgress(
  bookId: string,
  progress: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">
    & Partial<Pick<Progress, "updatedAt">>,
  options?: { isPaused?: boolean }
) {
  if (getServerType() === "jellyfin") {
    const token = getStoredToken();
    if (!token) {
      throw new ApiError("Not signed in.", 401);
    }
    return saveJellyfinProgress(currentApiBase(), token, bookId, progress, options?.isPaused);
  }
  return request<Progress>(`/api/books/${bookId}/progress`, {
    method: "PUT",
    body: JSON.stringify(progress)
  });
}

export async function getLibationStatus() {
  if (getServerType() === "jellyfin") {
    return {
      enabled: false,
      cliPath: null,
      libationFilesDir: null,
      libraryRoot: "",
      accounts: [],
      authenticated: false,
      message: "Libation is available only with an OperaLibre server."
    } satisfies LibationStatus;
  }
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

export async function getSyncMap(bookId: string) {
  return request<SyncMap>(`/api/books/${encodeURIComponent(bookId)}/sync`);
}

export async function generateSyncMap(bookId: string) {
  return request<JobCreated>(`/api/books/${encodeURIComponent(bookId)}/sync/generate`, {
    method: "POST"
  });
}

export async function getAlignmentStatus() {
  return request<AlignmentStatus>("/api/alignment/status");
}

export async function getJob(jobId: string) {
  return request<JobStatus>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export async function listJobs() {
  return request<JobStatus[]>("/api/jobs");
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
  return `${currentApiBase()}${
    getServerType() === "jellyfin"
      ? jellyfinMediaPath(path, getStoredToken())
      : appendToken(path)
  }`;
}

export function bookDownloadUrl(bookId: string) {
  if (getServerType() === "jellyfin") {
    return mediaUrl(`/Items/${encodeURIComponent(bookId)}/Download`);
  }
  return `${currentApiBase()}${appendToken(`/api/books/${bookId}/download`)}`;
}

export function readalongUrl(path: string) {
  return `${currentApiBase()}${appendToken(path)}`;
}

export async function reportPlaybackStarted(itemId: string, positionSeconds: number) {
  if (getServerType() !== "jellyfin") {
    return;
  }
  const token = getStoredToken();
  if (!token) {
    return;
  }
  await reportJellyfinPlaybackStart(currentApiBase(), token, itemId, positionSeconds);
}
