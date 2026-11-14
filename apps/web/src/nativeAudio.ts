import { NativeAudioControlClock } from "./nativeAudioClock";
import { applyNativePlaybackSettings, nativeLoadShouldAutoplay, nativeStartupPosition, startAfterListeners } from "./nativeAudioStartup";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { carPlaybackOwnsEngine } from "./carPlay";
import {
  NativeAudioStateSynchronizer,
  refreshDeclinedTrackChange,
  type NativeAudioTrackChange
} from "./nativeAudioState";

type NativeAudioState = {
  positionSeconds: number;
  durationSeconds: number;
  isPlaying: boolean;
  readyToPlay: boolean;
  positionReady?: boolean;
  clipPreview?: boolean;
  /** The queue track the clock belongs to, once the native side reports it. */
  trackId?: string;
};

type NativeAudioRecoveryState = {
  trackId: string;
  positionSeconds: number;
  bookPositionSeconds: number;
  durationSeconds?: number;
  updatedAt: number;
};

export type NativeAudioQueueTrack = {
  url: string;
  trackId: string;
  bookOffsetSeconds: number;
  title: string;
  artist: string;
  album: string;
  chapters: Array<{
    title: string;
    startSeconds: number;
    durationSeconds: number;
  }>;
};

/** A player that kept running through a WebView reload, as the page takes it over. */
type NativeAudioAdoptedSession = {
  positionSeconds: number;
  sleepTimerSeconds: number;
  sleepAtChapterEnd: boolean;
};

type NativeAudioRecoveryIdentity = {
  source: string;
  clipPreview?: () => boolean;
  awaitingReturn?: () => boolean;
  allowAdoption?: boolean;
  /** A non-preview seek is ready and its native recovery checkpoint is durable. */
  normalPositionReady?: (positionSeconds: number) => boolean | void;
  settings: () => { rate: number; volume: number };
  scopeKey: string;
  trackId: string;
  bookOffsetSeconds: number;
  queue: () => NativeAudioQueueTrack[];
  pendingPosition: () => number | undefined;
  /** Whether a Play request is still waiting for this native load. */
  wantsPlayback: () => boolean;
  /**
   * Read at load time rather than captured: the attachment effect runs before
   * the effect that syncs the gain, so a value captured at attach would be the
   * previous book's and the first seconds would play at the wrong level.
   */
  gain: () => number;
  /**
   * Native `stop()` disarms its sleep timer so a countdown can never outlive
   * the session that armed it — but the attachment cleanup also calls stop()
   * on every track change, so each attach re-arms the timer from the seconds
   * React still holds.
   */
  sleepTimerSeconds: () => number;
  sleepAtChapterEnd: () => boolean;
  /**
   * The page's first attachment took over a player that was already playing
   * this track. React must drop the pending seek it restored (the native
   * clock is newer) and show the native sleep timer before the first state tick.
   */
  adopted: (session: NativeAudioAdoptedSession) => void;
};

