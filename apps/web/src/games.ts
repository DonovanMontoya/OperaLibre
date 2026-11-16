export const MATCH_SIZE = 7;
export const MATCH_GLYPHS = ["◆", "●", "✦", "■", "▲", "♥"] as const;
export const MATCH_GLYPH_NAMES = ["Diamond", "Circle", "Star", "Square", "Triangle", "Heart"] as const;
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

/** A Fisher–Yates shuffle into a new array. */
export function shuffled<T>(items: readonly T[], random = Math.random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

// --- Shelf Sort -------------------------------------------------------------
// Stacks of books in mixed colours; moving the top run of one stack onto an
// empty stack or a matching top sorts every stack down to a single colour.

export const SHELF_CAPACITY = 4;
export const SHELF_MAX_COLORS = 7;
export type ShelfStacks = number[][];

export function shelfColorsForLevel(level: number): number {
  return Math.min(SHELF_MAX_COLORS, 4 + Math.floor((Math.max(1, level) - 1) / 2));
}

/** How many books the top run of `from` would move onto `to`; 0 when it can't. */
export function shelfMoveCount(stacks: ShelfStacks, from: number, to: number): number {
  const source = stacks[from];
  const target = stacks[to];
  if (from === to || !source?.length || !target || target.length >= SHELF_CAPACITY) return 0;
  if (target.length && target[target.length - 1] !== source[source.length - 1]) return 0;
  return Math.min(shelfTopRun(source), SHELF_CAPACITY - target.length);
}

/** How many books of the top book's colour sit together at the top. */
export function shelfTopRun(stack: number[]): number {
  let run = 0;
  while (run < stack.length && stack[stack.length - 1 - run] === stack[stack.length - 1]) run += 1;
  return run;
}

export function moveShelfBooks(stacks: ShelfStacks, from: number, to: number): ShelfStacks {
  const count = shelfMoveCount(stacks, from, to);
  if (!count) return stacks;
  const next = stacks.map((stack) => [...stack]);
  next[to].push(...next[from].splice(next[from].length - count, count));
  return next;
}

export function shelvesSorted(stacks: ShelfStacks): boolean {
  return stacks.every((stack) => !stack.length || shelfFinished(stack));
}

function shelfKey(stacks: ShelfStacks): string {
  return stacks.map((stack) => stack.join("")).sort().join("|");
}

export function shelfFinished(stack: number[]): boolean {
  return stack.length === SHELF_CAPACITY && stack.every((book) => book === stack[0]);
}

/** How many stacks hold one full colour. */
export function shelvedCount(stacks: ShelfStacks): number {
  return stacks.filter(shelfFinished).length;
}

/** Whether any books can move at all. */
export function shelfHasMove(stacks: ShelfStacks): boolean {
  return stacks.some((_, from) => stacks.some((_, to) => shelfMoveCount(stacks, from, to) > 0));
}

export type ShelfMove = { from: number; to: number };

/**
 * Depth-first search for a way to finish, bounded so it stays quick on a
 * phone. Gives the moves of the line it found, "stuck" when every line of
 * play was tried and none finishes, or null when the budget ran out first,
 * which proves nothing either way. A sorted shelf gives no moves.
 */
export function shelfSolution(stacks: ShelfStacks, budget = 40_000): ShelfMove[] | "stuck" | null {
  type Step = { stacks: ShelfStacks; move: ShelfMove | null; parent: Step | null };
  const seen = new Set<string>();
  const pending: Step[] = [{ stacks, move: null, parent: null }];
  while (pending.length) {
    const step = pending.pop()!;
    const current = step.stacks;
    if (shelvesSorted(current)) {
      const moves: ShelfMove[] = [];
      for (let at: Step | null = step; at?.move; at = at.parent) moves.unshift(at.move);
      return moves;
    }
    const key = shelfKey(current);
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > budget) return null;
    const ontoBooks: ShelfMove[] = [];
    const ontoEmpty: ShelfMove[] = [];
    for (let from = 0; from < current.length; from += 1) {
      const source = current[from];
      // A finished stack never needs to move, and a uniform stack gains
      // nothing by moving whole into an empty one.
      if (!source.length || shelfFinished(source)) continue;
      const uniform = source.every((book) => book === source[0]);
      for (let to = 0; to < current.length; to += 1) {
        if (!shelfMoveCount(current, from, to)) continue;
        if (!current[to].length) {
          if (!uniform) ontoEmpty.push({ from, to });
        } else ontoBooks.push({ from, to });
      }
    }
    // Last pushed is tried first: matching a colour before spending a free
    // stack, so the line found reads like sensible play.
    for (const move of [...ontoEmpty, ...ontoBooks]) {
      pending.push({ stacks: moveShelfBooks(current, move.from, move.to), move, parent: step });
    }
  }
  return "stuck";
}

