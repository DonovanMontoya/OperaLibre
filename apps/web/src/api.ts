import { Capacitor } from "@capacitor/core";
import type {
  AlignmentStatus,
  SyncAnchorSummary,
  AuthStatus,
  AuthUser,
  Book,
  BookMetadataUpdate,
  BookProgress,
  FaststartStatus,
  FinishFeed,
  JobCreated,
  JobStatus,
  LibationAccess,
  LibationAccessStatus,
  LibationBook,
  LibationDownloadRequest,
  LibationStatus,
  LibationLoginStarted,
  LoginResponse,
  ProfileStats,
  Progress,
  ServerType,
  SyncMap,
  UpdateInstallStarted,
  FrontendUpdateStatus,
  UpdateStatus
} from "./types";
import {
  getCachedJellyfinProgress,
  getJellyfinBooks,
  getJellyfinUser,
  jellyfinMediaPath,
  loginToJellyfin,
  logoutFromJellyfin,
  pingJellyfin,
  refreshJellyfinProgress,
  reportJellyfinPlaybackStart,
  saveJellyfinProgress,
  setJellyfinBookCompletion
} from "./jellyfin";
import { progressTimestamp, serverStorageKey, tzOffsetMinutes } from "./reliability";
import {
  browserApiBase,
  normalizeServerAddress,
  requireSecurePublicServerAddress,
  upgradeStoredNativeServerAddress
} from "./serverAddress";
import {
  DEMO_USER,
  demoMediaUrl,
  getDemoBooks,
  getDemoProfileStats,
  getDemoProgress,
  isDemoMediaPath,
  isDemoMode,
  saveDemoProgress,
  setDemoBookCompletion
} from "./demo";

const configuredApiBase = import.meta.env.VITE_API_BASE?.trim();
const TOKEN_STORAGE_KEY = "operalibre.authToken";
const MEDIA_TOKEN_STORAGE_KEY = "operalibre.mediaToken";
const SERVER_URL_STORAGE_KEY = "operalibre.serverUrl";
const SERVER_TYPE_STORAGE_KEY = "operalibre.serverType";
const SERVER_IDENTITY_URL_STORAGE_KEY = "operalibre.serverIdentityUrl";
const SERVER_ALIASES_STORAGE_KEY = "operalibre.serverAliases";
const STARTUP_TIMEOUT_MS = 8_000;

/**
 * The docs-site page (built from docs/getting-started.md in the repo) that
 * explains what an OperaLibre server is and how to stand one up. Shown to
 * readers who reached the app before they have a server.
 */
export const SERVER_SETUP_GUIDE_URL = "https://donovanmontoya.github.io/OperaLibre/getting-started.html";
const LOCAL_MODE_STORAGE_KEY = "operalibre.localMode";

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
  if (serverType === "jellyfin") {
    const port = scheme === "https:" ? 8920 : 8096;
    return `${scheme}//${host}:${port}`;
  }
  // A production bundle is normally served by the Rust server or by the
  // same-origin TLS proxy. Only Vite development needs to address port 4000
  // directly; its own /api proxy remains available as a fallback as well.
  if (window.location.port === "5173") {
    return `${scheme}//${host}:4000`;
  }
  return window.location.origin;
}

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

// The macOS shell is a plain, desktop-sized WKWebView, not a Capacitor
// runtime — it should keep the regular desktop layout, so it must NOT be
// folded into isNativeApp() (that also switches the app into the mobile
// single-pane / bottom-tab-bar UI built for phone-sized Capacitor builds).
// It does need the same credential handling as Capacitor apps though: the
// shell serves the SPA from a local origin (127.0.0.1) that's different from
// the configured server's origin, so a session cookie can never be set/sent
// across that boundary. It identifies itself with an injected flag instead
// (see apps/macos/Sources/OperaLibre/main.swift). Without this, the token
// storage functions below delete any persisted auth token on every launch.
function usesNativeCredentialStorage(): boolean {
  const isMacShell = typeof window !== "undefined" && window.__OPERALIBRE_NATIVE_SHELL__ === true;
  return isNativeApp() || isMacShell;
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
  return normalizeServerAddress(value);
}

export type ServerAlias = {
  id: string;
  name: string;
  url: string;
};

