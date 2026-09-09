import type { AuthUser, Book, BookProgress, LoginResponse, Progress } from "./types";

export type ProgressWrite = Pick<Progress, "trackId" | "positionSeconds" | "bookPositionSeconds" | "durationSeconds">
  & Partial<Pick<Progress, "updatedAt">>;
export type ProgressWriteOptions = {
  isPaused?: boolean;
  intentionalRegression?: boolean;
  intentionalSeek?: boolean;
  signal?: AbortSignal;
};

/** The client contract. Server protocols and credential formats stay in adapters. */
export interface ServerBackend {
  login(username: string, password: string): Promise<LoginResponse>;
  logout(): Promise<unknown>;
  user(): Promise<AuthUser>;
  books(): Promise<Book[]>;
  progress(bookId: string, timeoutMs?: number): Promise<Progress | null>;
  freshProgress(book: Book, timeoutMs?: number): Promise<Progress | null>;
  saveProgress(bookId: string, progress: ProgressWrite, options?: ProgressWriteOptions): Promise<Progress>;
  completion(book: Book, finished: boolean, progress?: ProgressWrite): Promise<BookProgress>;
  mediaPath(path: string): string;
}
