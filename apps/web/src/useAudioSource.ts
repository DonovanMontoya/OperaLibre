import { type Dispatch, type RefObject, type SetStateAction, useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { getOfflineTrackUrl, releaseOfflineMediaUrl } from "./offline";
import { canPublishNativeQueue, nativeQueueRefreshShouldResume, resolveLocalFirstSources } from "./offlinePlayback";
import type { Book, Track } from "./types";
import type { NativeAudioQueueTrack } from "./nativeAudio";
import { trackOffsetSeconds } from "./formatting";
import { mediaUrl } from "./api";
import type { ChapterSegment } from "./chapters";


/**
 * Resolves where the current track plays from (a downloaded file, the native
 * player queue or the stream) and starts a waiting autoplay once it lands.
 */
export function useAudioSource({
  activeTrackIndex,
  audioRef,
  chapterSegments,
  currentTrack,
  currentTrackKey,
  mediaCredentialReady,
  nativeAudio,
  nativeAudioQueueReady,
  nativeAudioQueueReadyKey,
  nativeAudioQueueRef,
  nativePlaybackPlayingRef,
  playWhenTrackLoads,
  playbackBook,
  playbackBookDownloaded,
  playbackBookKey,
  requiredNativeAudioQueueKey,
  setNativeAudioQueueReadyKey,
  setOfflineSource,
  setPlayPending,
  startPlaybackRef,
  streamUrl,
  wantsAutoplayRef
}: {
  activeTrackIndex: number;
  audioRef: RefObject<HTMLAudioElement | null>;
  chapterSegments: ChapterSegment[];
  currentTrack: Track | null;
  currentTrackKey: string | null;
  mediaCredentialReady: boolean;
  nativeAudio: boolean;
  nativeAudioQueueReady: boolean;
  nativeAudioQueueReadyKey: string | null;
  nativeAudioQueueRef: RefObject<NativeAudioQueueTrack[]>;
  nativePlaybackPlayingRef: RefObject<boolean>;
  playWhenTrackLoads: RefObject<boolean>;
  playbackBook: Book | null;
  playbackBookDownloaded: boolean;
  playbackBookKey: string | null;
  requiredNativeAudioQueueKey: string | null;
  setNativeAudioQueueReadyKey: Dispatch<SetStateAction<string | null>>;
  setOfflineSource: Dispatch<SetStateAction<{ trackId: string; url: string | null; } | null>>;
  setPlayPending: (pending: boolean, bookId?: string | null) => void;
  startPlaybackRef: RefObject<(audio: HTMLAudioElement | null | undefined, interruptRestore?: boolean) => void>;
  streamUrl: string;
  wantsAutoplayRef: RefObject<boolean>;
}) {
  useEffect(() => {
    let active = true;
    let resolvedUrl: string | null = null;
    setOfflineSource((source) => source?.trackId === currentTrack?.id ? source : null);
    if (Capacitor.isNativePlatform() && playbackBook && currentTrack) {
      const trackId = currentTrack.id;
      void getOfflineTrackUrl(playbackBook, currentTrack)
        .catch(() => null)
        .then((url) => {
          resolvedUrl = url;
          if (active) setOfflineSource({ trackId, url });
          else releaseOfflineMediaUrl(url);
        });
    }
    return () => {
      active = false;
      releaseOfflineMediaUrl(resolvedUrl);
    };
    // Keyed on ids: resetting offlineSource on identity churn blanked the
    // <audio> src mid-playback (native), stopping the book seconds after play.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackKey, playbackBookKey, playbackBookDownloaded]);

  useEffect(() => {
    let active = true;
    if (nativeQueueRefreshShouldResume(
      nativeAudio,
      nativePlaybackPlayingRef.current,
      requiredNativeAudioQueueKey,
      nativeAudioQueueReadyKey
    ) && playbackBook) {
      playWhenTrackLoads.current = true;
      wantsAutoplayRef.current = true;
      setPlayPending(true, playbackBook.id);
    }
    nativeAudioQueueRef.current = [];
    setNativeAudioQueueReadyKey(null);
    if (!nativeAudio || !playbackBook || !currentTrack) {
      return;
    }
    const queueKey = requiredNativeAudioQueueKey;
    if (!queueKey) return;
    const tracks = playbackBook.tracks.slice(activeTrackIndex);
    const entry = (track: Track, queueIndex: number, sourceUrl: string): NativeAudioQueueTrack => {
      const trackOffset = trackOffsetSeconds(playbackBook, activeTrackIndex + queueIndex);
      return {
        url: sourceUrl,
        trackId: track.id,
        bookOffsetSeconds: trackOffset,
        title: track.title,
        artist: playbackBook.author ?? "Audiobook",
        album: playbackBook.title,
        chapters: chapterSegments
          .filter((chapter) => chapter.trackId === track.id)
          .map((chapter) => ({
            title: chapter.title,
            startSeconds: chapter.startSeconds - trackOffset,
            durationSeconds: chapter.durationSeconds
          }))
      };
    };
    const publish = (queue: NativeAudioQueueTrack[]) => {
      if (!active) return;
      nativeAudioQueueRef.current = queue;
      setNativeAudioQueueReadyKey(queueKey);
    };
    // Resolve each item from disk regardless of whether the separate complete
    // download scan has finished. Otherwise chapter one can be local while
    // later AVQueuePlayer items still point at a dead server on a cold launch.
    void resolveLocalFirstSources(
      tracks,
      (track) => getOfflineTrackUrl(playbackBook, track),
      (track) => mediaUrl(track.streamUrl)
    ).then((sources) => {
      // A fully local queue is usable before background authentication. Any
      // remote fallback must wait for its media credential, or AVPlayer can
      // fail permanently on the tokenless URL before the refreshed queue lands.
      if (!canPublishNativeQueue(sources, mediaCredentialReady)) return;
      publish(tracks.map((track, index) => entry(track, index, sources[index].url)));
    });
    return () => {
      active = false;
    };
    // Stable ids intentionally keep queue construction off progress-object
    // churn while still rebuilding it for a real track transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTrackIndex,
    currentTrackKey,
    nativeAudio,
    playbackBookKey,
    playbackBookDownloaded,
    requiredNativeAudioQueueKey
  ]);

  // Autoplay requested while the audio source was still resolving (native disk
  // lookup): start playback as soon as the source lands.
  useEffect(() => {
    if (!streamUrl || !nativeAudioQueueReady || !wantsAutoplayRef.current) {
      return;
    }
    wantsAutoplayRef.current = false;
    window.setTimeout(() => startPlaybackRef.current(audioRef.current), 0);
  }, [audioRef, nativeAudioQueueReady, startPlaybackRef, streamUrl, wantsAutoplayRef]);

  return {
    
  };
}
