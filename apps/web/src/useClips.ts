import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  deleteClip,
  downloadClipAudio,
  getServerStorageKey,
  isNetworkError,
  listClips,
  saveClip,
  updateClip
} from "./api";
import {
  type Clip,
  clipAround,
  clipFileName,
  clipsForBook,
  newClipId,
  pendingClipStorageKey,
  readPendingClips,
  writePendingClips
} from "./clips";
import { shareClipFile } from "./clipShare";
import { errorMessage } from "./formatting";
import { haptic } from "./native";
import type { Book } from "./types";

/** How long the player says a clip was just saved. */
const SAVED_NOTICE_MS = 2_000;
/** A clip that never starts playing must not keep a return place armed. */
const AUDITION_START_TIMEOUT_MS = 15_000;
/**
 * Playing into the last moments of a book finishes it. A clip that ends there
 * stops this far short so hearing it again does not mark the book as read.
 */
const BOOK_END_GUARD_SECONDS = 2;

/** A clip being played back, and the place to return to when it ends. */
type Audition = {
  clipId: string;
  bookId: string;
  startSeconds: number;
  endSeconds: number;
  returnTo: number;
  /** Playback has arrived inside the clip; until then the old position is expected. */
  reached: boolean;
  startedAt: number;
};

export type ClipEdit = Pick<Clip, "startSeconds" | "endSeconds" | "title" | "note">;

/** Whether a refused save can never succeed, so keeping it queued is pointless. */
function saveWasRejected(error: unknown) {
  return error instanceof ApiError && [400, 409, 413, 422].includes(error.status);
}

function sameContent(left: ClipEdit, right: ClipEdit) {
  return left.startSeconds === right.startSeconds
    && left.endSeconds === right.endSeconds
    && left.title === right.title
    && left.note === right.note;
}

