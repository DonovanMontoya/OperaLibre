import { Capacitor, registerPlugin } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { enqueueLibroDeviceDownload, getBackgroundBookDownloadStatus, cancelBackgroundBookDownload } from "./backgroundDownloads";
import { getDeviceBooks, importDeviceAudioFiles } from "./localLibrary";
import { libroDownloadURL, libroPage } from "./libroDevicePolicy";
import type { JobStatus, LibroAccountStatus } from "./types";

interface DevicePlugin {
  request(options: { action: string; email?: string; password?: string; page?: number; isbn?: string; folder?: string }): Promise<Record<string, unknown>>;
}
const Native = registerPlugin<DevicePlugin>("LibroDevice");
const CACHE = "operalibre.libroDevice.catalog.v1";
const JOBS = "operalibre.libroDevice.jobs.v1";
type Purchase = LibroAccountStatus["books"][number];
type Pending = { job: JobStatus; book: Purchase; folder: string };
type Catalog = { email: string; books: Purchase[]; syncedAt: string | null };
const read = <T>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
};
const write = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
const active = (item: Pending) => ["queued", "running"].includes(item.job.status);
let refresh: Promise<void> | null = null;
let reconcile: Promise<void> | null = null;
let starting = false;

export const supportsLibroDevice = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("LibroDevice");

export async function cancelLibroDevice(isbn: string) {
  if (reconcile) await reconcile;
  const pending = read<Pending[]>(JOBS, []);
  const item = pending.find(item => item.book.isbn === isbn && active(item));
  if (!item) return;
  // Mark it terminal before yielding so polling cannot publish a cancelled book.
  item.job.status = "failed";
  item.job.error = "Download cancelled. You can retry it.";
  write(JOBS, pending);
  await cancelBackgroundBookDownload(item.job.id);
  await Filesystem.rmdir({ path: `offline-media/${item.folder}`, directory: Directory.Data, recursive: true }).catch(() => undefined);
}

export async function connectLibroDevice(email: string, password: string) {
  if (read<Pending[]>(JOBS, []).some(active) || starting || refresh) throw new Error("Wait for the current device operation to finish.");
  await Native.request({ action: "connect", email, password });
  write(CACHE, { email: email.trim(), books: [], syncedAt: null });
  await refreshLibroDevice();
}

export async function disconnectLibroDevice() {
  if (read<Pending[]>(JOBS, []).some(active) || starting || refresh) throw new Error("Wait for the current device operation to finish.");
  await Native.request({ action: "disconnect" });
  localStorage.removeItem(CACHE);
  // Completed files remain in the local library; only connection history is removed.
  localStorage.removeItem(JOBS);
}

export function refreshLibroDevice(): Promise<void> {
  if (refresh) return refresh;
  refresh = (async () => {
    const connection = await Native.request({ action: "status" });
    if (!connection.connected) throw new Error("Connect your device account first.");
    const books = new Map<string, Purchase>();
    let bytes = 0;
    for (let page = 1; page <= 200; page++) {
      const raw = await Native.request({ action: "page", page });
      bytes += JSON.stringify(raw).length;
      if (bytes > 32 * 1024 * 1024) throw new Error("This catalog exceeds the supported size.");
      const result = libroPage(raw);
      for (const book of result.books) books.set(book.isbn, book);
      if (books.size > 20000) throw new Error("This catalog has too many books.");
      if (page >= result.pages) {
        write(CACHE, { email: connection.email, books: [...books.values()], syncedAt: String(Date.now()) });
        return;
      }
    }
  })().finally(() => { refresh = null; });
  return refresh;
}

async function settleDownloads() {
  const pending = read<Pending[]>(JOBS, []);
  for (const item of pending.filter(active)) {
    try {
      const status = await getBackgroundBookDownloadStatus(item.job.id);
      item.job.status = status.state;
      item.job.progress = { step: `Downloading to this device · ${Math.round(status.fraction * 100)}%`, fraction: status.fraction, completed: null, total: null };
      if (status.state === "failed") item.job.error = status.error ?? "Download failed. Retry to get a fresh download link.";
      if (status.state === "completed") {
        // Publication runs on foreground recovery as well as ordinary completion.
        item.job.status = "running";
        item.job.progress = { step: "Adding to your device library", fraction: null, completed: null, total: null };
        write(JOBS, pending);
        const existing = getDeviceBooks().find(book => book.id === `device:libro:${item.book.isbn}`);
        if (!existing) {
          const extracted = await Native.request({ action: "extract", folder: item.folder });
          const files = extracted.files as { name: string; path: string }[];
          if (!Array.isArray(files) || !files.length) throw new Error("No audio was downloaded.");
          // Copying into the durable device library temporarily needs a second audio-sized allocation.
          await importDeviceAudioFiles(files, undefined, { isbn: item.book.isbn, title: item.book.title,
            author: item.book.authors.join(", "), narrator: item.book.audiobook_info.narrators.join(", ") });
        }
        item.job.status = "completed";
        item.job.finishedAt = String(Date.now());
        write(JOBS, pending);
        await Filesystem.rmdir({ path: `offline-media/${item.folder}`, directory: Directory.Data, recursive: true }).catch(() => undefined);
      }
    } catch (error) {
      item.job.status = "failed";
      item.job.error = error instanceof Error ? error.message : "Device import failed. Retry the book.";
    }
    write(JOBS, pending);
  }
}

