import assert from "node:assert/strict";
import test from "node:test";
import {
  SHELF_CAPACITY,
  SLIDE_SIZES,
  cellsAreAdjacent,
  dealShelves,
  findMatches,
  hasLegalMove,
  makeMatchBoard,
  moveShelfBooks,
  shelfHasMove,
  shelfMoveCount,
  shelfSolution,
  shelvedCount,
  shelvesSolvable,
  shelvesSorted,
  shuffleSlide,
  slideFromArrow,
  slideSolvable,
  slideSolved,
  slideTiles,
  swapCells
} from "../src/games.ts";

test("dead boards are detected and never dealt", () => {
  // Period-2 rows cycling three disjoint kind pairs: no run exists and no
  // single swap can line up three of a kind.
  const pairs = [[0, 1], [2, 3], [4, 5]];
  const stuck = Array.from({ length: 7 }, (_, row) =>
    Array.from({ length: 7 }, (_, col) => pairs[row % 3][col % 2]));
  assert.equal(findMatches(stuck).size, 0);
  assert.equal(hasLegalMove(stuck), false);
  for (let round = 0; round < 25; round += 1) {
    assert.equal(hasLegalMove(makeMatchBoard()), true);
  }
});

test("finds horizontal and vertical runs", () => {
  const board = [
    [1, 1, 1, 2],
    [0, 2, 3, 2],
    [1, 3, 0, 2],
    [2, 0, 1, 3]
  ];
  assert.deepEqual([...findMatches(board)].sort(), ["0:0", "0:1", "0:2", "0:3", "1:3", "2:3"].sort());
});

test("only neighboring cells are valid swaps", () => {
  assert.equal(cellsAreAdjacent({ row: 1, col: 1 }, { row: 1, col: 2 }), true);
  assert.equal(cellsAreAdjacent({ row: 1, col: 1 }, { row: 2, col: 2 }), false);
  assert.deepEqual(swapCells([[0, 1], [2, 3]], { row: 0, col: 0 }, { row: 0, col: 1 }), [[1, 0], [2, 3]]);
});

test("a shelf move carries the whole top run, as far as there is room", () => {
  const stacks = [[0, 1, 1, 1], [2, 1], [3], []];
  assert.equal(shelfMoveCount(stacks, 0, 1), 2);
  assert.deepEqual(moveShelfBooks(stacks, 0, 1), [[0, 1], [2, 1, 1, 1], [3], []]);
  assert.equal(shelfMoveCount(stacks, 0, 3), 3);
  assert.equal(shelfMoveCount(stacks, 0, 2), 0, "a different colour on top refuses the books");
  assert.equal(shelfMoveCount(stacks, 3, 0), 0, "an empty stack has nothing to move");
  assert.equal(shelfMoveCount([[1], [1, 1, 1, 1]], 0, 1), 0, "a full stack takes nothing");
  assert.deepEqual(moveShelfBooks(stacks, 0, 2), stacks);
});

test("every dealt shelf is unsorted, complete and solvable", () => {
  for (const colors of [4, 5, 7]) {
    for (let round = 0; round < 6; round += 1) {
      const stacks = dealShelves(colors);
      assert.equal(stacks.length, colors + 2);
      assert.equal(shelvesSorted(stacks), false);
      assert.ok(shelvesSolvable(stacks));
      const counts = Array(colors).fill(0);
      stacks.flat().forEach((book) => { counts[book] += 1; });
      assert.deepEqual(counts, Array(colors).fill(SHELF_CAPACITY));
    }
  }
  assert.equal(shelvesSorted([[2, 2, 2, 2], [], [0, 0, 0, 0]]), true);
  assert.equal(shelvesSolvable([[0, 1, 0, 1], [1, 0, 1, 0]]), false, "with no free stack nothing can move");
});