/** Whether the shelf can still be sorted, as far as a bounded search can tell. */
export function shelvesSolvable(stacks: ShelfStacks, budget = 40_000): boolean {
  return Array.isArray(shelfSolution(stacks, budget));
}

export function dealShelves(colors: number, random = Math.random): ShelfStacks {
  let stacks: ShelfStacks = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const books = shuffled(Array.from({ length: colors * SHELF_CAPACITY }, (_, index) => index % colors), random);
    stacks = [
      ...Array.from({ length: colors }, (_, index) => books.slice(index * SHELF_CAPACITY, (index + 1) * SHELF_CAPACITY)),
      [], []
    ];
    if (!shelvesSorted(stacks) && shelvesSolvable(stacks)) return stacks;
  }
  return stacks;
}

// --- Cover Grid -------------------------------------------------------------
// A sliding puzzle cut from a library cover. `tiles[position]` is the piece
// sitting there; pieces are numbered by their home position, and the
// highest number is the gap.

export const SLIDE_SIZES = [3, 4, 5] as const;
export type SlideSize = (typeof SLIDE_SIZES)[number];

export function slideSolved(tiles: number[]): boolean {
  return tiles.every((piece, position) => piece === position);
}

/**
 * Slides the tapped piece toward the gap, carrying every piece between them,
 * when it shares the gap's row or column. Null when it does not.
 */
export function slideTiles(tiles: number[], size: number, position: number): number[] | null {
  const gap = tiles.indexOf(size * size - 1);
  if (position === gap || position < 0 || position >= tiles.length) return null;
  const sameRow = Math.floor(position / size) === Math.floor(gap / size);
  const sameCol = position % size === gap % size;
  if (!sameRow && !sameCol) return null;
  const step = sameRow ? Math.sign(position - gap) : Math.sign(position - gap) * size;
  const next = [...tiles];
  for (let at = gap; at !== position; at += step) next[at] = next[at + step];
  next[position] = size * size - 1;
  return next;
}

/** The piece an arrow key moves: the neighbour that would slide into the gap. */
export function slideFromArrow(tiles: number[], size: number, key: string): number | null {
  const gap = tiles.indexOf(size * size - 1);
  const row = Math.floor(gap / size);
  const col = gap % size;
  // An arrow names the way the piece travels, so it comes from the other side.
  const from = { ArrowUp: [row + 1, col], ArrowDown: [row - 1, col], ArrowLeft: [row, col + 1], ArrowRight: [row, col - 1] }[key];
  if (!from || from[0] < 0 || from[0] >= size || from[1] < 0 || from[1] >= size) return null;
  return from[0] * size + from[1];
}

/**
 * Whether the pieces can be slid home. With the gap's row counted from the
 * bottom, a legal slide always keeps this parity, and the solved board has it.
 */
export function slideSolvable(tiles: number[], size: number): boolean {
  const gap = size * size - 1;
  const pieces = tiles.filter((piece) => piece !== gap);
  let inversions = 0;
  for (let left = 0; left < pieces.length; left += 1) {
    for (let right = left + 1; right < pieces.length; right += 1) if (pieces[left] > pieces[right]) inversions += 1;
  }
  if (size % 2) return inversions % 2 === 0;
  const rowFromBottom = size - Math.floor(tiles.indexOf(gap) / size);
  return (inversions + rowFromBottom) % 2 === 1;
}

/** A solvable shuffle with the gap in the corner and at most a third of the pieces home. */
export function shuffleSlide(size: number, random = Math.random): number[] {
  const count = size * size - 1;
  for (;;) {
    const tiles = [...shuffled(Array.from({ length: count }, (_, index) => index), random), count];
    // One swap of two pieces flips the parity, turning a dead board live.
    if (!slideSolvable(tiles, size)) [tiles[0], tiles[1]] = [tiles[1], tiles[0]];
    const home = tiles.filter((piece, position) => piece === position).length;
    if (home <= Math.floor(count / 3) + 1 && !slideSolved(tiles)) return tiles;
  }
}
