export type LetterResult = "correct" | "present" | "absent";

export const WORD_LENGTH = 5;
export const WORD_ATTEMPTS = 6;

export const WORDS = [
  "audio", "books", "chime", "drama", "dream", "fable", "focus", "genre",
  "index", "novel", "opera", "pages", "paper", "pause", "plots", "prose",
  "quiet", "quill", "scene", "shelf", "sound", "spine", "story", "tales",
  "title", "track", "verse", "vocal", "voice", "words"
] as const;

export function dailyWord(date = new Date()): string {
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
  return WORDS[day % WORDS.length];
}

export function randomWord(exclude?: string): string {
  const pool = WORDS.filter((word) => word !== exclude);
  return pool[Math.floor(Math.random() * pool.length)];
}

export function scoreWord(guess: string, answer: string): LetterResult[] {
  const result: LetterResult[] = Array.from({ length: WORD_LENGTH }, () => "absent");
  const remaining = new Map<string, number>();

  for (let index = 0; index < WORD_LENGTH; index += 1) {
    if (guess[index] === answer[index]) {
      result[index] = "correct";
    } else {
      remaining.set(answer[index], (remaining.get(answer[index]) ?? 0) + 1);
    }
  }

  for (let index = 0; index < WORD_LENGTH; index += 1) {
    const letter = guess[index];
    const count = remaining.get(letter) ?? 0;
    if (result[index] !== "correct" && count > 0) {
      result[index] = "present";
      remaining.set(letter, count - 1);
    }
  }

  return result;
}

export const MATCH_SIZE = 7;
export const MATCH_GLYPHS = ["◆", "●", "✦", "■", "▲", "♥"] as const;
export const MATCH_KINDS = MATCH_GLYPHS.length;
export type MatchBoard = number[][];
export type MatchCell = { row: number; col: number };

export function cellsAreAdjacent(left: MatchCell, right: MatchCell): boolean {
  return Math.abs(left.row - right.row) + Math.abs(left.col - right.col) === 1;
}

export function findMatches(board: MatchBoard): Set<string> {
  const matches = new Set<string>();
  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board[row].length; col += 1) {
      const kind = board[row][col];
      if (col <= board[row].length - 3 && kind === board[row][col + 1] && kind === board[row][col + 2]) {
        let cursor = col;
        while (cursor < board[row].length && board[row][cursor] === kind) matches.add(`${row}:${cursor++}`);
      }
      if (row <= board.length - 3 && kind === board[row + 1][col] && kind === board[row + 2][col]) {
        let cursor = row;
        while (cursor < board.length && board[cursor][col] === kind) matches.add(`${cursor++}:${col}`);
      }
    }
  }
  return matches;
}

export function hasLegalMove(board: MatchBoard): boolean {
  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board[row].length; col += 1) {
      for (const [rowStep, colStep] of [[0, 1], [1, 0]] as const) {
        const target = { row: row + rowStep, col: col + colStep };
        if (target.row >= board.length || target.col >= board[row].length) continue;
        if (findMatches(swapCells(board, { row, col }, target)).size) return true;
      }
    }
  }
  return false;
}

export function makeMatchBoard(random = Math.random): MatchBoard {
  // A moveless deal is astronomically rare at 7×7 with six kinds, but an
  // "endless" game must never open dead; the bound keeps a pathological
  // random source from spinning forever.
  let board: MatchBoard = [];
  for (let attempt = 0; attempt < 24; attempt += 1) {
    board = [];
    for (let row = 0; row < MATCH_SIZE; row += 1) {
      const line: number[] = [];
      for (let col = 0; col < MATCH_SIZE; col += 1) {
        let kind = Math.floor(random() * MATCH_KINDS);
        while (
          (col >= 2 && line[col - 1] === kind && line[col - 2] === kind)
          || (row >= 2 && board[row - 1][col] === kind && board[row - 2][col] === kind)
        ) kind = (kind + 1) % MATCH_KINDS;
        line.push(kind);
      }
      board.push(line);
    }
    if (hasLegalMove(board)) return board;
  }
  return board;
}

export function swapCells(board: MatchBoard, left: MatchCell, right: MatchCell): MatchBoard {
  const next = board.map((row) => [...row]);
  [next[left.row][left.col], next[right.row][right.col]] = [next[right.row][right.col], next[left.row][left.col]];
  return next;
}

export function collapseMatches(board: MatchBoard, matches: Set<string>, random = Math.random): MatchBoard {
  return board[0].map((_, col) => {
    const kept = board.map((row) => row[col]).filter((_, row) => !matches.has(`${row}:${col}`));
    const replacements = Array.from({ length: board.length - kept.length }, () => Math.floor(random() * MATCH_KINDS));
    return [...replacements, ...kept];
  }).map((_, row, columns) => columns.map((column) => column[row]));
}
