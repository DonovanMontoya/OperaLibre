import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
      try { return await nextResolve(specifier + ".ts", context); } catch {}
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const { shelfLetterIndex, titleInitial } = await import("../src/shelfLabels.ts");

test("a title files under its first letter, without accents or case", () => {
  assert.equal(titleInitial("the Atlas Paradox"), "T");
  assert.equal(titleInitial("  Émile"), "E");
  assert.equal(titleInitial("Über uns"), "U");
});

test("a title that opens with a digit or symbol files under #", () => {
  assert.equal(titleInitial("1984"), "#");
  assert.equal(titleInitial("'Salem's Lot"), "#");
  assert.equal(titleInitial(""), "#");
});

test("the letter index is the whole alphabet, with symbols before it and other scripts after", () => {
  const index = shelfLetterIndex(["#", "A", "D", "Ж", "Я"], false);
  assert.deepEqual(index.slice(0, 5), ["#", "A", "B", "C", "D"]);
  assert.deepEqual(index.slice(-4), ["Y", "Z", "Ж", "Я"]);
  assert.equal(index.length, 29);
});

test("a reversed shelf reads its index in the order its books run", () => {
  const index = shelfLetterIndex(["Я", "Ж", "T", "B", "#"], true);
  assert.deepEqual(index.slice(0, 3), ["Я", "Ж", "Z"]);
  assert.deepEqual(index.slice(-2), ["A", "#"]);
  assert.equal(index.length, 29);
});
