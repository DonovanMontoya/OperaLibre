import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { mediaUrl } from "./api";
import { getOfflineCoverUrl } from "./offline";
import { trackOffsetSeconds } from "./formatting";
import { updateNativeAudioNowPlaying } from "./nativeAudio";
import type { Book, Track } from "./types";
import type { ChapterSegment } from "./chapters";


/**
 * Publishes the playing book, chapter and artwork to the lock screen and
 * Control Center.
 */
export function useNowPlaying({
  activeChapter,
  activeTrackIndex,
  chapterSegments,
  currentTrack,
  currentTrackChapterKey,
  currentTrackKey,
  native,
  nativeAudio,
  playbackBook,
  playbackBookKey,
  setPlaybackError
}: {
  activeChapter: ChapterSegment | null;
  activeTrackIndex: number;
  chapterSegments: ChapterSegment[];
  currentTrack: Track | null;
  currentTrackChapterKey: string;
  currentTrackKey: string | null;
  native: boolean;
  nativeAudio: boolean;
  playbackBook: Book | null;
  playbackBookKey: string | null;
  setPlaybackError: Dispatch<SetStateAction<string | null>>;
}) {
  const [mediaArtworkUrl, setMediaArtworkUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const book = playbackBook;
    if (!book || (!book.coverArtUrl && !book.localCoverPath)) {
      setMediaArtworkUrl(null);
      return;
    }
    const networkArtwork = book.coverArtUrl ? mediaUrl(book.coverArtUrl) : null;
    if (!native) {
      setMediaArtworkUrl(networkArtwork);
      return;
    }
    void getOfflineCoverUrl(book).then((localArtwork) => {
      if (active) setMediaArtworkUrl(localArtwork ?? networkArtwork);
    });
    return () => {
      active = false;
    };
    // Keyed on the fields the artwork comes from; a progress save replaces
    // playbackBook without changing its cover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, playbackBookKey, playbackBook?.coverArtUrl, playbackBook?.localCoverPath]);

  useEffect(() => {
    if (!playbackBook || !currentTrack) {
      return;
    }

    const trackOffset = trackOffsetSeconds(playbackBook, activeTrackIndex);
    const nowPlaying = {
      title: activeChapter?.title ?? currentTrack.title,
      artist: playbackBook.author ?? "Audiobook",
      album: playbackBook.title,
      artworkUrl: mediaArtworkUrl ?? undefined,
      chapterStartSeconds: activeChapter
        ? activeChapter.startSeconds - trackOffset
        : undefined,
      chapterDurationSeconds: activeChapter?.durationSeconds,
      chapters: chapterSegments
        .filter((chapter) => chapter.trackId === currentTrack.id)
        .map((chapter) => ({
          title: chapter.title,
          // AVPlayer's clock is relative to the current audio file, while
          // chapter markers are relative to the whole book.
          startSeconds: chapter.startSeconds - trackOffset,
          durationSeconds: chapter.durationSeconds
        }))
    };
    if (nativeAudio) {
      void updateNativeAudioNowPlaying(nowPlaying).catch((error) => {
        setPlaybackError(error instanceof Error ? error.message : "Could not update iOS Now Playing.");
      });
      return;
    }
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: nowPlaying.title,
      artist: nowPlaying.artist,
      album: nowPlaying.album,
      artwork: mediaArtworkUrl
        ? [
            { src: mediaArtworkUrl, sizes: "512x512", type: playbackBook.coverArtContentType ?? "image/jpeg" }
          ]
        : undefined
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeChapter?.id,
    currentTrackChapterKey,
    currentTrackKey,
    mediaArtworkUrl,
    nativeAudio,
    playbackBookKey
  ]);

  return {
    
  };
}
