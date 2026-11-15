import type { Book } from '../../src/types';

// Synthetic API data, not a second implementation of server decisions.
export function library(count: number): Book[] {
  const metadata = { album: null, subtitle: null, publisher: null, publishedDate: null,
    description: null, language: null, series: null, seriesPosition: null, genres: [], rawFields: [] };
  return Array.from({ length: count }, (_, index) => ({
    id: `book-${index}`, title: `Fixture Book ${String(index).padStart(4, '0')}`,
    author: `Author ${index % 10}`, narrator: 'Fixture narrator', durationSeconds: 240,
    trackCount: 2, coverArtUrl: null, coverArtContentType: null, description: 'Performance fixture',
    genres: [index % 2 ? 'Mystery' : 'Fantasy'], tags: [{ name: `Series ${index % 20}`, position: String(index) }],
    publishedDate: null, asin: null, readingFile: null, syncFile: null, chapters: [], metadata,
    tracks: [0, 1].map(track => ({ id: `track-${index}-${track}`, title: `Track ${track + 1}`,
      fileName: `${track}.wav`, index: track, durationSeconds: 120, streamUrl: '/fixture.wav', chapters: [], metadata })),
    progress: null, source: 'server', volumeGain: 1, addedAt: '1700000000',
  }));
}

export function wav(seconds = 120): Buffer {
  const bytes = seconds * 8000 * 2;
  const data = Buffer.alloc(44 + bytes);
  data.write('RIFF'); data.writeUInt32LE(36 + bytes, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(bytes, 40);
  return data;
}

type WavFulfillment = {
  status: number;
  contentType: 'audio/wav';
  body: Buffer;
  headers: Record<string, string>;
};

// WebKit follows the first WAV fetch with `Range: bytes=44-` and treats a 200
// for that request as a media error, so playback never leaves 0:00.
export function rangedWav(audio: Buffer, rangeHeader?: string): WavFulfillment {
  const contentType = 'audio/wav' as const;
  if (!rangeHeader) {
    return {
      status: 200, contentType, body: audio,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(audio.length) },
    };
  }
  const range = satisfiableByteRange(rangeHeader, audio.length);
  if (!range) {
    return {
      status: 416, contentType, body: Buffer.alloc(0),
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${audio.length}`,
        'Content-Length': '0',
      },
    };
  }
  const body = audio.subarray(range.start, range.end + 1);
  return {
    status: 206, contentType, body,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${range.start}-${range.end}/${audio.length}`,
      'Content-Length': String(body.length),
    },
  };
}

function satisfiableByteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || size <= 0) return null;
  const [, startText, endText] = match;
  if (startText === '' && endText === '') return null;
  if (startText === '') {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start >= size) return null;
  const end = endText === '' ? size - 1 : Number(endText);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}
