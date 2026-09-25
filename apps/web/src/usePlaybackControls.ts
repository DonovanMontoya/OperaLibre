import { playbackRestoreBookAfterAction } from "./offlinePlayback";
import { durationFromTracks, errorMessage, trackOffsetSeconds } from "./formatting";
import { PlaybackGainChain, streamCanBeBoosted } from "./playbackGain";
import { BOOK_GAIN_DEFAULT, bookGainFromDb, type createBookGainSync } from "./bookVolume";
import { carPlaybackOwnsEngine } from "./carPlay";
import { ownsPendingPlay, playbackEventOwnsPendingPlay } from "./playbackPending";
import { pauseNativeAudio, playNativeAudio, seekNativeAudio } from "./nativeAudio";
import { haptic } from "./native";
import type { AuthUser, Book, Chapter, Progress, Track } from "./types";
import { hasPlaybackSource } from "./nativeAudioStartup";
import {
  endedShortOfTrack,
  PROGRESS_RESET_GUARD_SECONDS,
  shouldResumeSavedPosition,
  summarizeBookProgress
} from "./reliability";
import { getFreshProgress } from "./api";
import { normalizePlaybackSpeed } from "./playbackSpeed";
import { writeStoredBookGains, writeStoredSpeed } from "./appStorage";
import type { PendingSeek } from "./playbackTypes";
import type { NativeTab } from "./nativeTabs";
import type { NativePlayerSheet } from "./PlayerSheets";
import type { ChapterSegment } from "./chapters";
import type { Dispatch, RefObject, SetStateAction } from "react";

const PROGRESS_SAVE_INTERVAL_MS = 2_000;
export function audioSourceMatches(audio: HTMLAudioElement, source: string) {
  if (!source) return false;
  try {
    return audio.currentSrc === new URL(source, document.baseURI).href;
  } catch {
    return audio.currentSrc === source;
  }
}
// The API client's own timeout is generous (30 s); a startup-critical read
// that is allowed to fall back to a local copy should not wait that long.
// Before "Begin this reading" trusts a stale listing summary, the server gets
// this long to say whether the book is actually well under way elsewhere.
const START_OVER_PROGRESS_CHECK_MS = 2_500;

/**
 * Play, pause, seek, chapter and track moves, speed and book gain for the
 * playing book, over either the web audio element or the native player.
 */