test("a shelf solution is a run of legal moves that sorts the shelf", () => {
  for (const colors of [4, 7]) {
    let stacks = dealShelves(colors);
    const moves = shelfSolution(stacks);
    assert.ok(Array.isArray(moves) && moves.length > 0, "a dealt shelf has a solution");
    for (const move of moves) {
      assert.ok(shelfMoveCount(stacks, move.from, move.to) > 0, "every step is a legal move");
      stacks = moveShelfBooks(stacks, move.from, move.to);
    }
    assert.ok(shelvesSorted(stacks), `${colors} colours sorted by the solution`);
  }
  assert.deepEqual(shelfSolution([[0, 0, 0, 0], []]), [], "a sorted shelf needs no moves");
});

test("a shelf with no way forward is called stuck, not just hard", () => {
  const boxedIn = [[0, 1, 0, 1], [1, 0, 1, 0]];
  assert.equal(shelfHasMove(boxedIn), false);
  assert.equal(shelfSolution(boxedIn), "stuck");
  // Moves exist here, but every line of play ends boxed in.
  const dead = [[1, 0, 0, 0], [1, 2, 2, 1], [2, 0, 2], [1]];
  assert.equal(shelfHasMove(dead), true);
  assert.equal(shelfSolution(dead), "stuck");
  assert.equal(shelfSolution(dealShelves(7), 5), null, "a search out of budget proves nothing");
  assert.equal(shelvedCount([[0, 0, 0, 0], [1, 1, 1], [1], []]), 1);
});

// Every arrangement reachable from the solved board, by breadth-first search.
function reachable(size: number): Set<string> {
  const start = Array.from({ length: size * size }, (_, index) => index);
  const seen = new Set([start.join(",")]);
  const queue = [start];
  while (queue.length) {
    const tiles = queue.pop()!;
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      const from = slideFromArrow(tiles, size, key);
      const next = from === null ? null : slideTiles(tiles, size, from);
      if (next && !seen.has(next.join(","))) {
        seen.add(next.join(","));
        queue.push(next);
      }
    }
  }
  return seen;
}

test("a tapped piece slides the whole line toward the gap", () => {
  // 0 1 2 / 3 4 5 / 6 7 _ : the gap is piece 8.
  const solved = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(slideTiles(solved, 3, 6), [0, 1, 2, 3, 4, 5, 8, 6, 7], "two pieces move right together");
  assert.deepEqual(slideTiles(solved, 3, 2), [0, 1, 8, 3, 4, 2, 6, 7, 5], "two pieces move down together");
  assert.equal(slideTiles(solved, 3, 4), null, "off the gap's row and column nothing moves");
  assert.equal(slideTiles(solved, 3, 8), null, "the gap itself does not move");
  assert.equal(slideFromArrow(solved, 3, "ArrowRight"), 7, "right moves the piece left of the gap");
  assert.equal(slideFromArrow(solved, 3, "ArrowUp"), null, "nothing sits below the gap");
});

test("the solvability check agrees with every board a player can reach", () => {
  for (const size of [2, 3]) {
    const reach = reachable(size);
    let seed = 11;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let round = 0; round < 300; round += 1) {
      const tiles = Array.from({ length: size * size }, (_, index) => index);
      for (let index = tiles.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [tiles[index], tiles[swap]] = [tiles[swap], tiles[index]];
      }
      assert.equal(slideSolvable(tiles, size), reach.has(tiles.join(",")), tiles.join(","));
    }
  }
});

test("every shuffle is solvable, unsolved and well mixed", () => {
  for (const size of SLIDE_SIZES) {
    for (let round = 0; round < 20; round += 1) {
      const tiles = shuffleSlide(size);
      assert.deepEqual([...tiles].sort((left, right) => left - right), Array.from({ length: size * size }, (_, index) => index));
      assert.ok(slideSolvable(tiles, size));
      assert.equal(slideSolved(tiles), false);
    }
  }
  const reach = reachable(3);
  for (let round = 0; round < 20; round += 1) assert.ok(reach.has(shuffleSlide(3).join(",")));
});
