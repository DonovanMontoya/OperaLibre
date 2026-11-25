import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * The bridge to the CarPlay scene: the snapshot the car reads, the sessions it
 * leaves behind, and which side currently owns the shared native player. The
 * models and the logic over them live in `carLibrary.ts`, which stays free of
 * Capacitor so it can be tested.
 */

import {
  CarLibraryAccess,
  parseCarSessions,
  type CarLibrarySnapshot,
  type CarPlaybackSession
} from "./carLibrary.ts";


type CarPlayState = {
  connected: boolean;
  /** Set while a book the car itself started is loaded in the native player. */
  carOwnedBookId: string | null;
  sessions: CarPlaybackSession[];
};

type CarEvents = {
  widgetResumeRequested: Record<string, never>;
  carPlaybackStarted: { bookId: string; trackId: string; bookPositionSeconds: number };
  carPlaybackEnded: { bookId: string };
  carDisconnected: Record<string, never>;
};

interface CarPlayBridgePlugin {
  /**
   * Both payloads cross the bridge as JSON strings. They are nested structures
   * full of optional numbers, and one model on each side is far easier to keep
   * honest than hand-walking dictionaries through the bridge.
   */
  setLibrary(options: { snapshot: string }): Promise<void>;
  takeWidgetResume(options: { scope: string }): Promise<{ bookId?: string } | undefined>;
  setReadingStreakScope(options: { scope: string }): Promise<void>;
  clearLibrary(): Promise<void>;
  stopPlayback(options: { bookId: string }): Promise<{ connected: boolean; carOwnedBookId?: string; sessions: string }>;
  getState(): Promise<{ connected: boolean; carOwnedBookId?: string; sessions: string }>;
  acknowledgeSessions(options: {
    sessions: Array<{ bookId: string; updatedAt: number }>;
  }): Promise<void>;
  addListener<E extends keyof CarEvents>(event: E, listener: (event: CarEvents[E]) => void): Promise<PluginListenerHandle>;
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

const libraryAccess = new CarLibraryAccess();

export function beginCarLibrarySession(scope: string) {
  libraryAccess.begin(scope);
  if (supportsCarPlay()) void CarPlayBridge.setReadingStreakScope({ scope }).catch(console.error);
}

export async function clearCarLibrary() {
  libraryAccess.end();
  releaseCarPlaybackOwnership();
  if (supportsCarPlay()) await CarPlayBridge.clearLibrary();
}

export function watchWidgetResume(scope: string, resume: (id: string) => void) {
  let active = true;
  let listener: PluginListenerHandle | undefined;
  const receive = async () => {
    if (!active || !libraryAccess.allows(scope)) return;
    const result = await CarPlayBridge.takeWidgetResume({ scope });
    if (active && result?.bookId && libraryAccess.allows(scope)) resume(result.bookId);
  };
  void CarPlayBridge.addListener("widgetResumeRequested", () => { void receive().catch(console.error); })
    .then(async handle => {
      if (!active) { await handle.remove(); return; }
      listener = handle;
      await receive();
    }).catch(console.error);
  return () => { active = false; void listener?.remove(); };
}

export async function syncCarLibrary(snapshot: CarLibrarySnapshot) {
  if (!supportsCarPlay() || !libraryAccess.allows(snapshot.scopePrefix)) return;
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

/** Native ownership is authoritative, even before the web layer receives its events. */
export async function stopCarPlayback(bookId: string): Promise<CarPlayState> {
  const state = await CarPlayBridge.stopPlayback({ bookId });
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

export function addCarPlayListener<E extends keyof CarEvents>(
  event: E, listener: (event: CarEvents[E]) => void
): Promise<PluginListenerHandle | null> {
  if (!supportsCarPlay()) return Promise.resolve(null);
  return CarPlayBridge.addListener(event, listener).catch(() => null);
}