export function getServerAliases(): ServerAlias[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SERVER_ALIASES_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((alias): alias is ServerAlias =>
      typeof alias?.id === "string" && typeof alias?.name === "string" && typeof alias?.url === "string"
    );
  } catch {
    return [];
  }
}

function storeServerAliases(aliases: ServerAlias[]) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SERVER_ALIASES_STORAGE_KEY, JSON.stringify(aliases));
  }
}

export function addServerAlias(name: string, rawUrl: string): ServerAlias {
  const trimmedName = name.trim();
  const url = Capacitor.isNativePlatform()
    ? requireSecurePublicServerAddress(rawUrl)
    : normalizeServerUrl(rawUrl);
  if (!trimmedName) throw new Error("Alias name is required.");
  if (!url) throw new Error("Alias URL is required.");
  const aliases = getServerAliases();
  if (aliases.some((alias) => alias.name.toLowerCase() === trimmedName.toLowerCase())) {
    throw new Error("An alias with that name already exists.");
  }
  if (aliases.some((alias) => alias.url.toLowerCase() === url.toLowerCase())) {
    throw new Error("That server address is already saved.");
  }
  const alias = { id: crypto.randomUUID(), name: trimmedName, url };
  // Existing installs predate the identity key. Pin their current address
  // before an alias can become active so caches remain tied to one server.
  if (typeof window !== "undefined" && !window.localStorage.getItem(SERVER_IDENTITY_URL_STORAGE_KEY)) {
    window.localStorage.setItem(SERVER_IDENTITY_URL_STORAGE_KEY, getServerUrl());
  }
  storeServerAliases([...aliases, alias]);
  return alias;
}

export function removeServerAlias(id: string) {
  storeServerAliases(getServerAliases().filter((alias) => alias.id !== id));
}

export function activateServerAlias(alias: ServerAlias) {
  setServerUrl(alias.url);
}

/**
 * On iOS, a server can be reachable through different private-network
 * addresses depending on the network in use. When the active address is
 * unavailable, promote the first saved alias that answers its health check.
 * The server identity and authentication token are deliberately retained:
 * aliases represent the same server.
 */
export async function reconnectUsingServerAliases(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    return false;
  }

  const activeUrl = normalizeServerUrl(getServerUrl()).toLowerCase();
  const candidates = [
    { id: "primary", name: "Original address", url: getServerIdentityUrl() },
    ...getServerAliases()
  ];
  const attemptedUrls = new Set<string>();
  for (const alias of candidates) {
    const aliasUrl = normalizeServerUrl(alias.url).toLowerCase();
    if (!aliasUrl || attemptedUrls.has(aliasUrl)) {
      continue;
    }
    attemptedUrls.add(aliasUrl);
    if (aliasUrl === activeUrl) {
      continue;
    }
    try {
      await pingServer(getServerType(), alias.url);
      activateServerAlias(alias);
      return true;
    } catch {
      // Try the next saved address. A later successful health check is the
      // only condition under which the active address is changed.
    }
  }
  return false;
}

let storedServerUrl: string | null = null;

function readStoredServerUrl(): string | null {
  if (storedServerUrl !== null) {
    return storedServerUrl || null;
  }
  if (typeof window === "undefined") {
    return null;
  }
  const stored = window.localStorage.getItem(SERVER_URL_STORAGE_KEY) ?? "";
  storedServerUrl = Capacitor.isNativePlatform()
    ? upgradeStoredNativeServerAddress(stored)
    : stored;
  if (storedServerUrl && storedServerUrl !== stored) {
    window.localStorage.setItem(SERVER_URL_STORAGE_KEY, storedServerUrl);
  }
  return storedServerUrl || null;
}

export function getServerUrl(): string {
  if (isLocalMode()) return "This device";
  if (isDemoMode()) return "On-device demo";
  const url = readStoredServerUrl() ?? configuredApiBase ?? defaultServerUrl(getServerType());
  return Capacitor.isNativePlatform() ? upgradeStoredNativeServerAddress(url) : url;
}

export function getServerType(): ServerType {
  if (isDemoMode()) return "operalibre";
  if (typeof window === "undefined") {
    return "operalibre";
  }
  return window.localStorage.getItem(SERVER_TYPE_STORAGE_KEY) === "jellyfin"
    ? "jellyfin"
    : "operalibre";
}

export function getServerStorageKey(): string {
  if (isLocalMode()) return "device-local";
  return serverStorageKey(getServerType(), getServerIdentityUrl());
}

