import assert from "node:assert/strict";
import test from "node:test";
import { WORDS, cellsAreAdjacent, findMatches, hasLegalMove, makeMatchBoard, randomWord, scoreWord, swapCells } from "../src/games.ts";

test("scores duplicate letters without over-counting", () => {
  assert.deepEqual(scoreWord("books", "prose"), ["absent", "absent", "correct", "absent", "present"]);
  assert.deepEqual(scoreWord("tales", "audio"), ["absent", "present", "absent", "absent", "absent"]);
});

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

test("random word never repeats the excluded word", () => {
  for (let round = 0; round < 50; round += 1) {
    const word = randomWord("audio");
    assert.notEqual(word, "audio");
    assert.ok((WORDS as readonly string[]).includes(word));
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
