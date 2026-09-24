import { progressTimestamp } from "./reliability";
import { getServerUrl } from "./api";
import type { Book, LibationStatus, Track } from "./types";

export function formatTime(value: number | null | undefined) {
  if (!Number.isFinite(value ?? NaN)) {
    return "--:--";
  }

  const totalSeconds = Math.max(0, Math.floor(value ?? 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function formatLibationMessage(status: LibationStatus | null): string | null {
  const rawMessage = status?.message?.trim();
  if (!rawMessage) {
    return null;
  }

  if (/Cannot find settings files at/i.test(rawMessage)) {
    const serverUrl = getServerUrl();
    const configuredPath = status?.libationFilesDir ? `\`${status.libationFilesDir}\`` : "`libation_files_dir`";
    return `The connected OperaLibre server at ${serverUrl} cannot read Libation's settings files. Configure ${configuredPath} on the server to point at the LibationFiles folder that contains AccountsSettings.json and Settings.json, then restart the server.`;
  }

  return rawMessage;
}

export function bookSubtitle(book: Book) {
  return [book.author, book.narrator ? `Narrated by ${book.narrator}` : null]
    .filter(Boolean)
    .join(" • ");
}

export function currentTrackIndex(book: Book | null, track: Track | null) {
  if (!book || !track) {
    return 0;
  }
  return Math.max(0, book.tracks.findIndex((candidate) => candidate.id === track.id));
}

export function trackOffsetSeconds(book: Book, trackIndex: number) {
  return book.tracks
    .slice(0, Math.max(0, trackIndex))
    .reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
}

export function durationFromTracks(book: Book) {
  return book.tracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
}

export function formatMinutes(minutes: number | null | undefined) {
  if (!Number.isFinite(minutes ?? NaN)) {
    return "Unknown length";
  }
  const totalMinutes = Math.max(0, Math.round(minutes ?? 0));
  const hours = Math.floor(totalMinutes / 60);
  const remainder = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
}

export function formatElapsed(startedAt: string | null | undefined, finishedAt?: string | null) {
  if (!startedAt) {
    return null;
  }
  const start = progressTimestamp(startedAt);
  const end = finishedAt ? progressTimestamp(finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return formatDurationLabel((end - start) / 1000);
}

export function formatDurationLabel(seconds: number | null | undefined) {
  if (!Number.isFinite(seconds ?? NaN)) {
    return null;
  }
  const totalMinutes = Math.max(0, Math.ceil((seconds ?? 0) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${Math.max(1, minutes)}m`;
}

export function bookProgressLabel(book: Book) {
  if (!book.progress || book.progress.status === "notStarted") {
    return "Not started";
  }
  if (book.progress.status === "finished") {
    return "Finished";
  }
  if (
    book.progress.status === "inProgress"
    && (book.progress.remainingSeconds ?? 1) <= 0
  ) {
    return "In progress";
  }
  const remaining = formatDurationLabel(book.progress.remainingSeconds);
  if (remaining) {
    return `${remaining} left`;
  }
  if (book.progress.status === "inProgress") {
    return "In progress";
  }
  return "Not started";
}