export function isLocalMode(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(LOCAL_MODE_STORAGE_KEY) === "true";
}

export function enterLocalMode() {
  window.localStorage.setItem(LOCAL_MODE_STORAGE_KEY, "true");
}

export function exitLocalMode() {
  window.localStorage.removeItem(LOCAL_MODE_STORAGE_KEY);
}

export function getServerIdentityUrl(): string {
  const url = typeof window === "undefined"
    ? getServerUrl()
    : window.localStorage.getItem(SERVER_IDENTITY_URL_STORAGE_KEY) ?? getServerUrl();
  const secured = Capacitor.isNativePlatform() ? upgradeStoredNativeServerAddress(url) : url;
  if (typeof window !== "undefined" && secured !== url) {
    window.localStorage.setItem(SERVER_IDENTITY_URL_STORAGE_KEY, secured);
  }
  return secured;
}

export function setServerType(serverType: ServerType) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SERVER_TYPE_STORAGE_KEY, serverType);
  }
}

export function hasUserConfiguredServer(): boolean {
  return isDemoMode() || !!readStoredServerUrl();
}

export function setServerUrl(rawValue: string) {
  const value = Capacitor.isNativePlatform()
    ? requireSecurePublicServerAddress(rawValue)
    : normalizeServerUrl(rawValue);
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
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SERVER_IDENTITY_URL_STORAGE_KEY, normalizeServerUrl(rawValue));
    if (changed) storeServerAliases([]);
  }
  if (changed) {
    setStoredToken(null);
  }
}

export function clearServerUrl() {
  setServerUrl("");
}

function currentApiBase(): string {
  const serverUrl = getServerUrl();
  if (
    typeof window !== "undefined"
    && !Capacitor.isNativePlatform()
    && getServerType() === "operalibre"
  ) {
    return browserApiBase(serverUrl, window.location.origin);
  }
  return serverUrl;
}

export async function pingServer(serverType: ServerType, rawValue: string): Promise<boolean> {
  const base = Capacitor.isNativePlatform()
    ? requireSecurePublicServerAddress(rawValue)
    : normalizeServerUrl(rawValue);
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
  const requestBase = serverType === "operalibre" && typeof window !== "undefined"
    ? browserApiBase(base, window.location.origin)
    : base;
  const response = await fetchWithTimeout(`${requestBase}/api/health`, {
    method: "GET",
    credentials: "include"
  });
  if (!response.ok) {
    throw new Error(`Server responded ${response.status}.`);
  }
  return true;
}

let cachedToken: string | null = null;
let cachedMediaToken: string | null = null;
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
  if (!usesNativeCredentialStorage()) {
    // Browser sessions are restored from the Secure, HttpOnly cookie. Remove
    // tokens left by older builds so a later XSS cannot recover a persistent
    // full-API credential from localStorage.
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    return null;
  }
  cachedToken = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  return cachedToken;
}

