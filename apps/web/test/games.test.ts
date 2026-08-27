import assert from "node:assert/strict";
import test from "node:test";
import { WORDS, cellsAreAdjacent, findMatches, randomWord, scoreWord, swapCells } from "../src/games.ts";

test("scores duplicate letters without over-counting", () => {
  assert.deepEqual(scoreWord("books", "prose"), ["absent", "absent", "correct", "absent", "present"]);
  assert.deepEqual(scoreWord("tales", "audio"), ["absent", "present", "absent", "absent", "absent"]);
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