export async function getLibroDevice(): Promise<LibroAccountStatus> {
  // One reconciler prevents two mounted catalog screens from extracting/publishing twice.
  if (!reconcile && !starting) reconcile = settleDownloads().finally(() => { reconcile = null; });
  await reconcile;
  const connection = await Native.request({ action: "status" });
  const catalog = read<Catalog>(CACHE, { email: "", books: [], syncedAt: null });
  const local = new Set(getDeviceBooks().map(book => book.id));
  const matching = connection.connected && connection.email === catalog.email;
  return { connected: !!connection.connected, email: typeof connection.email === "string" ? connection.email : null,
    syncedAt: matching ? catalog.syncedAt : null,
    books: matching ? catalog.books.map(book => ({ ...book, localBookId: local.has(`device:libro:${book.isbn}`) ? `device:libro:${book.isbn}` : null })) : [],
    jobs: read<Pending[]>(JOBS, []).map(item => item.job).reverse() };
}

export async function importLibroDevice(isbn: string) {
  if (starting || read<Pending[]>(JOBS, []).some(active)) throw new Error("Wait for your current device download to finish.");
  starting = true;
  try {
    const catalog = read<Catalog>(CACHE, { email: "", books: [], syncedAt: null });
    const connection = await Native.request({ action: "status" });
    const book = catalog.books.find(book => book.isbn === isbn);
    if (!connection.connected || connection.email !== catalog.email || !book) throw new Error("Refresh your device purchase list first.");
    if (getDeviceBooks().some(book => book.id === `device:libro:${isbn}`)) return;
    const old = read<Pending[]>(JOBS, []);
    for (const item of old.filter(item => item.book.isbn === isbn && item.job.status === "failed")) {
      await cancelBackgroundBookDownload(item.job.id);
      await Filesystem.rmdir({ path: `offline-media/${item.folder}`, directory: Directory.Data, recursive: true }).catch(() => undefined);
    }
    const m4b = await Native.request({ action: "m4b", isbn });
    const hasM4b = typeof m4b.m4b_url === "string" && m4b.m4b_url.length > 0;
    const urls: string[] = [];
    if (hasM4b) urls.push(libroDownloadURL(m4b.m4b_url));
    else {
      const manifest = await Native.request({ action: "manifest", isbn });
      const parts = manifest.parts as { url: string }[];
      if (!Array.isArray(parts) || !parts.length || parts.length > 100) throw new Error("Libro.fm did not provide downloadable audio.");
      for (const part of parts) urls.push(libroDownloadURL(part.url));
    }
    const folder = `libro-${crypto.randomUUID()}`;
    const job: JobStatus = { id: folder, kind: "libro-download", targetId: `device:${isbn}`, status: "queued",
      startedAt: String(Date.now()), finishedAt: null, exitCode: null, output: "", error: null };
    const files = await Promise.all(urls.map(async (url, index) => ({ url,
      path: (await Filesystem.getUri({ path: `offline-media/${folder}/part-${String(index).padStart(3, "0")}.${hasM4b ? "m4b" : "zip"}`, directory: Directory.Data })).uri,
      label: `Part ${index + 1}`, required: true })));
    const pending = [...old.filter(item => item.book.isbn !== isbn).slice(-19), { job, book, folder }];
    write(JOBS, pending);
    try { await enqueueLibroDeviceDownload(job.id, book.title, files); }
    catch (error) { job.status = "failed"; job.error = "Could not queue device download. Retry the book."; write(JOBS, pending); throw error; }
  } finally { starting = false; }
}

export const libroDeviceBackend = { status: getLibroDevice, connect: connectLibroDevice, disconnect: disconnectLibroDevice,
  refresh: refreshLibroDevice, import: importLibroDevice, books: async () => getDeviceBooks() };
