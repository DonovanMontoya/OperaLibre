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
    progress: null, source: 'server', volumeGain: 1,
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