export function setStoredToken(token: string | null) {
  cachedToken = token;
  if (!token) {
    setStoredMediaToken(null);
  }
  if (typeof window === "undefined") {
    return;
  }
  if (token && usesNativeCredentialStorage()) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

export function getStoredMediaToken(): string | null {
  if (cachedMediaToken !== null) {
    return cachedMediaToken;
  }
  if (typeof window === "undefined") {
    return null;
  }
  cachedMediaToken = window.localStorage.getItem(MEDIA_TOKEN_STORAGE_KEY);
  return cachedMediaToken;
}

export function setStoredMediaToken(token: string | null) {
  cachedMediaToken = token;
  if (typeof window === "undefined") {
    return;
  }
  if (token) {
    window.localStorage.setItem(MEDIA_TOKEN_STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(MEDIA_TOKEN_STORAGE_KEY);
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
  if (!headers.has("Content-Type") && init?.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const token = getStoredToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetchWithTimeout(`${currentApiBase()}${path}`, {
    ...init,
    headers,
    // API JSON represents live playback, job, and library state. WebKit may
    // otherwise reuse an earlier GET while a background operation is settling.
    cache: init?.cache ?? "no-store",
    // Native clients authenticate with the persisted bearer token. Omitting
    // cookies prevents an old WebKit cookie from turning a native mutation
    // into a cookie-authenticated CSRF request after an app upgrade.
    credentials: usesNativeCredentialStorage() ? "omit" : "include"
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
  if (isDemoMode()) return { setupRequired: false, user: DEMO_USER, mediaToken: null };
  if (getServerType() === "jellyfin") {
    const token = getStoredToken();
    if (!token) {
      return { setupRequired: false, user: null, mediaToken: null };
    }
    try {
      return {
        setupRequired: false,
        user: await getJellyfinUser(currentApiBase(), token),
        mediaToken: token
      };
    } catch (error) {
      // Only treat an answered request as "not signed in"; when the server is
      // unreachable, let the caller fall back to the cached offline session.
      if (isNetworkError(error)) {
        throw error;
      }
      return { setupRequired: false, user: null, mediaToken: null };
    }
  }
  return request<AuthStatus>("/api/auth/status", undefined, STARTUP_TIMEOUT_MS);
}

export async function setupAdmin(username: string, password: string, setupToken?: string) {
  return request<LoginResponse>("/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ username, password, setupToken })
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
  if (isDemoMode()) return { ok: true };
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
  if (isDemoMode()) return DEMO_USER;
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
  if (isDemoMode()) return getDemoProfileStats();
  // Streaks and the calendar are drawn against the reader's own days, so the
  // server needs to know which day "today" is here rather than in UTC.
  return request<ProfileStats>(`/api/profile/stats?tzOffsetMinutes=${tzOffsetMinutes()}`);
}

export async function getUpdateStatus(timeoutMs = 30_000, refresh = false) {
  return request<UpdateStatus>(`/api/update${refresh ? "?refresh=true" : ""}`, undefined, timeoutMs);
}

export async function installServerUpdate() {
  return request<UpdateInstallStarted>("/api/update/install", { method: "POST" }, 10 * 60_000);
}

export async function getFrontendUpdateStatus(
  timeoutMs = 30_000,
  refresh = false,
  currentVersion?: string
) {
  const query = new URLSearchParams();
  if (refresh) query.set("refresh", "true");
  if (currentVersion) query.set("currentVersion", currentVersion);
  return request<FrontendUpdateStatus>(
    `/api/frontend-update${query.size ? `?${query.toString()}` : ""}`,
    undefined,
    timeoutMs
  );
}

export async function installFrontendUpdate() {
  return request<UpdateInstallStarted>(
    "/api/frontend-update/install",
    { method: "POST" },
    10 * 60_000
  );
}

export type ServerRestoreResult = {
  restoredAt: string;
  safetyBackup: string;
  accounts: number;
  progressRecords: number;
  readingSessions: number;
  completions: number;
  sessionRetained: boolean;
  warning?: string;
};

function authenticatedHeaders(headers?: HeadersInit) {
  const result = new Headers(headers);
  const token = getStoredToken();
  if (token) result.set("Authorization", `Bearer ${token}`);
  return result;
}

export async function downloadServerBackup(): Promise<{ blob: Blob; filename: string }> {
  const response = await fetchWithTimeout(`${currentApiBase()}/api/admin/backup`, {
    headers: authenticatedHeaders(),
    cache: "no-store",
    credentials: usesNativeCredentialStorage() ? "omit" : "include"
  }, 5 * 60_000);
  if (!response.ok) {
    let message = `Backup export failed: ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.message === "string") message = body.message;
    } catch {
      // Keep the HTTP fallback when the server did not return JSON.
    }
    throw new ApiError(message, response.status);
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1]
    ?? `operalibre-backup-${Date.now()}.json`;
  return { blob: await response.blob(), filename };
}

export async function restoreServerBackup(file: File): Promise<ServerRestoreResult> {
  const response = await fetchWithTimeout(`${currentApiBase()}/api/admin/backup`, {
    method: "POST",
    headers: authenticatedHeaders({ "Content-Type": "application/json" }),
    body: file,
    cache: "no-store",
    credentials: usesNativeCredentialStorage() ? "omit" : "include"
  }, 5 * 60_000);
  if (response.status === 401 && unauthorizedHandler) unauthorizedHandler();
  if (!response.ok) {
    let message = `Backup restore failed: ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.message === "string") message = body.message;
    } catch {
      // Keep the HTTP fallback when the server did not return JSON.
    }
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<ServerRestoreResult>;
}

export async function listUsers() {
  return request<AuthUser[]>("/api/users");
}

export async function createUser(
  username: string,
  password: string,
  isAdmin: boolean,
  allowedBookIds: string[] | null = null,
  isOwner = false,
  libationAccess: LibationAccess = isAdmin ? "direct" : "approval",
  canApproveLibationRequests = false
) {
  return request<AuthUser>("/api/users", {
    method: "POST",
    body: JSON.stringify({
      username,
      password,
      isAdmin,
      isOwner,
      allowedBookIds,
      libationAccess,
      canApproveLibationRequests
    })
  });
}

export async function updateUserRole(userId: string, isAdmin: boolean, isOwner: boolean) {
  return request<AuthUser>(`/api/users/${encodeURIComponent(userId)}/role`, {
    method: "PUT",
    body: JSON.stringify({ isAdmin, isOwner })
  });
}

export async function updateUserLibationApproval(
  userId: string,
  canApproveLibationRequests: boolean
) {
  return request<AuthUser>(`/api/users/${encodeURIComponent(userId)}/libation-approval`, {
    method: "PUT",
    body: JSON.stringify({ canApproveLibationRequests })
  });
}

export async function updateUserBookAccess(userId: string, allowedBookIds: string[] | null) {
  return request<AuthUser>(`/api/users/${encodeURIComponent(userId)}/book-access`, {
    method: "PUT",
    body: JSON.stringify({ allowedBookIds })
  });
}

/**
 * Sharing is reciprocal on the server: turning it off both hides this account
 * from other listeners and hides theirs from this one, so the library must be
 * refetched after a change.
 */
export async function updateProgressSharing(
  shareProgress: boolean,
  finishes?: { announceFinishes?: boolean; notifyFinishes?: boolean }
) {
  return request<AuthUser>("/api/me/progress-sharing", {
    method: "PUT",
    body: JSON.stringify({ shareProgress, ...finishes })
  });
}

/**
 * The shared "who finished what" feed.
 *
 * Backends with no such notion — Jellyfin, demo mode, a device-only library,
 * an OperaLibre server released before the feed — answer with an empty one
 * rather than an error, so the bell simply never appears.
 */
export async function getFinishFeed(): Promise<FinishFeed> {
  if (isDemoMode() || isLocalMode() || getServerType() === "jellyfin") {
    return EMPTY_FINISH_FEED;
  }
  try {
    return await request<FinishFeed>("/api/activity/finishes");
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return EMPTY_FINISH_FEED;
    throw error;
  }
}

export async function markFinishFeedSeen(eventId: string): Promise<FinishFeed> {
  if (isDemoMode() || isLocalMode() || getServerType() === "jellyfin") {
    return EMPTY_FINISH_FEED;
  }
  try {
    return await request<FinishFeed>("/api/activity/finishes/seen", {
      method: "POST",
      body: JSON.stringify({ eventId })
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return EMPTY_FINISH_FEED;
    throw error;
  }
}

const EMPTY_FINISH_FEED: FinishFeed = { entries: [], unseenCount: 0, latestId: null };

export async function updateUserLibationAccess(userId: string, libationAccess: LibationAccess) {
  return request<AuthUser>(`/api/users/${encodeURIComponent(userId)}/libation-access`, {
    method: "PUT",
    body: JSON.stringify({ libationAccess })
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
  if (isDemoMode()) return getDemoBooks();
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

export async function setBookCompletion(
  book: Book,
  finished: boolean,
  finalProgress?: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">
): Promise<BookProgress> {
  if (isDemoMode()) {
    return setDemoBookCompletion(book, finished, finalProgress);
  }
  if (getServerType() === "jellyfin") {
    const token = getStoredToken();
    if (!token) {
      throw new ApiError("Not signed in.", 401);
    }
    return setJellyfinBookCompletion(currentApiBase(), token, book, finished, finalProgress);
  }
  return request<BookProgress>(`/api/books/${encodeURIComponent(book.id)}/completion`, {
    method: "PUT",
    body: JSON.stringify({
      finished,
      ...finalProgress,
      // Only the player reaching the end creates a dated completion. The
      // manual button sends status alone, because it says nothing about when
      // the book was actually read.
      ...(finalProgress ? { tzOffsetMinutes: tzOffsetMinutes() } : {})
    })
  });
}

/**
 * Persist the listener's gain for one book so every device they sign in from
 * plays it at the corrected level. Backends without the endpoint — Jellyfin,
 * demo mode, device-only books, older OperaLibre servers — keep the setting in
 * the caller's local mirror instead of failing the adjustment.
 */
export async function setBookVolume(bookId: string, volumeGain: number): Promise<boolean> {
  if (isDemoMode() || isLocalMode() || getServerType() === "jellyfin") {
    return false;
  }
  try {
    await request<Book>(`/api/books/${encodeURIComponent(bookId)}/volume`, {
      method: "PUT",
      body: JSON.stringify({ volumeGain })
    });
    return true;
  } catch (error) {
    // A server that predates per-book volume answers 404. The local mirror has
    // already applied the change, so this is not worth surfacing as an error.
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}

export async function rescanLibrary() {
  if (getServerType() === "jellyfin") {
    return getBooks();
  }
  return request<Book[]>("/api/library/rescan", { method: "POST" });
}

export async function uploadAudiobook(bookName: string, files: File[]) {
  const body = new FormData();
  body.append("bookName", bookName);
  files.forEach((file) => body.append("files", file, file.name));
  return request<Book[]>(
    "/api/library/upload",
    { method: "POST", body },
    24 * 60 * 60 * 1_000
  );
}

export async function getProgress(bookId: string) {
  if (isDemoMode()) return getDemoProgress(bookId);
  if (getServerType() === "jellyfin") {
    return getCachedJellyfinProgress(bookId);
  }
  return request<Progress | null>(`/api/books/${bookId}/progress`);
}

/**
 * Foreground adoption asks the backend for the truth right now, so it cannot
 * settle for Jellyfin's library-fetch cache the way `getProgress` does — a
 * stale cached copy is exactly the position it is trying to move off.
 */
export async function getFreshProgress(book: Book) {
  if (isDemoMode()) return getDemoProgress(book.id);
  if (getServerType() === "jellyfin") {
    const token = getStoredToken();
    if (!token) {
      throw new ApiError("Not signed in.", 401);
    }
    return refreshJellyfinProgress(currentApiBase(), token, book);
  }
  return request<Progress | null>(`/api/books/${book.id}/progress`);
}

export async function saveProgress(
  bookId: string,
  progress: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">
    & Partial<Pick<Progress, "updatedAt">>,
  options?: {
    isPaused?: boolean;
    intentionalRegression?: boolean;
    intentionalSeek?: boolean;
    signal?: AbortSignal;
  }
) {
  if (isDemoMode()) return saveDemoProgress(bookId, progress);
  if (getServerType() === "jellyfin") {
    const token = getStoredToken();
    if (!token) {
      throw new ApiError("Not signed in.", 401);
    }
    return saveJellyfinProgress(currentApiBase(), token, bookId, progress, options?.isPaused);
  }
  // The server keeps the copy with the newest client timestamp; sending it
  // lets a replayed offline checkpoint be rejected instead of rolling back
  // progress another device saved more recently. intentionalRegression marks
  // a deliberate backwards jump (restart, rewind) — without it the server
  // refuses near-zero writes that would erase substantial progress.
  const { updatedAt, ...fields } = progress;
  return request<Progress>(`/api/books/${bookId}/progress`, {
    method: "PUT",
    signal: options?.signal,
    body: JSON.stringify({
      ...fields,
      ...(updatedAt ? { updatedAtMs: progressTimestamp(updatedAt) } : {}),
      ...(options?.intentionalRegression ? { intentionalRegression: true } : {}),
      ...(options?.intentionalSeek ? { intentionalSeek: true } : {}),
      // Listening is filed under the reader's calendar day. Without this an
      // evening session west of UTC counts towards tomorrow and splits a
      // streak that was never actually broken.
      tzOffsetMinutes: tzOffsetMinutes()
    })
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
      message: "Libation is available only with an OperaLibre server.",
      autoRefreshHours: null,
      manualRefreshesPerHour: 0
    } satisfies LibationStatus;
  }
  return request<LibationStatus>("/api/libation/status");
}

export async function getLibationBooks() {
  return request<LibationBook[]>("/api/libation/books");
}

export async function getLibationAccess() {
  return request<LibationAccessStatus>("/api/libation/access");
}

export async function listLibationRequests() {
  return request<LibationDownloadRequest[]>("/api/libation/requests");
}

export async function requestLibationBook(asin: string, title: string, profileId: string) {
  return request<LibationDownloadRequest>(
    `/api/libation/requests/${encodeURIComponent(asin)}`,
    { method: "POST", body: JSON.stringify({ title, profileId }) }
  );
}

export async function startLibationAccountLogin(input: {
  profileId?: string;
  label: string;
  accountId: string;
  locale: string;
}) {
  return request<LibationLoginStarted>("/api/libation/accounts/login/start", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function completeLibationAccountLogin(sessionId: string, responseUrl: string) {
  return request<LibationStatus>(
    `/api/libation/accounts/login/${encodeURIComponent(sessionId)}/complete`,
    { method: "POST", body: JSON.stringify({ responseUrl }) }
  );
}

export async function cancelLibationAccountLogin(sessionId: string) {
  return request<void>(`/api/libation/accounts/login/${encodeURIComponent(sessionId)}`, {
    method: "DELETE"
  });
}

export async function updateLibationAccount(profileId: string, label: string) {
  return request<LibationStatus>(`/api/libation/accounts/${encodeURIComponent(profileId)}`, {
    method: "PUT",
    body: JSON.stringify({ label })
  });
}

export async function deleteLibationAccount(profileId: string) {
  return request<void>(`/api/libation/accounts/${encodeURIComponent(profileId)}`, {
    method: "DELETE"
  });
}

export async function decideLibationRequest(requestId: string, approved: boolean) {
  return request<LibationDownloadRequest>(
    `/api/libation/requests/${encodeURIComponent(requestId)}/decision`,
    { method: "PUT", body: JSON.stringify({ approved }) }
  );
}

export async function syncLibationLibrary() {
  return request<JobCreated>("/api/libation/sync", { method: "POST" });
}

export async function liberateLibationBook(profileId: string, asin: string) {
  return request<JobCreated>(`/api/libation/accounts/${encodeURIComponent(profileId)}/books/${encodeURIComponent(asin)}/liberate`, {
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

/** "The narrator is reading this sentence at this second": re-times the book's estimated sync map. */
export async function addSyncAnchor(bookId: string, anchor: { href: string; text: string; seconds: number }) {
  return request<SyncAnchorSummary>(`/api/books/${encodeURIComponent(bookId)}/sync/anchors`, {
    method: "POST",
    body: JSON.stringify(anchor)
  });
}

export async function clearSyncAnchors(bookId: string) {
  return request<SyncAnchorSummary>(`/api/books/${encodeURIComponent(bookId)}/sync/anchors`, {
    method: "DELETE"
  });
}

export async function getAlignmentStatus() {
  return request<AlignmentStatus>("/api/alignment/status");
}

export async function getFaststartStatus() {
  return request<FaststartStatus>("/api/library/faststart");
}

export async function startFaststartConversion(options?: {
  bookId?: string;
  includeActive?: boolean;
}) {
  return request<JobCreated>("/api/library/faststart", {
    method: "POST",
    body: JSON.stringify({
      bookId: options?.bookId ?? null,
      includeActive: options?.includeActive ?? false
    })
  });
}

export async function getJob(jobId: string) {
  return request<JobStatus>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export async function listJobs() {
  return request<JobStatus[]>("/api/jobs");
}

function appendMediaToken(path: string) {
  const token = getStoredMediaToken();
  if (!token) {
    return path;
  }
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}token=${encodeURIComponent(token)}`;
}

export function mediaUrl(path: string) {
  if (isDemoMode() && isDemoMediaPath(path)) return demoMediaUrl(path);
  return `${currentApiBase()}${
    getServerType() === "jellyfin"
      ? jellyfinMediaPath(path, getStoredMediaToken())
      : appendMediaToken(path)
  }`;
}

export function bookDownloadUrl(bookId: string) {
  if (isDemoMode()) return "#";
  if (getServerType() === "jellyfin") {
    return mediaUrl(`/Items/${encodeURIComponent(bookId)}/Download`);
  }
  return `${currentApiBase()}${appendMediaToken(`/api/books/${bookId}/download`)}`;
}

export async function deleteDownloadedBook(bookId: string) {
  return request<Book[]>(`/api/books/${encodeURIComponent(bookId)}/download`, {
    method: "DELETE"
  });
}

export function readalongUrl(path: string) {
  if (isDemoMode() && isDemoMediaPath(path)) return demoMediaUrl(path);
  return `${currentApiBase()}${appendMediaToken(path)}`;
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
