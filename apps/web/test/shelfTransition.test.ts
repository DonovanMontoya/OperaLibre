import assert from "node:assert/strict";
import test from "node:test";
import { runShelfLayoutTransition } from "../src/shelfTransition.ts";

type Finish = () => void;

function fakeRoot(options: { viewTransitions?: boolean; reducedMotion?: boolean; spreadOnScreen?: boolean } = {}) {
  const { viewTransitions = true, reducedMotion = false, spreadOnScreen = true } = options;
  const finishers: Finish[] = [];
  const root = {
    dataset: {} as Record<string, string>,
    classList: { contains: (name: string) => name === "platform-ios" },
    ownerDocument: {
      defaultView: { matchMedia: () => ({ matches: reducedMotion }) },
      querySelector: () => (spreadOnScreen ? {} : null),
      startViewTransition: viewTransitions
        ? (update: () => void) => {
            update();
            return { finished: new Promise<void>((resolve) => finishers.push(resolve)) };
          }
        : undefined
    }
  };
  return { root: root as unknown as HTMLElement, dataset: root.dataset, finishers };
}

test("names the direction for the stylesheet until the transition finishes", async () => {
  const { root, dataset, finishers } = fakeRoot();
  let applied = false;
  runShelfLayoutTransition(root, "split", "library", () => {
    applied = true;
  });
  assert.equal(applied, true);
  assert.equal(dataset.shelfTransition, "split-library");
  finishers[0]();
  await Promise.resolve();
  assert.equal(dataset.shelfTransition, undefined);
});

test("a change made mid-flight keeps its own direction when the first one ends", async () => {
  const { root, dataset, finishers } = fakeRoot();
  runShelfLayoutTransition(root, "split", "library", () => {});
  runShelfLayoutTransition(root, "library", "split", () => {});
  finishers[0]();
  await Promise.resolve();
  assert.equal(dataset.shelfTransition, "library-split");
  finishers[1]();
  await Promise.resolve();
  assert.equal(dataset.shelfTransition, undefined);
});

for (const [name, options] of [
  ["reduced motion is on", { reducedMotion: true }],
  ["view transitions are unavailable", { viewTransitions: false }],
  ["the spread is not on screen", { spreadOnScreen: false }]
] as const) {
  test(`applies the change without motion when ${name}`, () => {
    const { root, dataset } = fakeRoot(options);
    let applied = false;
    runShelfLayoutTransition(root, "library", "split", () => {
      applied = true;
    });
    assert.equal(applied, true);
    assert.equal(dataset.shelfTransition, undefined);
  });
}
