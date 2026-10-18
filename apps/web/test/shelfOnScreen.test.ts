import assert from "node:assert/strict";
import test from "node:test";
import { rowsOnScreen, type ShelfBox } from "../src/shelfOnScreen.ts";

function measured(boxes: ShelfBox[]) {
  let reads = 0;
  const box = (index: number) => {
    reads += 1;
    return boxes[index];
  };
  return { rows: boxes.map((_, index) => index), box, reads: () => reads };
}

test("a long shelf measures only the rows near the screen", () => {
  // 10,000 rows of 50px, scrolled so rows 4,000–4,016 are on an 800px screen.
  const scroll = 4000 * 50 + 20;
  const shelf = measured(Array.from({ length: 10_000 }, (_, index) => ({ top: index * 50 - scroll, bottom: index * 50 + 50 - scroll })));
  assert.deepEqual(rowsOnScreen(shelf.rows, shelf.box, 800), Array.from({ length: 17 }, (_, index) => 4000 + index));
  assert.ok(shelf.reads() < 40, `measured ${shelf.reads()} rows`);
});

test("a grid line cut by the top of the screen is kept whole", () => {
  // Four tiles a line, 150px tall, with the second line straddling the top.
  const boxes = Array.from({ length: 40 }, (_, index) => {
    const top = Math.floor(index / 4) * 170 - 250;
    return { top, bottom: top + 150 };
  });
  const shelf = measured(boxes);
  assert.deepEqual(rowsOnScreen(shelf.rows, shelf.box, 400), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test("shelves at either end or off screen", () => {
  const rows = (offset: number) => Array.from({ length: 5 }, (_, index) => ({ top: index * 100 + offset, bottom: index * 100 + 100 + offset }));
  const at = (offset: number) => {
    const shelf = measured(rows(offset));
    return rowsOnScreen(shelf.rows, shelf.box, 250);
  };
  assert.deepEqual(at(0), [0, 1, 2]);
  assert.deepEqual(at(-380), [3, 4]);
  assert.deepEqual(at(-500), []);
  assert.deepEqual(at(250), []);
  assert.deepEqual(rowsOnScreen([], () => ({ top: 0, bottom: 0 }), 250), []);
});
