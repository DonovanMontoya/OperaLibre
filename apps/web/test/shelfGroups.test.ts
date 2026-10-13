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
const {
  expandShelfGroups,
  isShelfGroupCollapsed,
  readCollapsedShelfGroups,
  SHELF_COLLAPSED_GROUPS_STORAGE_KEY,
  toggleCollapsedShelfGroup,
  writeCollapsedShelfGroups
} = await import("../src/shelfGroups.ts");

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
  writeCollapsedShelfGroups(toggleCollapsedShelfGroup({}, "series", "Harry Potter"), storage);
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

test("expand all reopens every saved group in the current sort after reload", () => {
  const groups = { series: ["Harry Potter", "Discworld", "Filtered-out series"], genre: ["Fantasy"] };
  const storage = memoryStorage();
  writeCollapsedShelfGroups(expandShelfGroups(groups, "series"), storage);
  const restored = readCollapsedShelfGroups(storage);
  for (const label of groups.series) {
    assert.equal(isShelfGroupCollapsed(restored, "series", label), false);
  }
  assert.equal(isShelfGroupCollapsed(restored, "genre", "Fantasy"), true);
  assert.deepEqual(groups.series, ["Harry Potter", "Discworld", "Filtered-out series"]);
  assert.deepEqual(expandShelfGroups(restored, "series"), restored);
  assert.deepEqual(toggleCollapsedShelfGroup(restored, "series", "Discworld"), {
    genre: ["Fantasy"], series: ["Discworld"]
  });
});

test("unreadable saved state opens every group instead of failing", () => {
  for (const saved of ["not json", "[]", "null", JSON.stringify({ series: "Harry Potter", tag: [3, ""] })]) {
    assert.deepEqual(readCollapsedShelfGroups(memoryStorage(saved)), {});
  }
});

test("equivalent numeric and linguistic labels stay folded when the run label changes", () => {
  for (const [first, reversed] of [["Series 1", "Series 01"], ["Straße", "Strasse"], ["Æther", "Aether"]]) {
    const groups = toggleCollapsedShelfGroup({}, "series", first);
    assert.equal(isShelfGroupCollapsed(groups, "series", reversed), true);
    assert.deepEqual(toggleCollapsedShelfGroup(groups, "series", reversed), {});
  }
});

test("blocked browser storage leaves groups usable in memory", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { get localStorage() { throw new DOMException("Blocked", "SecurityError"); } }
  });
  try {
    assert.deepEqual(readCollapsedShelfGroups(), {});
    const groups = toggleCollapsedShelfGroup({}, "series", "Discworld");
    assert.doesNotThrow(() => writeCollapsedShelfGroups(groups));
    assert.equal(isShelfGroupCollapsed(groups, "series", "Discworld"), true);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
