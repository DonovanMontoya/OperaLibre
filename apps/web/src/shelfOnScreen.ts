export type ShelfBox = { top: number; bottom: number };

/**
 * The rows of one shelf leaf that fall within the viewport. A leaf runs down
 * the page in reading order, a grid line at a time, so the first row on
 * screen is found by halving and the walk stops at the first row below it.
 * A large library then costs a handful of measurements more than a small one.
 */
export function rowsOnScreen<T>(rows: ArrayLike<T>, box: (row: T) => ShelfBox, viewport: number): T[] {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (box(rows[middle]).top < 0) low = middle + 1;
    else high = middle;
  }
  // Rows that start above the top of the screen may still reach into it.
  let first = low;
  while (first > 0 && box(rows[first - 1]).bottom > 0) first -= 1;
  const onScreen: T[] = [];
  for (let index = first; index < rows.length; index += 1) {
    const { top, bottom } = box(rows[index]);
    if (top >= viewport) break;
    if (bottom > 0) onScreen.push(rows[index]);
  }
  return onScreen;
}
