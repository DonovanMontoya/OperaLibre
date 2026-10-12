import assert from "node:assert/strict";
import test from "node:test";
import {
  isShelfGroupCollapsed,
  readCollapsedShelfGroups,
  SHELF_COLLAPSED_GROUPS_STORAGE_KEY,
  toggleCollapsedShelfGroup,
  writeCollapsedShelfGroups
} from "../src/shelfGroups.ts";

function memoryStorage(initialValue: string | null = null) {
  const values = new Map<string, string>();
  if (initialValue !== null) values.set(SHELF_COLLAPSED_GROUPS_STORAGE_KEY, initialValue);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
}

test("a folded series stays folded after the app reopens", () => {
  const storage = memoryStorage();
  writeCollapsedShelfGroups(storage, toggleCollapsedShelfGroup({}, "series", "Harry Potter"));
  const restored = readCollapsedShelfGroups(storage);
  assert.equal(isShelfGroupCollapsed(restored, "series", "Harry Potter"), true);
  assert.equal(isShelfGroupCollapsed(restored, "series", "Discworld"), false);
});

test("folding a group under one sort leaves the same name open under another", () => {
  const groups = toggleCollapsedShelfGroup({}, "series", "Cosmere");
  assert.equal(isShelfGroupCollapsed(groups, "series", "Cosmere"), true);
  assert.equal(isShelfGroupCollapsed(groups, "tag", "Cosmere"), false);
});

test("labels the shelf merges into one heading fold together", () => {
  const groups = toggleCollapsedShelfGroup({}, "series", "Les Misérables ");
  assert.equal(isShelfGroupCollapsed(groups, "series", "les miserables"), true);
});

test("toggling again opens the group and drops the empty sort", () => {
  const folded = toggleCollapsedShelfGroup({ genre: ["fantasy"] }, "series", "Harry Potter");
  const reopened = toggleCollapsedShelfGroup(folded, "series", "Harry Potter");
  assert.deepEqual(reopened, { genre: ["fantasy"] });
});

test("unreadable saved state opens every group instead of failing", () => {
  for (const saved of ["not json", "[]", "null", JSON.stringify({ series: "Harry Potter", tag: [3, ""] })]) {
    assert.deepEqual(readCollapsedShelfGroups(memoryStorage(saved)), {});
  }
});
