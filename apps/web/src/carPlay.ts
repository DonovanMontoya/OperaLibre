import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * The bridge to the CarPlay scene: the snapshot the car reads, the sessions it
 * leaves behind, and which side currently owns the shared native player. The
 * models and the logic over them live in `carLibrary.ts`, which stays free of
 * Capacitor so it can be tested.
 */

export type {
  CarLibraryBook,
  CarLibraryChapter,
  CarLibrarySnapshot,
  CarLibraryTrack,
  CarPlaybackSession
} from "./carLibrary.ts";
import {
  parseCarSessions,
  type CarLibrarySnapshot,
  type CarPlaybackSession
} from "./carLibrary.ts";

export type CarPlayState = {
  connected: boolean;
  /** Set while a book the car itself started is loaded in the native player. */
  carOwnedBookId: string | null;
  sessions: CarPlaybackSession[];
};

interface CarPlayBridgePlugin {
  /**
   * Both payloads cross the bridge as JSON strings. They are nested structures
   * full of optional numbers, and one model on each side is far easier to keep
   * honest than hand-walking dictionaries through the bridge.
   */
  setLibrary(options: { snapshot: string }): Promise<void>;
  getState(): Promise<{ connected: boolean; carOwnedBookId?: string; sessions: string }>;
  acknowledgeSessions(options: {
    sessions: Array<{ bookId: string; updatedAt: number }>;
  }): Promise<void>;
  addListener(
    eventName: "carPlaybackStarted",
    listener: (event: { bookId: string; trackId: string; bookPositionSeconds: number }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "carPlaybackEnded",
    listener: (event: { bookId: string }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "carConnected" | "carDisconnected",
    listener: () => void
  ): Promise<PluginListenerHandle>;
}
const CarPlayBridge = registerPlugin<CarPlayBridgePlugin>("CarPlayBridge");

export function supportsCarPlay() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

/**
 * Mirrors the native side's `carOwnedBookId`.
 *
 * While the car owns playback the web player must keep its hands off the
 * engine: its detach runs a `stop()` that would cut the driver off mid-sentence.
 */
let carOwnedBookId: string | null = null;

export function carPlaybackOwnsEngine() {
  return carOwnedBookId !== null;
}

export function carPlaybackBookId() {
  return carOwnedBookId;
}

/** Called from the native events and from the state read on resume. */
export function setCarPlaybackOwner(bookId: string | null) {
  carOwnedBookId = bookId;
}

/**
 * The app is about to drive the player itself. Ownership is dropped before the
 * load rather than after, so the attach that follows is not mistaken for the
 * car's and left to skip its own teardown.
 */
export function releaseCarPlaybackOwnership() {
  carOwnedBookId = null;
}

export async function syncCarLibrary(snapshot: CarLibrarySnapshot) {
  if (!supportsCarPlay()) return;
  await CarPlayBridge.setLibrary({ snapshot: JSON.stringify(snapshot) });
}

export async function getCarPlayState(): Promise<CarPlayState> {
  if (!supportsCarPlay()) {
    return { connected: false, carOwnedBookId: null, sessions: [] };
  }
  const state = await CarPlayBridge.getState();
  return {
    connected: !!state.connected,
    carOwnedBookId: state.carOwnedBookId ?? null,
    sessions: parseCarSessions(state.sessions)
  };
}

export async function acknowledgeCarSessions(sessions: CarPlaybackSession[]) {
  if (!supportsCarPlay() || sessions.length === 0) return;
  await CarPlayBridge.acknowledgeSessions({
    sessions: sessions.map(({ bookId, updatedAt }) => ({ bookId, updatedAt }))
  });
}

export function addCarPlayListener(
  event: "carPlaybackStarted",
  listener: (event: { bookId: string; trackId: string; bookPositionSeconds: number }) => void
): Promise<PluginListenerHandle | null>;
export function addCarPlayListener(
  event: "carPlaybackEnded",
  listener: (event: { bookId: string }) => void
): Promise<PluginListenerHandle | null>;
export function addCarPlayListener(
  event: "carConnected" | "carDisconnected",
  listener: () => void
): Promise<PluginListenerHandle | null>;
export function addCarPlayListener(
  event: "carPlaybackStarted" | "carPlaybackEnded" | "carConnected" | "carDisconnected",
  // The overloads above are what callers see; this signature only has to accept
  // all of them.
  listener: (event: never) => void
): Promise<PluginListenerHandle | null> {
  if (!supportsCarPlay()) return Promise.resolve(null);
  return (CarPlayBridge.addListener as (
    name: typeof event,
    handler: (event: never) => void
  ) => Promise<PluginListenerHandle>)(event, listener).catch(() => null);
}