export function usePlaybackControls({
  activeChapter,
  activeTrackIndex,
  audioRef,
  autoResumePlayEventPendingRef,
  changeBookCompletion,
  chapterElapsed,
  chapterSegments,
  currentTrack,
  currentTrackKey,
  currentUser,
  duration,
  explicitSessionStartBookIdRef,
  gainChainRef,
  gainSyncRef,
  intentionalSeekGenerationRef,
  intentionalSeekTargetRef,
  isOffline,
  localMode,
  native,
  nativeAudio,
  nativeAudioQueueReady,
  nativePlaybackPlayingRef,
  pendingSeek,
  pendingSeekRef,
  persistProgress,
  playCancelGenerationRef,
  playPendingBookIdRef,
  playPendingRef,
  playWhenTrackLoads,
  playbackActionVersionRef,
  playbackBook,
  playbackBookId,
  playbackBookIdRef,
  playbackGain,
  playbackGainRef,
  playbackTouchedRef,
  playerPaneRef,
  position,
  restoredProgressBookId,
  resumeAutoplayBookIdRef,
  resumeAutoplayPendingRef,
  resumeReconciliationBookIdRef,
  saveStartedAt,
  scheduleStartupReveal,
  selectedBook,
  setBookGains,
  setCurrentTrackId,
  setDuration,
  setIsPlaying,
  setNativeAudioFailed,
  setNativePlayerSheet,
  setNativePlayerView,
  setNativeTab,
  setPendingSeek,
  setPlayPending,
  setPlaybackBookId,
  setPlaybackError,
  setPosition,
  setRestoredPlaybackBookId,
  setSelectedBookId,
  setSpeed,
  speed,
  startupProgressAppliedRef,
  streamUrl,
  takeOverFromCar,
  updateBookProgress,
  volume,
  wantsAutoplayRef
}: {
  activeChapter: ChapterSegment | null;
  activeTrackIndex: number;
  audioRef: RefObject<HTMLAudioElement | null>;
  autoResumePlayEventPendingRef: RefObject<boolean>;
  changeBookCompletion: (book: Book, finished: boolean, finalProgress?: Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">, resetToUnplayed?: boolean) => Promise<boolean>;
  chapterElapsed: number;
  chapterSegments: ChapterSegment[];
  currentTrack: Track | null;
  currentTrackKey: string | null;
  currentUser: AuthUser;
  duration: number;
  explicitSessionStartBookIdRef: RefObject<string | null>;
  gainChainRef: RefObject<PlaybackGainChain | null>;
  gainSyncRef: RefObject<ReturnType<typeof createBookGainSync> | null>;
  intentionalSeekGenerationRef: RefObject<Map<string, number>>;
  intentionalSeekTargetRef: RefObject<Map<string, number>>;
  isOffline: boolean;
  localMode: boolean;
  native: boolean;
  nativeAudio: boolean;
  nativeAudioQueueReady: boolean;
  nativePlaybackPlayingRef: RefObject<boolean>;
  pendingSeek: PendingSeek | null;
  pendingSeekRef: RefObject<PendingSeek | null>;
  persistProgress: () => Promise<void>;
  playCancelGenerationRef: RefObject<number>;
  playPendingBookIdRef: RefObject<string | null>;
  playPendingRef: RefObject<boolean>;
  playWhenTrackLoads: RefObject<boolean>;
  playbackActionVersionRef: RefObject<number>;
  playbackBook: Book | null;
  playbackBookId: string | null;
  playbackBookIdRef: RefObject<string | null>;
  playbackGain: number;
  playbackGainRef: RefObject<number>;
  playbackTouchedRef: RefObject<boolean>;
  playerPaneRef: RefObject<HTMLElement | null>;
  position: number;
  restoredProgressBookId: RefObject<string | null>;
  resumeAutoplayBookIdRef: RefObject<string | null>;
  resumeAutoplayPendingRef: RefObject<boolean>;
  resumeReconciliationBookIdRef: RefObject<string | null>;
  saveStartedAt: RefObject<number>;
  scheduleStartupReveal: () => void;
  selectedBook: Book;
  setBookGains: Dispatch<SetStateAction<Record<string, number>>>;
  setCurrentTrackId: Dispatch<SetStateAction<string | null>>;
  setDuration: Dispatch<SetStateAction<number>>;
  setIsPlaying: Dispatch<SetStateAction<boolean>>;
  setNativeAudioFailed: Dispatch<SetStateAction<boolean>>;
  setNativePlayerSheet: Dispatch<SetStateAction<NativePlayerSheet>>;
  setNativePlayerView: Dispatch<SetStateAction<"details" | "now" | "chapters">>;
  setNativeTab: Dispatch<SetStateAction<NativeTab>>;
  setPendingSeek: (value: PendingSeek | null) => void;
  setPlayPending: (pending: boolean, bookId?: string | null) => void;
  setPlaybackBookId: Dispatch<SetStateAction<string | null>>;
  setPlaybackError: Dispatch<SetStateAction<string | null>>;
  setPosition: Dispatch<SetStateAction<number>>;
  setRestoredPlaybackBookId: Dispatch<SetStateAction<string | null>>;
  setSelectedBookId: Dispatch<SetStateAction<string | null>>;
  setSpeed: Dispatch<SetStateAction<number>>;
  speed: number;
  startupProgressAppliedRef: RefObject<boolean>;
  streamUrl: string;
  takeOverFromCar: () => void;
  updateBookProgress: (bookId: string, saved: Progress) => void;
  volume: number;
  wantsAutoplayRef: RefObject<boolean>;
}) {
  /**
   * Draw the media element's clock without saving it. Returns false while a
   * restored checkpoint is still waiting to be applied, when there is nothing
   * newer than that checkpoint to save.
   */
  function showMediaClock() {
    const audio = audioRef.current;
    if (!audio) {
      return false;
    }
    // AVPlayer can emit its initial 0:00 clock before the pending restored
    // seek reaches the media element. Keep the coherent checkpoint visible.
    const restoring = pendingSeekRef.current;
    if (restoring && restoring.trackId === currentTrackKey) {
      setPosition(restoring.positionSeconds);
      setDuration(Number.isFinite(audio.duration) ? audio.duration : duration);
      return false;
    }
    setPosition(audio.currentTime);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    return true;
  }

  function onTimeUpdate() {
    if (!showMediaClock()) {
      return;
    }
    const now = Date.now();
    if (now - saveStartedAt.current >= PROGRESS_SAVE_INTERVAL_MS) {
      saveStartedAt.current = now;
      void persistProgress();
    }
  }

  // Marks that the listener moved playback in this session (and optionally
  // that the move was a deliberate seek). persistProgress writes nothing
  // until one of these has happened.
  //
  // A seek into a book that is not the one currently playing has to name that
  // book: playbackBook still points at the previous book (or nothing) until
  // the state update lands, and marking the wrong book leaves the jump
  // unflagged — the server would then bill the skipped hours as listening.
  //
  // A deliberate seek also records the whole-book position it aimed at, which
  // is what decides whether its saves may lift the server's reset guard.
  function markPlaybackTouched(
    deliberateSeek = false,
    seekBookId?: string,
    interruptRestore = true,
    seekTargetBookPosition?: number
  ) {
    playbackTouchedRef.current = true;
    const bookId = seekBookId ?? playbackBook?.id ?? null;
    if (interruptRestore) {
      playbackActionVersionRef.current += 1;
      resumeAutoplayPendingRef.current = false;
      if (resumeReconciliationBookIdRef.current === playbackBook?.id) {
        resumeReconciliationBookIdRef.current = null;
      }
      // The listener's action now owns the track and position. Let the stale
      // recovery finish harmlessly, but release persistence and native queue
      // attachment instead of leaving this book behind the recovery gate.
      const resolvedBookId = playbackRestoreBookAfterAction(
        restoredProgressBookId.current,
        bookId,
        true
      );
      restoredProgressBookId.current = resolvedBookId;
      setRestoredPlaybackBookId(resolvedBookId);
    }
    if (deliberateSeek && bookId) {
      intentionalSeekGenerationRef.current.set(
        bookId,
        (intentionalSeekGenerationRef.current.get(bookId) ?? 0) + 1
      );
      if (seekTargetBookPosition !== undefined && Number.isFinite(seekTargetBookPosition)) {
        intentionalSeekTargetRef.current.set(bookId, Math.max(0, seekTargetBookPosition));
      } else {
        intentionalSeekTargetRef.current.delete(bookId);
      }
    }
  }

  /** The whole-book position a track-relative seek on the playing book lands at. */
  function seekTargetInPlaybackBook(trackPosition: number) {
    if (!playbackBook) return undefined;
    return trackOffsetSeconds(playbackBook, activeTrackIndex) + Math.max(0, trackPosition);
  }

  function gainChain() {
    return (gainChainRef.current ??= new PlaybackGainChain());
  }

  /**
   * Route the element through the boost chain, once, when this book actually
   * asks for more than its own level. Unboosted books never touch Web Audio at
   * all, which keeps the ordinary playback path exactly as it was.
   *
   * Called from user gestures wherever possible: an AudioContext first created
   * outside one starts suspended, and a suspended context makes a routed
   * element silent rather than loud.
   */
  function engageGainChain(
    audio: HTMLAudioElement | null | undefined,
    // Read from the ref, not the render: this runs from lock-screen handlers
    // and media events whose closures can predate the current gain.
    gain = playbackGainRef.current
  ) {
    if (!audio || nativeAudio) return;
    if (!gainChain().isAttachedTo(audio)) {
      if (gain <= BOOK_GAIN_DEFAULT) return;
      if (!streamCanBeBoosted(audio.currentSrc || streamUrl)) return;
      if (!gainChain().attach(audio)) return;
    }
    gainChain().resume();
    gainChain().setGain(gain);
    audio.volume = volume;
  }

  /**
   * The device volume, and the book's gain when nothing else can carry it. The
   * element's own volume cannot exceed unity, so this path can only ever cut a
   * loud book down, never lift a quiet one.
   */
  function applyPlaybackVolume(audio: HTMLAudioElement) {
    // Unsupported players retain the saved boost but play at Original. Clamp
    // the book gain before multiplying so it cannot override device volume.
    audio.volume = nativeAudio || gainChain().isAttachedTo(audio)
      ? volume
      : volume * Math.min(1, playbackGain);
  }

  function startPlayback(
    audio: HTMLAudioElement | null | undefined,
    interruptRestore = true
  ) {
    if (!audio) return;
    if (carPlaybackOwnsEngine()) {
      // Play, while the car holds the player, means take it back. The attach
      // effect is parked on that flag, so it has to be cleared first — and the
      // attach it then performs resumes from the checkpoint the car has been
      // keeping current. Starting playback waits for that attach.
      takeOverFromCar();
      window.setTimeout(() => startPlayback(audioRef.current, interruptRestore), 0);
      return;
    }
    markPlaybackTouched(false, undefined, interruptRestore);
    const pendingRequest = {
      bookId: playbackBookIdRef.current,
      cancelGeneration: playCancelGenerationRef.current
    };
    if (nativeAudio ? !nativePlaybackPlayingRef.current : audio.paused) setPlayPending(true);
    // Let the element's `play` event tell an automatic Shelf-Resume start
    // apart from a listener's tap. A rejected start clears it again so the
    // next play event — a real tap — counts as one.
    autoResumePlayEventPendingRef.current = !interruptRestore;
    engageGainChain(audio);
    if (!nativeAudio) {
      audio.play().catch(() => {
        if (!ownsPendingPlay(
          pendingRequest,
          playCancelGenerationRef.current,
          playPendingBookIdRef.current
        )) return;
        autoResumePlayEventPendingRef.current = false;
        setPlayPending(false);
      });
      return;
    }
    void playNativeAudio().catch((error) => {
      if (!ownsPendingPlay(
        pendingRequest,
        playCancelGenerationRef.current,
        playPendingBookIdRef.current
      )) return;
      autoResumePlayEventPendingRef.current = false;
      nativePlaybackPlayingRef.current = false;
      audio.muted = false;
      // This same request is about to continue on web audio. Keep its pending
      // owner, timer, and second-tap cancellation until playback or an error.
      stageWebAudioFallback(audio, true);
      setPlaybackError(errorMessage(error, "Native audio playback failed."));
    });
  }

  function pausePlayback(audio: HTMLAudioElement | null | undefined) {
    setPlayPending(false);
    if (!audio) return;
    // While the car owns the player, the element is all this app controls.
    // Pausing the native player here would stop the driver's book, and this
    // runs on teardown paths that are not a listener asking for a pause.
    if (!nativeAudio || carPlaybackOwnsEngine()) {
      audio.pause();
      return;
    }
    nativePlaybackPlayingRef.current = false;
    setIsPlaying(false);
    void pauseNativeAudio().catch((error) => {
      audio.muted = false;
      stageWebAudioFallback(audio, false);
      setPlaybackError(errorMessage(error, "Native audio playback could not be paused."));
    });
  }

  function stageWebAudioFallback(audio: HTMLAudioElement, resume: boolean, target?: number) {
    if (currentTrackKey) {
      const pending = pendingSeekRef.current;
      setPendingSeek({
        trackId: currentTrackKey,
        positionSeconds: target ?? (pending?.trackId === currentTrackKey
          ? pending.positionSeconds : audio.currentTime)
      });
    }
    // React restores the real media source; its metadata event applies this
    // checkpoint before playing. The native clock itself never fetched audio.
    playWhenTrackLoads.current = resume;
    setNativeAudioFailed(true);
  }

  function setPlaybackPosition(audio: HTMLAudioElement, value: number) {
    const nextPosition = Math.max(0, Math.min(value, audio.duration || value));
    audio.currentTime = nextPosition;
    if (nativeAudio) {
      const shouldResume = nativePlaybackPlayingRef.current;
      void seekNativeAudio(nextPosition).catch((error) => {
        nativePlaybackPlayingRef.current = false;
        audio.muted = false;
        stageWebAudioFallback(audio, shouldResume, nextPosition);
        setPlaybackError(errorMessage(error, "Native audio could not seek."));
      });
    }
    return nextPosition;
  }

  function onLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    setPlaybackError(null);
    audio.playbackRate = speed;
    // A boosted book is routed before it plays, so the lift is there from the
    // first word rather than arriving a beat after playback starts.
    engageGainChain(audio);
    applyPlaybackVolume(audio);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);

    if (
      pendingSeek !== null &&
      pendingSeek.trackId === currentTrackKey &&
      audioSourceMatches(audio, streamUrl)
    ) {
      const restoredPosition = Math.min(
        pendingSeek.positionSeconds,
        audio.duration || pendingSeek.positionSeconds
      );
      if (!nativeAudio || Math.abs(audio.currentTime - restoredPosition) > 0.75) {
        setPlaybackPosition(audio, restoredPosition);
      }
      setPosition(restoredPosition);
      setPendingSeek(null);
    } else if (pendingSeek !== null) {
      // Ignore a late metadata event from the source being replaced. The
      // target track still owns this pending resume position.
      return;
    } else {
      setPosition(audio.currentTime);
    }
    if (playWhenTrackLoads.current) {
      playWhenTrackLoads.current = false;
      startPlayback(audio, !resumeAutoplayPendingRef.current);
      resumeAutoplayPendingRef.current = false;
    }
    if (startupProgressAppliedRef.current) scheduleStartupReveal();
  }

  function seekBy(delta: number) {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    haptic("light");
    // While a seek is still queued the element reads 0 (metadata pending);
    // the queued target is the real position, so move that instead.
    const pending = pendingSeekRef.current;
    const base = pending && pending.trackId === currentTrack?.id
      ? pending.positionSeconds
      : audio.currentTime;
    seekTo(base + delta);
  }

  function seekTo(value: number) {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const pending = pendingSeekRef.current;
    if (pending && currentTrack && pending.trackId === currentTrack.id) {
      const nextPosition = Math.max(
        0,
        Math.min(value, currentTrack.durationSeconds ?? value)
      );
      markPlaybackTouched(true, undefined, true, seekTargetInPlaybackBook(nextPosition));
      setPendingSeek({ trackId: currentTrack.id, positionSeconds: nextPosition });
      setPosition(nextPosition);
      void persistProgress();
      return;
    }
    const clamped = Math.max(0, Math.min(value, audio.duration || value));
    markPlaybackTouched(true, undefined, true, seekTargetInPlaybackBook(clamped));
    const nextPosition = setPlaybackPosition(audio, value);
    setPosition(nextPosition);
    void persistProgress();
  }

  function seekBookPositionInBook(book: Book, value: number, autoPlay = false) {
    const targetBookDuration = book.durationSeconds ?? durationFromTracks(book);
    const clampedValue = Math.max(0, Math.min(value, targetBookDuration || value));
    markPlaybackTouched(true, book.id, true, clampedValue);
    if (playbackBook?.id !== book.id) explicitSessionStartBookIdRef.current = book.id;
    let offset = 0;
    let targetTrack: Track | undefined = book.tracks[0];

    for (const track of book.tracks) {
      const trackDuration = track.durationSeconds ?? 0;
      const nextOffset = offset + Math.max(1, trackDuration);
      targetTrack = track;
      if (clampedValue < nextOffset) {
        break;
      }
      offset += trackDuration;
    }

    if (!targetTrack) {
      return;
    }

    const trackPosition = Math.max(0, clampedValue - offset);
    setPlaybackBookId(book.id);

    if (playbackBook?.id === book.id && targetTrack.id === currentTrack?.id && audioRef.current) {
      const nextPosition = setPlaybackPosition(audioRef.current, trackPosition);
      setPosition(nextPosition);
      void persistProgress();
      if (autoPlay) {
        startPlayback(audioRef.current);
      }
      return;
    }

    setCurrentTrackId(targetTrack.id);
    setPendingSeek({ trackId: targetTrack.id, positionSeconds: trackPosition });
    setPosition(trackPosition);
    playWhenTrackLoads.current = autoPlay;
    wantsAutoplayRef.current = autoPlay;
  }

  function seekBookPosition(value: number, autoPlay = false) {
    if (!playbackBook) {
      return;
    }

    seekBookPositionInBook(playbackBook, value, autoPlay);
  }

  // Start when the active engine has a source. The native control element
  // deliberately has no src; only AVPlayer fetches its stream URL.
  function playWhenReady() {
    const audio = audioRef.current;
    if (nativeAudioQueueReady && hasPlaybackSource(audio, nativeAudio, streamUrl)) {
      startPlayback(audio);
      return;
    }
    wantsAutoplayRef.current = true;
    setPlayPending(true);
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    haptic("medium");
    if (playPendingRef.current) {
      cancelPendingPlayback(audio);
      return;
    }
    // A disk lookup may still be resolving. Native readiness uses the
    // stream URL, never the intentionally absent web element src.
    if (!nativeAudioQueueReady || !hasPlaybackSource(audio, nativeAudio, streamUrl)) {
      wantsAutoplayRef.current = true;
      setPlayPending(true);
      return;
    }
    if (nativeAudio ? !nativePlaybackPlayingRef.current : audio.paused) {
      startPlayback(audio);
    } else {
      pausePlayback(audio);
    }
  }

  function clearPlayPendingForBook(bookId: string | null) {
    if (playbackEventOwnsPendingPlay(
      playPendingRef.current,
      playPendingBookIdRef.current,
      bookId
    )) setPlayPending(false);
  }

  function cancelPendingPlayback(audio: HTMLAudioElement | null | undefined) {
    // Still waiting on the stream: this tap takes the start back. The
    // generation also prevents an async shelf progress check from re-arming it.
    const pendingOwnsActiveBook = playPendingBookIdRef.current === playbackBookIdRef.current;
    playCancelGenerationRef.current += 1;
    wantsAutoplayRef.current = false;
    playWhenTrackLoads.current = false;
    resumeAutoplayPendingRef.current = false;
    if (pendingOwnsActiveBook) pausePlayback(audio);
    else setPlayPending(false);
  }


  function selectTrack(track: Track, autoPlay = true) {
    void persistProgress();
    const targetBook = selectedBook ?? playbackBook;
    markPlaybackTouched(
      true,
      targetBook?.id,
      true,
      targetBook
        ? trackOffsetSeconds(targetBook, targetBook.tracks.findIndex((candidate) => candidate.id === track.id))
        : undefined
    );
    if (selectedBook && playbackBook?.id !== selectedBook.id) {
      explicitSessionStartBookIdRef.current = selectedBook.id;
    }
    setNativePlayerView("now");
    if (native) {
      setNativeTab("reading");
    }
    if (
      selectedBook?.id === playbackBook?.id &&
      track.id === currentTrack?.id &&
      audioRef.current
    ) {
      setPlaybackPosition(audioRef.current, 0);
      setPosition(0);
      if (autoPlay) {
        startPlayback(audioRef.current);
      }
      return;
    }
    if (selectedBook) {
      setPlaybackBookId(selectedBook.id);
    }
    setCurrentTrackId(track.id);
    setPendingSeek({ trackId: track.id, positionSeconds: 0 });
    setPosition(0);
    playWhenTrackLoads.current = autoPlay;
    wantsAutoplayRef.current = autoPlay;
  }

  /**
   * The shelf's primary action. Its label already promises the right thing —
   * "Resume · 6h 32m left" — and the handler has to agree. Starting the first
   * track marks a deliberate session start, which suppresses the restore
   * effect, so every in-progress book reopened at the opening credits. A
   * resume instead hands the book to that effect, which reconciles the native,
   * checkpoint, cached, listed and server copies before seeking.
   */
  async function playSelectedBook(book: Book) {
    haptic("medium");
    if (playPendingRef.current) {
      const pendingBookId = playPendingBookIdRef.current;
      cancelPendingPlayback(audioRef.current);
      // A second activation of the same shelf action is cancellation. A tap
      // on another book replaces the old pending request in one action.
      if (pendingBookId === book.id) return;
    }
    const cancelGeneration = playCancelGenerationRef.current;
    setPlayPending(true, book.id);
    if (!shouldResumeSavedPosition(book.progress)) {
      // The listing summary can lag the server (a cached shelf, a session on
      // another device since the last refresh). Before "Begin this reading"
      // writes a near-zero position with a deliberate seek attached — which
      // the server would honour — ask for the live copy, briefly. Offline or
      // unanswered, the summary stands as before.
      const inProgressElsewhere = await freshProgressBeforeStartingOver(book);
      if (playCancelGenerationRef.current !== cancelGeneration) return;
      if (inProgressElsewhere) {
        updateBookProgress(book.id, inProgressElsewhere);
        resumeSelectedBook(book);
        return;
      }
      // "Read it again" on a finished book, or one never opened: track one.
      if (book.tracks[0]) selectTrack(book.tracks[0]);
      else setPlayPending(false);
      return;
    }
    resumeSelectedBook(book);
  }

  async function freshProgressBeforeStartingOver(book: Book): Promise<Progress | null> {
    if (
      book.source === "device" ||
      localMode ||
      isOffline ||
      book.progress?.status === "finished"
    ) {
      return null;
    }
    try {
      const server = await getFreshProgress(book, START_OVER_PROGRESS_CHECK_MS);
      if (!server) return null;
      const summary = summarizeBookProgress(book, server);
      return summary?.status === "inProgress"
        && server.bookPositionSeconds > PROGRESS_RESET_GUARD_SECONDS
        ? server
        : null;
    } catch {
      return null;
    }
  }

  function resumeSelectedBook(book: Book) {
    setNativePlayerView("now");
    if (native) {
      setNativeTab("reading");
    }
    if (playbackBook?.id === book.id) {
      // Already restored in this session — its live position is authoritative.
      playWhenReady();
      return;
    }
    void persistProgress();
    // Deliberately no explicit session start, no pending seek, and no autoplay
    // flag yet: the restore effect owns all three. Arming autoplay here would
    // start the first track — `currentTrack` falls back to track one while the
    // restored id is still resolving — which is the very thing being fixed.
    resumeAutoplayBookIdRef.current = book.id;
    setPlayPending(true, book.id);
    setPlaybackBookId(book.id);
  }

  function jumpToChapter(chapter: Chapter) {
    if (!selectedBook) {
      return;
    }

    haptic("light");
    void persistProgress();
    seekBookPositionInBook(selectedBook, chapter.startSeconds, true);
    if (native) {
      setNativeTab("reading");
      setNativePlayerView("now");
      playerPaneRef.current?.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function jumpToChapterFromSheet(chapter: Chapter) {
    if (!playbackBook) {
      return;
    }
    haptic("light");
    void persistProgress();
    setSelectedBookId(playbackBook.id);
    seekBookPositionInBook(playbackBook, chapter.startSeconds, true);
    setNativePlayerSheet(null);
  }

  function restartOrPreviousChapter() {
    if (!playbackBook || !activeChapter) {
      seekBy(-15);
      return;
    }
    const index = chapterSegments.findIndex((chapter) => chapter.id === activeChapter.id);
    const target = chapterElapsed > 5 || index <= 0
      ? activeChapter
      : chapterSegments[index - 1];
    haptic("light");
    seekBookPositionInBook(playbackBook, target.startSeconds, true);
  }

  function nextChapter() {
    if (!playbackBook || !activeChapter) {
      seekBy(30);
      return;
    }
    const index = chapterSegments.findIndex((chapter) => chapter.id === activeChapter.id);
    const target = chapterSegments[index + 1];
    if (target) {
      haptic("light");
      seekBookPositionInBook(playbackBook, target.startSeconds, true);
    }
  }

  function playNextTrack() {
    // `ended` also fires when a stream is cut short (a truncated response, a
    // proxy giving up). Advancing on that — or finishing the book on its last
    // track — would file unheard time as listened. Stop where the clock is.
    // Only the element's own duration is trusted here: the catalogue's tag
    // estimate can run minutes long and would stop every track "early".
    const endedAudio = audioRef.current;
    if (
      endedAudio &&
      currentTrack &&
      endedShortOfTrack(endedAudio.currentTime, endedAudio.duration)
    ) {
      playWhenTrackLoads.current = false;
      wantsAutoplayRef.current = false;
      pausePlayback(endedAudio);
      setIsPlaying(false);
      void persistProgress();
      setPlaybackError("Playback stopped early; the file may be incomplete.");
      return;
    }
    if (!playbackBook || activeTrackIndex >= playbackBook.tracks.length - 1) {
      playWhenTrackLoads.current = false;
      setPlayPending(false);
      setIsPlaying(false);
      if (playbackBook && currentTrack) {
        const mediaDuration = audioRef.current?.duration;
        const finalTrackPosition = Math.max(
          0,
          currentTrack.durationSeconds
            ?? (Number.isFinite(mediaDuration) ? mediaDuration! : position)
        );
        void changeBookCompletion(playbackBook, true, {
          trackId: currentTrack.id,
          positionSeconds: finalTrackPosition,
          bookPositionSeconds:
            trackOffsetSeconds(playbackBook, activeTrackIndex) + finalTrackPosition,
          durationSeconds: currentTrack.durationSeconds ?? (Number.isFinite(mediaDuration) ? mediaDuration! : null)
        });
      }
      return;
    }
    void persistProgress();
    playWhenTrackLoads.current = true;
    wantsAutoplayRef.current = true;
    setCurrentTrackId(playbackBook.tracks[activeTrackIndex + 1].id);
    const nextTrack = playbackBook.tracks[activeTrackIndex + 1];
    setPendingSeek({ trackId: nextTrack.id, positionSeconds: 0 });
    setPosition(0);
  }

  function updateSpeed(value: number) {
    const normalized = normalizePlaybackSpeed(value);
    setSpeed(normalized);
    writeStoredSpeed(normalized);
  }

  function updateBookGain(book: Book, db: number) {
    const gain = bookGainFromDb(db);
    setBookGains((existing) => {
      const next = { ...existing };
      if (gain === BOOK_GAIN_DEFAULT) delete next[book.id];
      else next[book.id] = gain;
      writeStoredBookGains(currentUser.id, next);
      return next;
    });
    if (book.id === playbackBookId) {
      // This runs inside the slider's own gesture, which is the moment an
      // AudioContext is allowed to start. The new gain has to be passed in:
      // the state update behind it has not been applied to this closure yet,
      // so the very first boost would otherwise decline to build the chain.
      engageGainChain(audioRef.current, gain);
    }
    // Device books exist only on this phone, so there is no server row to sync.
    if (book.source !== "device") {
      // Guards the book against a library payload older than this adjustment,
      // and holds it until the server echoes the value back. Clearing the guard
      // when the PUT settles would be too early: a getBooks() issued before the
      // write can still answer after it, carrying the old gain. A write that
      // never landed keeps the guard and is re-sent once the server answers
      // again — see createBookGainSync.
      gainSyncRef.current?.write(book.id, gain);
    }
  }

  return {
    applyPlaybackVolume,
    cancelPendingPlayback,
    clearPlayPendingForBook,
    engageGainChain,
    gainChain,
    jumpToChapter,
    jumpToChapterFromSheet,
    markPlaybackTouched,
    nextChapter,
    onLoadedMetadata,
    onTimeUpdate,
    pausePlayback,
    playNextTrack,
    playSelectedBook,
    restartOrPreviousChapter,
    resumeSelectedBook,
    seekBookPosition,
    seekBookPositionInBook,
    seekBy,
    seekTo,
    setPlaybackPosition,
    showMediaClock,
    startPlayback,
    togglePlayback,
    updateBookGain,
    updateSpeed
  };
}

export type PlaybackControls = ReturnType<typeof usePlaybackControls>;
