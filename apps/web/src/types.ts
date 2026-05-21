export type Track = {
  id: string;
  title: string;
  fileName: string;
  index: number;
  durationSeconds: number | null;
  streamUrl: string;
  chapters: Chapter[];
  metadata: MetadataSummary;
};

export type Book = {
  id: string;
  title: string;
  author: string | null;
  narrator: string | null;
  durationSeconds: number | null;
  trackCount: number;
  coverArtUrl: string | null;
  description: string | null;
  genres: string[];
  publishedDate: string | null;
  chapters: Chapter[];
  metadata: MetadataSummary;
  tracks: Track[];
};

export type Chapter = {
  id: string;
  title: string;
  trackId: string;
  trackIndex: number;
  startSeconds: number;
  endSeconds: number | null;
  source: string;
};

export type MetadataSummary = {
  album: string | null;
  subtitle: string | null;
  publisher: string | null;
  publishedDate: string | null;
  description: string | null;
  language: string | null;
  genres: string[];
  rawFields: MetadataField[];
};

export type MetadataField = {
  key: string;
  value: string;
  description: string | null;
};

export type Progress = {
  bookId: string;
  trackId: string;
  positionSeconds: number;
  bookPositionSeconds: number;
  durationSeconds: number | null;
  updatedAt: string;
};