export function useClips({
  clipPreviewBookIdRef,
  audioRef,
  book,
  bookDuration,
  bookPosition,
  collectionBook = book,
  enabled,
  pausePlayback,
  persistProgress,
  seekBookPosition,
  userId
}: {
  clipPreviewBookIdRef: RefObject<string | null>;
  audioRef: RefObject<HTMLAudioElement | null>;
  /** The book in the player. Clips are saved from, and played in, that book. */
  book: Book | null;
  bookDuration: number;
  bookPosition: number;
  /** The book whose saved clips are being browsed; opening it does not change playback. */
  collectionBook?: Book | null;
  enabled: boolean;
  pausePlayback: (audio: HTMLAudioElement | null | undefined) => void;
  persistProgress: () => Promise<void>;
  seekBookPosition: (value: number, autoPlay?: boolean, temporary?: boolean) => void;
  userId: string;
}) {
  const bookId = book?.id ?? null;
  const collectionBookId = collectionBook?.id ?? null;
  const storageKey = pendingClipStorageKey(getServerStorageKey(), userId);
  const [saved, setSaved] = useState<Clip[]>([]);
  const [pending, setPending] = useState<Clip[]>(() => readPendingClips(window.localStorage, storageKey));
  const [availability, setAvailability] = useState<"unknown" | "available" | "unsupported">("unknown");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canExportAudio, setCanExportAudio] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedId, setLastSavedId] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [audition, setAudition] = useState<Audition | null>(null);
  const [returningTo, setReturningTo] = useState<number | null>(null);
  const [reloads, setReloads] = useState(0);

  const pendingRef = useRef(pending);
  const bookIdRef = useRef(collectionBookId);
  bookIdRef.current = collectionBookId;
  const flushingRef = useRef(false);
  const deliveriesRef = useRef(new Map<string, Promise<"saved" | "waiting" | string>>());

  function storePending(next: Clip[]) {
    pendingRef.current = next;
    writePendingClips(window.localStorage, storageKey, next);
    setPending(next);
  }

  /**
   * Send one queued clip. A clip stays queued through anything that might
   * pass: no connection, a restarting server, an expired sign-in, a library
   * that is briefly unmounted.
   */
  function deliver(clip: Clip): Promise<"saved" | "waiting" | string> {
    const queued = pendingRef.current.find((candidate) => candidate.id === clip.id);
    if (!queued) return Promise.resolve("saved");
    const existing = deliveriesRef.current.get(clip.id);
    if (existing) return existing;
    const delivery = deliverNow(queued).finally(() => deliveriesRef.current.delete(clip.id));
    deliveriesRef.current.set(clip.id, delivery);
    return delivery;
  }

  async function deliverNow(clip: Clip): Promise<"saved" | "waiting" | string> {
    try {
      let stored: Clip | null = null;
      if (!clip.deleted) {
        stored = await saveClip(clip);
        // A repeated save returns the first copy, which can predate an offline trim.
        const latest = pendingRef.current.find((candidate) => candidate.id === clip.id) ?? clip;
        if (!latest.deleted && !sameContent(stored, latest)) stored = await updateClip(latest);
      }
      // A removal can arrive while either the save or trim request is in flight.
      const removed = clip.deleted || pendingRef.current.find((candidate) => candidate.id === clip.id)?.deleted;
      if (removed) await deleteClip(clip);
      storePending(pendingRef.current.filter((candidate) => candidate.id !== clip.id));
      if (removed) setSaved((current) => current.filter((candidate) => candidate.id !== clip.id));
      else if (stored && stored.bookId === bookIdRef.current) {
        const delivered = stored;
        setSaved((current) => [...current.filter((candidate) => candidate.id !== delivered.id), delivered]);
      }
      return "saved";
    } catch (failure) {
      if (!saveWasRejected(failure) || isNetworkError(failure)) return "waiting";
      storePending(pendingRef.current.filter((candidate) => candidate.id !== clip.id));
      return errorMessage(failure, "The clip could not be saved.");
    }
  }

  async function flushPending() {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      for (const clip of [...pendingRef.current]) {
        if (await deliver(clip) === "waiting") break;
      }
    } finally {
      flushingRef.current = false;
    }
  }
  const flushPendingRef = useRef(flushPending);
  flushPendingRef.current = flushPending;

  useEffect(() => {
    const stored = readPendingClips(window.localStorage, storageKey);
    pendingRef.current = stored;
    setPending(stored);
  }, [storageKey]);

  useEffect(() => {
    setSaved([]);
    setAvailability("unknown");
    setError(null);
  }, [collectionBookId, storageKey]);

  useEffect(() => {
    if (!enabled || !collectionBookId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setCanExportAudio(false);
    void listClips(collectionBookId).then((list) => {
      if (cancelled) return;
      if (!list) {
        setAvailability("unsupported");
        return;
      }
      setSaved(list.clips);
      setCanExportAudio(list.canExportAudio);
      setAvailability("available");
      void flushPendingRef.current();
    }).catch((failure) => {
      if (!cancelled) setLoadError(errorMessage(failure, "Saved clips could not be loaded. Try again when your server is reachable."));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [collectionBookId, enabled, reloads, storageKey]);

  useEffect(() => {
    const reload = () => setReloads((count) => count + 1);
    window.addEventListener("online", reload);
    return () => window.removeEventListener("online", reload);
  }, []);

  useEffect(() => {
    if (!lastSavedId) return;
    const timer = window.setTimeout(() => setLastSavedId(null), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [lastSavedId]);

  /** Save the last half minute and the next ten seconds around the playhead. */
  function saveMoment() {
    if (!book) return;
    const range = clipAround(bookPosition, bookDuration);
    if (!range) {
      setError("There is not enough audio here to clip.");
      return;
    }
    const now = new Date().toISOString();
    const clip: Clip = {
      id: newClipId(),
      bookId: book.id,
      ...range,
      title: null,
      note: null,
      createdAt: now,
      updatedAt: now,
      pending: true
    };
    haptic("medium");
    setError(null);
    // Queued before the request leaves, so a clip tapped in a tunnel or just
    // before the app is closed is still there afterwards.
    storePending([...pendingRef.current, clip]);
    setLastSavedId(clip.id);
    void deliver(clip).then((outcome) => {
      if (outcome === "saved" || outcome === "waiting") return;
      setLastSavedId(null);
      setError(outcome);
    });
  }

  async function change(clip: Clip, edit: ClipEdit): Promise<boolean> {
    const next = { ...clip, ...edit };
    if (pendingRef.current.some((candidate) => candidate.id === clip.id)) {
      storePending(pendingRef.current.map((candidate) => candidate.id === clip.id ? next : candidate));
      void flushPending();
      return true;
    }
    try {
      const stored = await updateClip(next);
      setSaved((current) => current.map((candidate) => candidate.id === stored.id ? stored : candidate));
      setError(null);
      return true;
    } catch (failure) {
      setError(errorMessage(failure, "The change could not be saved."));
      return false;
    }
  }

  async function remove(clip: Clip) {
    if (audition?.clipId === clip.id) stopAudition();
    if (lastSavedId === clip.id) setLastSavedId(null);
    if (pendingRef.current.some((candidate) => candidate.id === clip.id)) {
      storePending(pendingRef.current.map((candidate) => candidate.id === clip.id ? { ...candidate, deleted: true } : candidate));
      setSaved((current) => current.filter((candidate) => candidate.id !== clip.id));
      void deliver({ ...clip, deleted: true });
      return;
    }
    try {
      await deleteClip(clip);
      setSaved((current) => current.filter((candidate) => candidate.id !== clip.id));
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, "The clip could not be removed."));
    }
  }

  async function share(clip: Clip) {
    if (!collectionBook || sharingId) return;
    setSharingId(clip.id);
    setError(null);
    try {
      const audio = await downloadClipAudio(clip);
      await shareClipFile(audio, clipFileName(collectionBook.title, clip), clip.title ?? collectionBook.title);
    } catch (failure) {
      setError(errorMessage(failure, "The clip could not be shared."));
    } finally {
      setSharingId(null);
    }
  }

  /**
   * Play a clip in the player and come back afterwards. The listener's place
   * is remembered here and restored when the clip ends or is stopped, so
   * hearing an old passage again does not cost them their position.
   */
  function playClip(clip: Clip) {
    if (!book || book.id !== clip.bookId) return;
    void persistProgress();
    clipPreviewBookIdRef.current = book.id;
    setReturningTo(null);
    haptic("light");
    setAudition({
      clipId: clip.id,
      bookId: book.id,
      startSeconds: clip.startSeconds,
      endSeconds: bookDuration > 0
        ? Math.min(clip.endSeconds, bookDuration - BOOK_END_GUARD_SECONDS)
        : clip.endSeconds,
      // Going from one clip straight to another keeps the original place.
      returnTo: audition?.bookId === book.id ? audition.returnTo : bookPosition,
      reached: false,
      startedAt: Date.now()
    });
    seekBookPosition(clip.startSeconds, true, true);
  }

  function finishAudition(finished: Audition) {
    setAudition(null);
    pausePlayback(audioRef.current);
    seekBookPosition(finished.returnTo, false, true);
    setReturningTo(finished.returnTo);
  }
  const finishAuditionRef = useRef(finishAudition);
  finishAuditionRef.current = finishAudition;

  // A seek made while paused is only saved when it stays in the same track.
  // The place being restored is the one that matters most, so it is saved as
  // soon as the player reports it, whichever track it is in.
  const persistProgressRef = useRef(persistProgress);
  persistProgressRef.current = persistProgress;
  useEffect(() => {
    if (returningTo === null || Math.abs(bookPosition - returningTo) > 1.5) return;
    setReturningTo(null);
    clipPreviewBookIdRef.current = null;
    void persistProgressRef.current();
  }, [bookPosition, returningTo, clipPreviewBookIdRef]);

  function stopAudition() {
    if (!audition) return;
    haptic("light");
    finishAudition(audition);
  }

  function continueFrom(clip: Clip) {
    clipPreviewBookIdRef.current = null;
    setAudition(null);
    setReturningTo(null);
    seekBookPosition(clip.startSeconds, true);
  }

  useEffect(() => {
    if (!audition) return;
    if (bookId !== audition.bookId || clipPreviewBookIdRef.current !== audition.bookId) {
      if (clipPreviewBookIdRef.current === audition.bookId) clipPreviewBookIdRef.current = null;
      setAudition(null);
      return;
    }
    const inside = bookPosition >= audition.startSeconds - 1 && bookPosition < audition.endSeconds;
    if (!audition.reached) {
      // The seek takes a moment, longer across tracks; until it lands the
      // player still reports the place the listener came from.
      if (inside) setAudition({ ...audition, reached: true });
      else if (Date.now() - audition.startedAt > AUDITION_START_TIMEOUT_MS) {
        clipPreviewBookIdRef.current = null;
        setAudition(null);
      }
      return;
    }
    if (inside) return;
    const ranOut = bookPosition >= audition.endSeconds && bookPosition <= audition.endSeconds + 5;
    // Anywhere else means the listener moved on their own; that is now their
    // place, and pulling them back would be the surprise.
    if (ranOut) finishAuditionRef.current(audition);
    else {
      clipPreviewBookIdRef.current = null;
      setAudition(null);
    }
  }, [audition, bookId, bookPosition, clipPreviewBookIdRef]);

  const stopAuditionRef = useRef(stopAudition);
  stopAuditionRef.current = stopAudition;
  useEffect(() => {
    if (!enabled) stopAuditionRef.current();
  }, [enabled]);

  const clips = useMemo(
    () => (collectionBookId ? clipsForBook(saved, pending, collectionBookId) : []),
    [collectionBookId, pending, saved]
  );

  return {
    canExportAudio,
    change,
    clips,
    continueFrom,
    dismissError: () => setError(null),
    error,
    lastSavedId,
    loading,
    loadError,
    supported: availability !== "unsupported",
    playClip,
    playingClipId: audition?.clipId ?? null,
    refresh: () => setReloads((count) => count + 1),
    remove,
    saveMoment,
    share,
    sharingId,
    stopAudition,
    /** False on Jellyfin, device-only, and demo libraries, and on older servers. */
    visible: enabled && bookId !== null && book?.source !== "device" && availability !== "unsupported"
  };
}
