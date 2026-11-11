/**
 * The server measures each book's loudness and suggests a gain for books
 * mastered far from a comfortable speech level. The server resolves which gain
 * plays (`volumeGain`); this module predicts that answer for an immediate
 * response to the listener's switch, and describes it for the player.
 */
import { BOOK_GAIN_DEFAULT, bookGainToDb, formatBookGainDb, normalizeBookGain } from "./bookVolume.ts";
import type { AudioAnalysis, Book, VolumeGainSource } from "./types.ts";

export type BookVolumeState = {
  volumeGain: number;
  volumeGainSource: VolumeGainSource;
  autoVolume: boolean;
};

/** Mirrors the server: the listener's own level always wins. */
export function resolveBookGain({
  manualGain,
  autoVolume,
  suggestedGain
}: {
  manualGain: number | null;
  autoVolume: boolean;
  suggestedGain: number | null;
}): BookVolumeState {
  if (manualGain !== null) {
    return { volumeGain: normalizeBookGain(manualGain), volumeGainSource: "manual", autoVolume };
  }
  if (autoVolume && suggestedGain !== null && suggestedGain !== BOOK_GAIN_DEFAULT) {
    return { volumeGain: normalizeBookGain(suggestedGain), volumeGainSource: "auto", autoVolume };
  }
  return { volumeGain: BOOK_GAIN_DEFAULT, volumeGainSource: "default", autoVolume };
}

function suggestedGainOf(book: Book) {
  return book.audioAnalysis ? normalizeBookGain(book.audioAnalysis.suggestedGain) : null;
}

/**
 * What the server will answer when the switch changes. Turning it on clears
 * the listener's own level; turning it off keeps one if they had it.
 */
export function withAutoVolume(book: Book, enabled: boolean): BookVolumeState {
  const manualGain = !enabled && book.volumeGainSource === "manual"
    ? book.volumeGain ?? BOOK_GAIN_DEFAULT
    : null;
  return resolveBookGain({ manualGain, autoVolume: enabled, suggestedGain: suggestedGainOf(book) });
}

export type AutoVolumeStatus =
  | { kind: "none" }
  | { kind: "adjusted" | "off" | "overridden"; suggestedGain: number };

export function autoVolumeStatus(book: Book): AutoVolumeStatus {
  const suggestedGain = suggestedGainOf(book);
  if (suggestedGain === null || suggestedGain === BOOK_GAIN_DEFAULT) return { kind: "none" };
  if (book.volumeGainSource === "auto") return { kind: "adjusted", suggestedGain };
  if (book.volumeGainSource === "manual") return { kind: "overridden", suggestedGain };
  return { kind: "off", suggestedGain };
}

export function describeAutoVolume(status: AutoVolumeStatus): string | null {
  if (status.kind === "none") return null;
  const amount = formatBookGainDb(bookGainToDb(status.suggestedGain));
  switch (status.kind) {
    case "adjusted":
      return `Playing ${amount} to bring this book to a typical speech level.`;
    case "off":
      return `Off for this book. Turn on to play it at ${amount}.`;
    case "overridden":
      return `Your own level is in use. Turn on to use the suggested ${amount}.`;
  }
}

/** Problems found in the mastering that no setting here fixes yet. */
export function audioIssues(analysis: AudioAnalysis | undefined): string[] {
  if (!analysis) return [];
  const issues: string[] = [];
  if (analysis.flags.includes("inconsistent") && analysis.trackSpreadLu !== undefined) {
    issues.push(`Loudness varies by ${Math.round(analysis.trackSpreadLu)} dB between tracks.`);
  }
  if (analysis.flags.includes("lopsided") && analysis.louderChannel) {
    const side = analysis.louderChannel;
    issues.push(
      (analysis.channelImbalanceDb ?? 0) >= 60
        ? `The audio is on the ${side} channel only.`
        : `The ${side} channel is ${Math.round(analysis.channelImbalanceDb ?? 0)} dB louder.`
    );
  }
  return issues;
}

/**
 * Runs tasks one at a time per key, in the order they were asked for. A
 * book's manual level and its automatic switch go through the same queue, so
 * an older request can never land on the server after a newer one.
 */
export function createKeyedQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = result.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}