interface NativeAudioPlugin {
  load(options: {
    url: string;
    positionSeconds: number;
    rate: number;
    volume: number;
    gain: number;
    autoplay: boolean;
    clipPreview?: boolean;
    recoveryScopeKey: string;
    recoveryTrackId: string;
    recoveryBookOffsetSeconds: number;
    queue: NativeAudioQueueTrack[];
  }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { positionSeconds: number; clipPreview?: boolean }): Promise<void>;
  setRate(options: { rate: number }): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;
  setGain(options: { gain: number }): Promise<void>;
  setSleepTimer(options: { seconds: number; atChapterEnd?: boolean }): Promise<void>;
  getSleepTimer(): Promise<{ remainingSeconds: number }>;
  setNowPlaying(options: {
    title: string;
    artist: string;
    album: string;
    artworkUrl?: string;
    chapterStartSeconds?: number;
    chapterDurationSeconds?: number;
    chapters: Array<{
      title: string;
      startSeconds: number;
      durationSeconds: number;
    }>;
  }): Promise<void>;
  getRecoveryState(options: { scopeKey: string }): Promise<Partial<NativeAudioRecoveryState>>;
  getAdoptableSession(options: {
    scopeKey: string;
    trackId: string;
    url: string;
  }): Promise<Partial<NativeAudioAdoptedSession>>;
  /**
   * Tears the player down. `releaseSession` (default true) also gives up the
   * audio session so other apps' audio can resume; the attach cleanup passes
   * false because a track change re-attaches moments later and a released
   * session would hand the lock screen to whatever was playing before.
   */
  stop(options?: { releaseSession?: boolean }): Promise<void>;
  addListener(eventName: "state", listener: (state: NativeAudioState) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "ended", listener: (state: Partial<NativeAudioState>) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "sleepTimerEnded", listener: () => void): Promise<PluginListenerHandle>;
  addListener(
    eventName: "trackChanged",
    listener: (event: {
      trackId: string;
      positionSeconds: number;
      bookPositionSeconds: number;
      isPlaying: boolean;
      clipPreview?: boolean;
    }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "intentionalSeek",
    listener: (event: { positionSeconds: number }) => void
  ): Promise<PluginListenerHandle>;
  addListener(eventName: "error", listener: (event: { message: string }) => void): Promise<PluginListenerHandle>;
}

const NativeAudio = registerPlugin<NativeAudioPlugin>("NativeAudio");

/**
 * iOS may discard the WebView's content process during a long background
 * listen while AVPlayer plays on, and Capacitor then reloads the page. Only
 * the first attachment of a page can find a player it did not load, so only
 * it asks whether to take that player over rather than load the book again.
 */
let firstAttachmentOfPage = true;

async function adoptableNativeSession(
  scopeKey: string,
  trackId: string,
  url: string
): Promise<NativeAudioAdoptedSession | null> {
  // Any failure to answer means loading as usual; the page must never be
  // left waiting on this question with nothing loaded.
  const session: Partial<NativeAudioAdoptedSession> = await NativeAudio.getAdoptableSession({ scopeKey, trackId, url })
    .then((answer) => answer ?? {}, () => ({}));
  return Number.isFinite(session.positionSeconds)
    ? {
        positionSeconds: session.positionSeconds!,
        sleepTimerSeconds: Number.isFinite(session.sleepTimerSeconds) ? Math.max(0, session.sleepTimerSeconds!) : 0,
        sleepAtChapterEnd: session.sleepAtChapterEnd === true
      }
    : null;
}

/**
 * Where each control element's last attachment left AVPlayer. The clock dies
 * on detach and the bare element it leaves behind reads 0:00, so a queue
 * rebuild for the same track after restore (the download scan or the media
 * credential landing late) would otherwise reload at the opening credits.
 */
const detachedClocks = new WeakMap<
  HTMLAudioElement,
  { scopeKey: string; trackId: string; positionSeconds: number }
>();

/** CarPlay kept playing past this element's clock; its checkpoint owns the resume. */
export function forgetDetachedNativeClock(audio: HTMLAudioElement) {
  detachedClocks.delete(audio);
}

/**
 * Tearing the player down is the app's to do only while the app is the one
 * playing. The native player is shared with CarPlay, and a stop() from a web
 * detach — a track change, a closed player, a reload — would cut off a book the
 * driver started. The car hands the engine back when the app takes it over.
 */
function stopNativeUnlessCarOwns(options?: { releaseSession?: boolean }) {
  if (carPlaybackOwnsEngine()) return Promise.resolve();
  return NativeAudio.stop(options).catch(() => undefined);
}

/**
 * `volume` stays the device level; this is the multiplier AVPlayer applies on
 * top of it, for the book currently loaded.
 */
export function setNativeAudioGain(gain: number) {
  if (!usesNativeAudioPlayer()) return Promise.resolve();
  return NativeAudio.setGain({ gain });
}

export function usesNativeAudioPlayer() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

/**
 * Gives the audio session up once the player has closed for good. The
 * attach cleanup never releases it (a track change re-attaches at once), so
 * the app calls this when a session ends with nothing to follow.
 */
export function releaseNativeAudioSession() {
  if (!usesNativeAudioPlayer()) return Promise.resolve();
  return stopNativeUnlessCarOwns({ releaseSession: true });
}

export function updateNativeAudioNowPlaying(options: {
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
  chapterStartSeconds?: number;
  chapterDurationSeconds?: number;
  chapters: Array<{
    title: string;
    startSeconds: number;
    durationSeconds: number;
  }>;
}) {
  if (!usesNativeAudioPlayer()) return Promise.resolve();
  return NativeAudio.setNowPlaying(options);
}

export function playNativeAudio() {
  return NativeAudio.play();
}

export function pauseNativeAudio() {
  return NativeAudio.pause();
}

/**
 * `atChapterEnd` stops at the end of the chapter being played instead of
 * after a countdown. AVPlayer watches for it itself, so the stop still lands
 * on the boundary while the WebView is suspended.
 */
export function setNativeAudioSleepTimer(seconds: number, atChapterEnd = false) {
  if (!usesNativeAudioPlayer()) return Promise.resolve();
  return NativeAudio.setSleepTimer({ seconds: Math.max(0, seconds), atChapterEnd });
}

/**
 * AVPlayer's countdown only advances during playback, while the web timer is
 * wall-clock, so after any pause the app did not observe (lock screen,
 * interruption) the native value is the authoritative one.
 */
export function getNativeAudioSleepTimer(): Promise<number> {
  if (!usesNativeAudioPlayer()) return Promise.resolve(0);
  return NativeAudio.getSleepTimer().then((result) => Math.max(0, result.remainingSeconds));
}

export function seekNativeAudio(positionSeconds: number, clipPreview = false) {
  return NativeAudio.seek({ positionSeconds, clipPreview });
}

export async function getNativeAudioRecovery(scopeKey: string): Promise<NativeAudioRecoveryState | null> {
  if (!usesNativeAudioPlayer()) return null;
  const state = await NativeAudio.getRecoveryState({ scopeKey });
  return typeof state.trackId === "string"
    && Number.isFinite(state.positionSeconds)
    && Number.isFinite(state.bookPositionSeconds)
    && Number.isFinite(state.updatedAt)
    ? state as NativeAudioRecoveryState
    : null;
}

/**
 * Keep the existing HTML media element as OperaLibre's control/UI clock, but
 * make AVPlayer the only audible engine on iOS. This preserves the mature web
 * player behavior while AVFoundation supplies its voice-specific time/pitch
 * processing for accelerated playback.
 */
export function attachNativeAudioPlayer(
  audio: HTMLAudioElement,
  onError: (message: string) => void,
  onFallback: (position: number, resume: boolean) => void,
  recovery: NativeAudioRecoveryIdentity,
  /** Returns false when React declined the change and still owns this track. */
  onTrackChanged: (
    trackId: string,
    positionSeconds: number,
    bookPositionSeconds: number,
    isPlaying: boolean
  ) => boolean | void,
  onIntentionalSeek: () => void,
  onSleepTimerEnded: () => void,
  onStateSynchronized: () => void
) {
  if (!usesNativeAudioPlayer()) return () => undefined;

  const detached = detachedClocks.get(audio);
  detachedClocks.delete(audio);
  // A pending seek still wins; the carried clock only replaces the bare 0:00.
  const resumePosition = detached
    && detached.scopeKey === recovery.scopeKey
    && detached.trackId === recovery.trackId
    && Number.isFinite(detached.positionSeconds)
    ? detached.positionSeconds
    : undefined;
  const controlClock = new NativeAudioControlClock(
    audio,
    recovery.source,
    nativeStartupPosition(recovery.pendingPosition() ?? resumePosition, audio.currentTime)
  );
  let disposed = false;
  let endedFromNative = false;
  let nativeIsPlaying = false;
  let fellBack = false;
  // Whether this attachment loaded or took over the engine, so its cleanup
  // tears down only a player it owns. One disposed while still deciding must
  // not stop the player the next attachment is about to take over.
  let engaged = false;
  const askToAdopt = firstAttachmentOfPage && recovery.allowAdoption !== false;
  // Until the decision, AVPlayer's ticks belong to a player this page has not
  // claimed; applying one would announce metadata and let React's restored
  // pending seek drag the live player back.
  let deciding = true;
  let loadingPosition: number | null = null;
  let normalPositionReported = false;
  // The queue track AVPlayer is on, as far as this attachment knows. After an
  // accepted trackChanged, React remounts the media element and re-attaches
  // for the new track; until then this element still represents the previous
  // file, and a trailing `state` tick from the new one must not seek it.
  let activeNativeTrackId = recovery.trackId;
  // The last trackChanged React declined. Swift has already moved its
  // recovery track to that item and stamps every state payload with it, so
  // until React accepts the change every tick would be dropped below and the
  // UI clock would freeze while native audio plays on. Nothing re-emits
  // trackChanged when startup becomes ready; the tick re-offers it instead.
  let declinedTrackChange: NativeAudioTrackChange | null = null;
  const listenerHandles: PluginListenerHandle[] = [];
  const nativeStateSynchronizer = new NativeAudioStateSynchronizer(audio, onStateSynchronized);

  const offerTrackChange = (change: NativeAudioTrackChange) => {
    const accepted = onTrackChanged(
      change.trackId,
      change.positionSeconds,
      change.bookPositionSeconds,
      change.isPlaying
    ) !== false;
    if (accepted) {
      activeNativeTrackId = change.trackId;
      declinedTrackChange = null;
    } else {
      declinedTrackChange = change;
    }
    return accepted;
  };

  const failOverToWebAudio = (message: string) => {
    if (disposed || fellBack) return;
    fellBack = true;
    nativeStateSynchronizer.clear();
    const shouldResume = nativeIsPlaying || recovery.wantsPlayback();
    const position = nativeStartupPosition(recovery.pendingPosition(), audio.currentTime);
    controlClock.destroy();
    audio.muted = false;
    onError(message);
    onFallback(position, shouldResume);
    void stopNativeUnlessCarOwns();

  };

  const safely = (operation: Promise<void>) => {
    void operation.catch((error) => {
      const message = error instanceof Error ? error.message : "Native audio playback failed.";
      failOverToWebAudio(message);
    });
  };

  // Capacitor drops events nobody is listening for yet. A local file can be
  // ready (or fail) before registration finishes, and a paused player sends
  // no later tick, so nothing may load until every listener is in place.
  let listening = false;
  const listenerRegistrations: Promise<unknown>[] = [];
  const load = () => {
    const url = recovery.source;
    if (disposed || fellBack || !listening || !url) return;
    nativeStateSynchronizer.clear();
    endedFromNative = false;
    const configuredQueue = recovery.queue();
    const queue = configuredQueue.length > 0
      ? configuredQueue.map((track, index) => index === 0 ? { ...track, url } : track)
      : [{
          url,
          trackId: recovery.trackId,
          bookOffsetSeconds: recovery.bookOffsetSeconds,
          title: "OperaLibre",
          artist: "Audiobook",
          album: "",
          chapters: []
        }];
    // A newly mounted control element defaults to 1x/full volume. The user's
    // selected settings own every native load, including async queue rebuilds.
    const settings = recovery.settings();
    applyNativePlaybackSettings(audio, settings);
    engaged = true;
    const positionSeconds = nativeStartupPosition(recovery.pendingPosition(), audio.currentTime);
    loadingPosition = recovery.allowAdoption === false ? positionSeconds : null;
    deciding = false;
    firstAttachmentOfPage = false;
    safely(NativeAudio.load({
      url,
      positionSeconds,
      clipPreview: recovery.clipPreview?.() ?? false,
      rate: settings.rate,
      volume: settings.volume,
      gain: recovery.gain(),
      autoplay: nativeLoadShouldAutoplay(nativeIsPlaying, recovery.wantsPlayback()),
      recoveryScopeKey: recovery.scopeKey,
      recoveryTrackId: recovery.trackId,
      recoveryBookOffsetSeconds: recovery.bookOffsetSeconds,
      queue
    }));
  };
  const rateChange = () => safely(NativeAudio.setRate({ rate: recovery.settings().rate }));
  const volumeChange = () => safely(NativeAudio.setVolume({ volume: recovery.settings().volume }));
  const seeked = () => {
    nativeIsPlaying = nativeStateSynchronizer.afterSeek(nativeIsPlaying);
  };

  audio.muted = true;
  // Unconditional for every load: passing 0 also disarms a timer left behind
  // by a WebView reload, where the detach cleanup (and its stop()) never ran.
  // A player taken over keeps its timer instead.
  const syncSleepTimer = () => {
    void NativeAudio.setSleepTimer({
      seconds: Math.max(0, recovery.sleepTimerSeconds()),
      atChapterEnd: recovery.sleepAtChapterEnd()
    }).catch(() => undefined);
  };
  if (!askToAdopt) syncSleepTimer();
  audio.addEventListener("ratechange", rateChange);
  audio.addEventListener("volumechange", volumeChange);
  audio.addEventListener("seeked", seeked);

  listenerRegistrations.push(NativeAudio.addListener("state", (state) => {
    if (disposed || fellBack || deciding) return;
    // A queued event from the previous preview phase cannot move the live clock.
    if (state.clipPreview !== undefined && state.clipPreview !== (recovery.clipPreview?.() ?? false)) return;
    // A clock for another queue track belongs to the element React is about
    // to mount for it, not to this one. Prefer the payload's own track id;
    // fall back to the last accepted trackChanged when the native side does
    // not report one.
    if (typeof state.trackId === "string" && state.trackId) {
      if (state.trackId !== recovery.trackId) {
        // Re-offer a declined change with this tick's live clock. Whether or
        // not React takes it now, the tick itself is still dropped: on
        // acceptance React remounts the element for that track, and seeking
        // this one to the new track's clock would let the synthetic
        // timeupdate persist the old track at the wrong position.
        if (declinedTrackChange?.trackId === state.trackId) {
          offerTrackChange(refreshDeclinedTrackChange(declinedTrackChange, state));
        }
        return;
      }
    } else if (activeNativeTrackId !== recovery.trackId) {
      return;
    }
    let legacyLoadReady = false;
    // A pre-load tick can still belong to the native preview this page replaced.
    if (loadingPosition !== null && recovery.clipPreview?.() && state.clipPreview === true) loadingPosition = null;
    if (loadingPosition !== null) {
      if (!state.readyToPlay || state.positionReady !== true || state.clipPreview === true) return;
      if (state.clipPreview === undefined && Math.abs(state.positionSeconds - loadingPosition) > 1.5) return;
      loadingPosition = null;
      // Compatibility with a native shell that predates the preview bit.
      legacyLoadReady = state.clipPreview === undefined;
    }
    // AVPlayer remains the only running decoder. Reflect its state through
    // synthetic media events so React's existing UI stays current without
    // starting or stopping the muted HTML decoder during app transitions.
    // AVPlayer is authoritative. Apply its clock before a synthetic pause can
    // make React persist the stale pre-background HTML position.
    if (!state.readyToPlay) {
      controlClock.synchronizePosition(state.positionSeconds, state.positionReady === true);
      return;
    }
    if (state.clipPreview === true || recovery.clipPreview?.() || recovery.awaitingReturn?.()) normalPositionReported = false;
    const firstMetadata = controlClock.updateMetadata(state.durationSeconds);
    nativeIsPlaying = nativeStateSynchronizer.receive(state, nativeIsPlaying);
    if (!normalPositionReported && state.positionReady === true && (state.clipPreview === false || legacyLoadReady) && !recovery.clipPreview?.()) {
      normalPositionReported = recovery.normalPositionReady?.(state.positionSeconds) !== false;
    }
    if (firstMetadata) audio.dispatchEvent(new Event("loadedmetadata"));
  }).then((handle) => {
    if (disposed) void handle.remove();
    else listenerHandles.push(handle);
  }));

  listenerRegistrations.push(NativeAudio.addListener("ended", (state) => {
    if (disposed || fellBack || deciding || loadingPosition !== null || endedFromNative) return;
    if (state.clipPreview !== undefined && state.clipPreview !== (recovery.clipPreview?.() ?? false)) return;
    endedFromNative = true;
    nativeStateSynchronizer.clear();
    nativeIsPlaying = false;
    if (Number.isFinite(state.positionSeconds)) {
      const finalPosition = Number.isFinite(audio.duration)
        ? Math.min(audio.duration, Math.max(0, state.positionSeconds!))
        : Math.max(0, state.positionSeconds!);
      audio.currentTime = finalPosition;
      audio.dispatchEvent(new Event("timeupdate"));
    }
    audio.pause();
    audio.dispatchEvent(new Event("ended"));
  }).then((handle) => {
    if (disposed) void handle.remove();
    else listenerHandles.push(handle);
  }));

  listenerRegistrations.push(NativeAudio.addListener("trackChanged", (event) => {
    if (disposed || fellBack || deciding || loadingPosition !== null || !event.trackId || event.trackId === recovery.trackId) return;
    if (event.clipPreview !== undefined && event.clipPreview !== (recovery.clipPreview?.() ?? false)) return;
    offerTrackChange({
      trackId: event.trackId,
      positionSeconds: event.positionSeconds,
      bookPositionSeconds: event.bookPositionSeconds,
      isPlaying: event.isPlaying
    });
  }).then((handle) => {
    if (disposed) void handle.remove();
    else listenerHandles.push(handle);
  }));

  listenerRegistrations.push(NativeAudio.addListener("intentionalSeek", (event) => {
    if (disposed || fellBack || !Number.isFinite(event.positionSeconds)) return;
    audio.currentTime = Math.max(0, event.positionSeconds);
    onIntentionalSeek();
    audio.dispatchEvent(new Event("timeupdate"));
  }).then((handle) => {
    if (disposed) void handle.remove();
    else listenerHandles.push(handle);
  }));

  listenerRegistrations.push(NativeAudio.addListener("sleepTimerEnded", () => {
    if (disposed || fellBack) return;
    nativeIsPlaying = false;
    // The follow-up state event compares against the flag just cleared and
    // will not dispatch the synthetic pause itself, so React only learns the
    // transport stopped from this event.
    audio.dispatchEvent(new Event("pause"));
    onSleepTimerEnded();
  }).then((handle) => {
    if (disposed) void handle.remove();
    else listenerHandles.push(handle);
  }));

  listenerRegistrations.push(NativeAudio.addListener("error", ({ message }) => {
    failOverToWebAudio(message || "Native audio playback failed.");
  }).then((handle) => {
    if (disposed) void handle.remove();
    else listenerHandles.push(handle);
  }));

  // AVPlayer is the only media loader; its ready event initializes the UI clock.
  startAfterListeners(listenerRegistrations, () => !disposed && !fellBack, () => {
    listening = true;
    if (!askToAdopt) {
      load();
      return;
    }
    void adoptableNativeSession(recovery.scopeKey, recovery.trackId, recovery.source).then((session) => {
      if (disposed || fellBack) return;
      firstAttachmentOfPage = false;
      if (session && !carPlaybackOwnsEngine()) {
        engaged = true;
        recovery.adopted(session);
        deciding = false;
        return;
      }
      deciding = false;
      syncSleepTimer();
      load();
    });
  });

  return () => {
    // Read before the clock is destroyed, while currentTime is still AVPlayer's.
    detachedClocks.set(audio, {
      scopeKey: recovery.scopeKey,
      trackId: recovery.trackId,
      positionSeconds: audio.currentTime
    });
    disposed = true;
    audio.removeEventListener("ratechange", rateChange);
    audio.removeEventListener("volumechange", volumeChange);
    audio.removeEventListener("seeked", seeked);
    nativeStateSynchronizer.clear();
    controlClock.destroy();
    if (!fellBack) audio.pause();
    audio.muted = false;
    for (const handle of listenerHandles) void handle.remove();
    // Keep the audio session: this cleanup runs on every track change, and
    // the next attach is moments away. App.tsx releases it when the player
    // closes with nothing to follow.
    if (engaged) void stopNativeUnlessCarOwns({ releaseSession: false });
  };
}
